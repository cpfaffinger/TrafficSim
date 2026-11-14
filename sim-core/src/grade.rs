//! Road gradients and their effect on longitudinal dynamics (#87, ADR-0018).
//!
//! The grade `γ` (rise over run) of every polyline piece comes from the package geometry `z`
//! (terrain plus schematic grade separation) and is clamped to ±[`MAX_GRADE`]. The model is a
//! power-limited capability cap on top of the IDM:
//!
//! * **Uphill** (`γ > 0`) a vehicle can deliver at most
//!   `a_avail(v) = P/m / max(v, v_min) − g·(c_r + sin θ)`
//!   where `P/m` is its specific power (usable power at the wheels per mass). The IDM acceleration
//!   is capped at `a_avail`; braking is unaffected. Cars have a large power reserve and barely
//!   notice moderate grades; heavy vehicles lose speed until power and gravity balance (crawl
//!   speed `(P/m) / (g·(sin θ + c_r))`). On the flat the calibrated IDM is trusted as is.
//! * **Downhill** (`γ < 0`) positive accelerations are boosted by [`DOWNHILL_SHARE`] of the
//!   gravity component (at most `×(1 + DOWNHILL_SHARE)`); the IDM still holds the desired speed.
//! * **Flat** (`γ = 0`) leaves the acceleration untouched (bit-identical results).

use crate::package::Point;

/// Gravitational acceleration (m/s²).
pub const G: f64 = 9.81;
/// Rolling resistance coefficient `c_r` (tyres on asphalt).
pub const ROLLING_RESISTANCE: f64 = 0.008;
/// Grades are clamped to ±12 %: steeper geometry (schematic bridge ramps on short links, DEM noise)
/// does not make vehicles stall.
pub const MAX_GRADE: f64 = 0.12;
/// Below this speed (m/s) the available traction is no longer power-limited (low gears).
pub const MIN_POWER_SPEED: f64 = 5.0;
/// Share of the downhill gravity component drivers use to accelerate faster.
pub const DOWNHILL_SHARE: f64 = 0.5;

/// Clamped grade (rise over run) of the piece `a → b`; zero for vertical or degenerate pieces.
pub fn piece_grade(a: &Point, b: &Point) -> f64 {
    let run = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    let rise = b[2] - a[2];
    if run < 1e-6 || rise == 0.0 {
        0.0
    } else {
        (rise / run).clamp(-MAX_GRADE, MAX_GRADE)
    }
}

/// `sin θ` of a grade `γ = tan θ`.
pub fn sine(grade: f64) -> f64 {
    grade / (1.0 + grade * grade).sqrt()
}

/// Power-limited acceleration (m/s²) a vehicle can deliver at `speed` on `grade`.
pub fn available_acceleration(specific_power: f64, speed: f64, grade: f64) -> f64 {
    specific_power / speed.max(MIN_POWER_SPEED) - G * (ROLLING_RESISTANCE + sine(grade))
}

/// Applies the grade to an IDM acceleration `acc` (see the module documentation).
pub fn apply(acc: f64, max_acceleration: f64, specific_power: f64, speed: f64, grade: f64) -> f64 {
    if grade > 0.0 {
        acc.min(available_acceleration(specific_power, speed, grade))
    } else if grade < 0.0 && acc > 0.0 {
        let boost = (G * sine(-grade)).min(max_acceleration) / max_acceleration;
        acc * (1.0 + DOWNHILL_SHARE * boost)
    } else {
        acc
    }
}

/// Sustainable speed (m/s) on a constant grade for a power-limited vehicle: where the power-limited
/// acceleration equals the gravity component (ignores the IDM free-road term and air drag).
pub fn crawl_speed(specific_power: f64, grade: f64) -> f64 {
    specific_power / (G * (sine(grade) + ROLLING_RESISTANCE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::idm::MAX_EMERGENCY_DECELERATION;
    use crate::package::Package;
    use crate::sim::Simulation;
    use crate::synth::{corridor, fixture_package};
    use crate::vehicle::{VehicleClass, VehicleParams, VehicleType};
    use crate::{Network, config::SimConfig};

    const EPS: f64 = 1e-12;

    #[test]
    fn grade_is_rise_over_run_and_clamped() {
        assert!((piece_grade(&[0.0, 0.0, 0.0], &[30.0, 40.0, 3.0]) - 0.06).abs() < EPS);
        assert!((piece_grade(&[0.0, 0.0, 3.0], &[50.0, 0.0, 0.0]) + 0.06).abs() < EPS);
        assert_eq!(piece_grade(&[0.0, 0.0, 0.0], &[10.0, 0.0, 6.0]), MAX_GRADE);
        assert_eq!(piece_grade(&[0.0, 0.0, 0.0], &[10.0, 0.0, -6.0]), -MAX_GRADE);
        assert_eq!(piece_grade(&[0.0, 0.0, 0.0], &[0.0, 0.0, 5.0]), 0.0);
        assert_eq!(piece_grade(&[1.0, 2.0, 6.0], &[9.0, 2.0, 6.0]), 0.0);
        assert!((sine(0.06) - 0.06 / 1.0036_f64.sqrt()).abs() < EPS);
    }

    #[test]
    fn flat_roads_leave_the_acceleration_untouched() {
        for acc in [-9.0, -1.3, 0.0, 0.4, 1.5] {
            assert_eq!(apply(acc, 1.5, 50.0, 12.0, 0.0).to_bits(), acc.to_bits());
        }
    }

    #[test]
    fn uphill_caps_acceleration_by_power_and_gravity() {
        let t = VehicleType::articulated_truck();
        // Starting: low gear, the IDM acceleration is still available on 6 %.
        assert_eq!(apply(0.5, t.max_acceleration, t.specific_power, 0.0, 0.06), 0.5);
        // At 15 m/s the engine cannot even hold the speed.
        let at15 = apply(0.4, t.max_acceleration, t.specific_power, 15.0, 0.06);
        assert!(
            (at15 - (7.0 / 15.0 - G * (ROLLING_RESISTANCE + sine(0.06)))).abs() < EPS,
            "{at15}"
        );
        assert!(at15 < 0.0);
        // Braking is unaffected.
        assert_eq!(
            apply(-2.0, t.max_acceleration, t.specific_power, 15.0, 0.06),
            -2.0
        );
        // Cars keep their power reserve at urban and rural speeds.
        let c = VehicleType::for_class(VehicleClass::Car);
        for v in [0.0, 8.0, 14.0, 22.0] {
            assert_eq!(
                apply(c.max_acceleration, c.max_acceleration, c.specific_power, v, 0.06),
                c.max_acceleration,
                "v={v}"
            );
        }
        assert!(available_acceleration(c.specific_power, 36.0, 0.06) < c.max_acceleration);
    }

    #[test]
    fn crawl_speeds_of_heavy_vehicles_are_plausible() {
        let kmh = |t: VehicleType| crawl_speed(t.specific_power, 0.06) * 3.6;
        let artic = kmh(VehicleType::articulated_truck());
        let truck = kmh(VehicleType::for_class(VehicleClass::Truck));
        let bus = kmh(VehicleType::for_class(VehicleClass::Bus));
        let car = kmh(VehicleType::for_class(VehicleClass::Car));
        assert!((35.0..45.0).contains(&artic), "articulated {artic}");
        assert!((50.0..60.0).contains(&truck), "truck {truck}");
        assert!((50.0..60.0).contains(&bus), "bus {bus}");
        assert!(car > 250.0, "car {car}");
    }

    #[test]
    fn downhill_boosts_only_positive_accelerations_modestly() {
        let boosted = apply(1.0, 1.5, 50.0, 10.0, -0.06);
        assert!((boosted - (1.0 + 0.5 * G * sine(0.06) / 1.5)).abs() < EPS);
        assert_eq!(apply(-1.0, 1.5, 50.0, 10.0, -0.06), -1.0);
        assert_eq!(apply(0.0, 1.5, 50.0, 10.0, -0.06), 0.0);
        // Steep grades: at most ×(1 + DOWNHILL_SHARE).
        assert!((apply(0.5, 0.5, 7.0, 10.0, -MAX_GRADE) - 0.75).abs() < EPS);
        assert!(apply(1.0, 1.5, 50.0, 10.0, -0.06) > -MAX_EMERGENCY_DECELERATION);
    }

    // ------------------------------------------------------------- network and scenario

    /// The corridor A → M → B (two links of `length` m along x, 80 km/h) with heights `z(x)`,
    /// geometry resampled every `step` metres.
    fn relief(length: f64, step: f64, z: impl Fn(f64) -> f64) -> Package {
        let mut p = corridor(1, length, 80.0 / 3.6).build();
        let resample = |pts: &mut Vec<Point>| {
            let (a, b) = (pts[0], pts[pts.len() - 1]);
            let n = ((b[0] - a[0]).abs() / step).ceil() as usize;
            *pts = (0..=n)
                .map(|i| {
                    let f = i as f64 / n as f64;
                    let x = a[0] + (b[0] - a[0]) * f;
                    [x, a[1] + (b[1] - a[1]) * f, z(x)]
                })
                .collect();
        };
        for link in &mut p.links {
            resample(&mut link.geometry);
            for lane in &mut link.lanes {
                resample(&mut lane.geometry);
            }
        }
        for c in &mut p.connectors {
            for q in &mut c.geometry {
                q[2] = z(q[0]);
            }
        }
        for n in &mut p.nodes {
            n.z = z(n.x);
        }
        p
    }

    /// The first link climbs at `grade`, the second is level on top.
    fn hill(grade: f64, length: f64) -> Package {
        relief(length, 10.0, |x| grade * x.min(length))
    }

    #[test]
    fn network_reports_grades_along_segments() {
        let net = Network::from_package(&hill(0.06, 1000.0)).unwrap();
        let up = net.link_lane(net.link_index("up").unwrap(), 0).unwrap();
        let down = net.link_lane(net.link_index("down").unwrap(), 0).unwrap();
        assert!((net.grade_at(up, 500.0) - 0.06).abs() < 1e-9);
        assert!((net.grade_at(up, 0.0) - 0.06).abs() < 1e-9);
        assert_eq!(net.grade_at(down, 300.0), 0.0);
        let flat = Network::from_package(&fixture_package()).unwrap();
        assert!((0..flat.segment_count() as u32).all(|s| flat.grade_at(s, 5.0) == 0.0));
    }

    /// Speed (m/s) of a lone vehicle after it climbed `metres` of a 6 % grade from 80 km/h.
    fn speed_after_climb(params: VehicleParams, grade: f64, metres: f64) -> f64 {
        let net = Network::from_package(&hill(grade, 1500.0)).unwrap();
        let config = SimConfig {
            default_demand: Some(0.0),
            ..SimConfig::default()
        };
        let mut sim = Simulation::new(net, config, 3).unwrap();
        let v0 = params.desired_speed(80.0 / 3.6);
        let id = sim.place_vehicle("up", 0, 5.0, v0, "down", params).unwrap();
        for _ in 0..2000 {
            sim.step();
            let v = sim.vehicles().iter().find(|v| v.id == id).unwrap();
            if v.pos >= metres {
                return v.speed;
            }
        }
        panic!("vehicle did not reach {metres} m");
    }

    #[test]
    fn trucks_crawl_up_a_six_percent_grade_while_cars_keep_their_speed() {
        let artic = VehicleType::articulated_truck().params();
        let truck = VehicleParams::for_class(VehicleClass::Truck);
        let car = VehicleParams::for_class(VehicleClass::Car);
        let kmh = |v: f64| v * 3.6;

        let car_top = kmh(speed_after_climb(car, 0.06, 1200.0));
        let truck_top = kmh(speed_after_climb(truck, 0.06, 1200.0));
        let artic_top = kmh(speed_after_climb(artic, 0.06, 1200.0));
        println!(
            "after 1200 m of 6 %: car {car_top:.1}, truck {truck_top:.1}, articulated {artic_top:.1} km/h"
        );
        assert!(car_top > 79.0, "car {car_top} km/h");
        assert!((45.0..58.0).contains(&truck_top), "truck {truck_top} km/h");
        assert!(
            (33.0..43.0).contains(&artic_top),
            "articulated truck {artic_top} km/h"
        );

        // A gentle 1 % grade hardly matters even for the articulated truck.
        let gentle = kmh(speed_after_climb(artic, 0.01, 1200.0));
        assert!(gentle > 70.0, "articulated truck on 1 %: {gentle} km/h");
    }

    #[test]
    fn schematic_bridge_ramps_cost_heavy_vehicles_little() {
        // Grade separation without terrain (ADR-0016): a 6 m deck reached over 20 m ramps (30 %,
        // clamped to 12 %) on a short bridge link.
        let ramp = |x: f64| {
            let d = (x - 600.0).abs();
            6.0 * ((60.0 - d) / 20.0).clamp(0.0, 1.0)
        };
        let net = Network::from_package(&relief(1000.0, 2.0, ramp)).unwrap();
        let config = SimConfig {
            default_demand: Some(0.0),
            ..SimConfig::default()
        };
        let mut sim = Simulation::new(net, config, 3).unwrap();
        let artic = VehicleType::articulated_truck().params();
        let v0 = artic.desired_speed(80.0 / 3.6);
        let id = sim.place_vehicle("up", 0, 300.0, v0, "down", artic).unwrap();
        let mut slowest = v0;
        for _ in 0..400 {
            sim.step();
            let v = sim.vehicles().iter().find(|v| v.id == id).unwrap();
            slowest = slowest.min(v.speed);
        }
        assert!(slowest * 3.6 > 72.0, "slowest {} km/h", slowest * 3.6);
        assert!(slowest < v0, "the ramp is felt");
    }

    #[test]
    fn flat_networks_run_bit_identical_with_and_without_grade_support() {
        // The golden fixture is flat on every segment (bridges are level at 6 m): the grade model
        // must not change a single bit there; `golden_runs` pins the checksums.
        let net = Network::from_package(&fixture_package()).unwrap();
        assert!(!net.has_relief());
    }
}
