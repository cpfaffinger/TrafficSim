//! Single-lane ring road (Sugiyama et al., 2008): the classic setup in which stop-and-go waves
//! ("phantom jams") emerge from small perturbations without any bottleneck. It is the first
//! golden scenario of the core and powers the Phase 0 demo.

use crate::idm::IdmParams;
use crate::rng::Pcg32;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RingRoadConfig {
    pub vehicle_count: usize,
    /// Circumference in metres.
    pub length: f64,
    /// Vehicle length in metres.
    pub vehicle_length: f64,
    /// Time step in seconds.
    pub time_step: f64,
    /// Relative random spread of each driver's desired speed and headway (0 = identical drivers).
    pub heterogeneity: f64,
    pub seed: u64,
    pub params: IdmParams,
}

impl Default for RingRoadConfig {
    /// The original Sugiyama experiment: 22 cars on a 230 m circuit.
    fn default() -> Self {
        Self {
            vehicle_count: 22,
            length: 230.0,
            vehicle_length: 5.0,
            time_step: 0.1,
            heterogeneity: 0.0,
            seed: 1,
            params: IdmParams {
                desired_speed: 30.0 / 3.6,
                time_headway: 1.0,
                max_acceleration: 0.5,
                comfortable_deceleration: 2.0,
                minimum_gap: 2.0,
                delta: 4.0,
            },
        }
    }
}

/// Ring road state in structure-of-arrays layout. Vehicle `i + 1` (mod n) leads vehicle `i`.
#[derive(Debug, Clone)]
pub struct RingRoad {
    config: RingRoadConfig,
    positions: Vec<f64>,
    speeds: Vec<f64>,
    accelerations: Vec<f64>,
    params: Vec<IdmParams>,
    time: f64,
    rng: Pcg32,
}

impl RingRoad {
    /// Places vehicles equidistantly at their equilibrium speed.
    ///
    /// # Panics
    /// If the configuration is physically impossible (no vehicles, non-positive time step or
    /// vehicles that do not fit on the ring).
    pub fn new(config: RingRoadConfig) -> Self {
        assert!(config.vehicle_count > 0, "at least one vehicle is required");
        assert!(config.time_step > 0.0, "time step must be positive");
        let n = config.vehicle_count;
        let spacing = config.length / n as f64;
        assert!(spacing > config.vehicle_length, "vehicles do not fit on the ring");

        let mut rng = Pcg32::new(config.seed, 0x5eed);
        let params: Vec<IdmParams> = (0..n)
            .map(|_| {
                let mut p = config.params;
                if config.heterogeneity > 0.0 {
                    let h = config.heterogeneity;
                    p.desired_speed *= rng.uniform(1.0 - h, 1.0 + h);
                    p.time_headway *= rng.uniform(1.0 - h, 1.0 + h);
                }
                p
            })
            .collect();

        let gap = spacing - config.vehicle_length;
        let positions = (0..n).map(|i| i as f64 * spacing).collect();
        let speeds = params.iter().map(|p| p.equilibrium_speed(gap)).collect();

        Self {
            config,
            positions,
            speeds,
            accelerations: vec![0.0; n],
            params,
            time: 0.0,
            rng,
        }
    }

    pub fn config(&self) -> &RingRoadConfig {
        &self.config
    }

    pub fn vehicle_count(&self) -> usize {
        self.positions.len()
    }

    pub fn time(&self) -> f64 {
        self.time
    }

    /// Positions along the ring in `[0, length)`.
    pub fn positions(&self) -> &[f64] {
        &self.positions
    }

    pub fn speeds(&self) -> &[f64] {
        &self.speeds
    }

    /// Net (bumper-to-bumper) gap of vehicle `i` to its leader.
    pub fn gap(&self, i: usize) -> f64 {
        let n = self.vehicle_count();
        if n == 1 {
            return self.config.length - self.config.vehicle_length;
        }
        let leader = (i + 1) % n;
        let mut distance = self.positions[leader] - self.positions[i];
        if distance < 0.0 {
            distance += self.config.length;
        }
        distance - self.config.vehicle_length
    }

    pub fn mean_speed(&self) -> f64 {
        self.speeds.iter().sum::<f64>() / self.vehicle_count() as f64
    }

    pub fn speed_std_dev(&self) -> f64 {
        let mean = self.mean_speed();
        let variance =
            self.speeds.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / self.vehicle_count() as f64;
        variance.sqrt()
    }

    /// Smallest gap on the ring; negative values would mean a collision.
    pub fn min_gap(&self) -> f64 {
        (0..self.vehicle_count())
            .map(|i| self.gap(i))
            .fold(f64::INFINITY, f64::min)
    }

    /// Kicks vehicle `index` by multiplying its speed (e.g. 0.5 = sudden braking).
    pub fn perturb(&mut self, index: usize, speed_factor: f64) {
        if let Some(speed) = self.speeds.get_mut(index) {
            *speed = (*speed * speed_factor).max(0.0);
        }
    }

    /// Random speed noise for every vehicle (uses the simulation's own seeded generator).
    pub fn add_speed_noise(&mut self, amplitude: f64) {
        for speed in &mut self.speeds {
            *speed = (*speed + self.rng.uniform(-amplitude, amplitude)).max(0.0);
        }
    }

    /// Advances one time step: accelerations from the current state (parallel update), then a
    /// ballistic position update that never produces negative speeds.
    pub fn step(&mut self) {
        let n = self.vehicle_count();
        let dt = self.config.time_step;

        for i in 0..n {
            let gap = if n == 1 { f64::INFINITY } else { self.gap(i) };
            let leader_speed = self.speeds[(i + 1) % n];
            let approach_rate = if n == 1 {
                0.0
            } else {
                self.speeds[i] - leader_speed
            };
            self.accelerations[i] = self.params[i].acceleration(self.speeds[i], gap, approach_rate);
        }

        for i in 0..n {
            let v = self.speeds[i];
            let a = self.accelerations[i];
            let (distance, new_speed) = if v + a * dt < 0.0 {
                // Vehicle stops within the step: travel only the braking distance.
                (-0.5 * v * v / a, 0.0)
            } else {
                (v * dt + 0.5 * a * dt * dt, v + a * dt)
            };
            self.speeds[i] = new_speed;
            self.positions[i] = (self.positions[i] + distance).rem_euclid(self.config.length);
        }

        self.time += dt;
    }

    pub fn run(&mut self, steps: usize) {
        for _ in 0..steps {
            self.step();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sugiyama() -> RingRoad {
        RingRoad::new(RingRoadConfig::default())
    }

    #[test]
    fn starts_in_homogeneous_equilibrium() {
        let ring = sugiyama();
        assert_eq!(ring.vehicle_count(), 22);
        assert!(ring.speed_std_dev() < 1e-12);
        let expected_gap = 230.0 / 22.0 - 5.0;
        for i in 0..22 {
            assert!((ring.gap(i) - expected_gap).abs() < 1e-9);
        }
    }

    #[test]
    fn unperturbed_equilibrium_stays_stable() {
        let mut ring = sugiyama();
        let initial_speed = ring.mean_speed();
        ring.run(3_000);
        assert!((ring.mean_speed() - initial_speed).abs() < 1e-6);
        assert!(ring.speed_std_dev() < 1e-6);
        assert!((ring.time() - 300.0).abs() < 1e-6);
    }

    #[test]
    fn perturbation_grows_into_stop_and_go_wave_without_collisions() {
        let mut ring = sugiyama();
        ring.perturb(0, 0.3);
        let mut min_gap = f64::INFINITY;
        let mut stopped_seen = false;
        for _ in 0..6_000 {
            ring.step();
            min_gap = min_gap.min(ring.min_gap());
            stopped_seen |= ring.speeds().iter().any(|&v| v < 0.5);
        }
        assert!(min_gap > 0.0, "collision: min gap {min_gap}");
        assert!(
            ring.speed_std_dev() > 1.0,
            "wave did not develop, std dev {}",
            ring.speed_std_dev()
        );
        assert!(stopped_seen, "no vehicle came (nearly) to a stop");
    }

    #[test]
    fn speeds_stay_within_physical_bounds() {
        let mut ring = RingRoad::new(RingRoadConfig {
            heterogeneity: 0.2,
            seed: 9,
            ..RingRoadConfig::default()
        });
        ring.add_speed_noise(2.0);
        for _ in 0..5_000 {
            ring.step();
            for (&v, i) in ring.speeds().iter().zip(0..) {
                assert!(v >= 0.0);
                assert!(v <= ring.params[i].desired_speed * 1.5 + 2.0);
            }
            assert!(ring.positions().iter().all(|&x| (0.0..230.0).contains(&x)));
        }
    }

    #[test]
    fn identical_seeds_give_bit_identical_runs() {
        let config = RingRoadConfig {
            heterogeneity: 0.1,
            seed: 42,
            ..RingRoadConfig::default()
        };
        let mut a = RingRoad::new(config);
        let mut b = RingRoad::new(config);
        a.add_speed_noise(1.0);
        b.add_speed_noise(1.0);
        a.run(2_000);
        b.run(2_000);
        assert_eq!(a.positions(), b.positions());
        assert_eq!(a.speeds(), b.speeds());
    }

    #[test]
    fn different_seeds_give_different_runs() {
        let mut a = RingRoad::new(RingRoadConfig {
            heterogeneity: 0.1,
            seed: 1,
            ..RingRoadConfig::default()
        });
        let mut b = RingRoad::new(RingRoadConfig {
            heterogeneity: 0.1,
            seed: 2,
            ..RingRoadConfig::default()
        });
        a.run(100);
        b.run(100);
        assert_ne!(a.positions(), b.positions());
    }

    #[test]
    fn single_vehicle_drives_freely_towards_desired_speed() {
        let mut ring = RingRoad::new(RingRoadConfig {
            vehicle_count: 1,
            ..RingRoadConfig::default()
        });
        ring.perturb(0, 0.0);
        ring.run(1_200);
        assert!((ring.gap(0) - 225.0).abs() < 1e-9);
        assert!(ring.mean_speed() > 0.95 * ring.config().params.desired_speed);
    }

    #[test]
    fn perturb_ignores_unknown_vehicles_and_clamps_at_zero() {
        let mut ring = sugiyama();
        ring.perturb(999, 0.0);
        ring.perturb(3, -5.0);
        assert_eq!(ring.speeds()[3], 0.0);
    }

    #[test]
    #[should_panic(expected = "do not fit")]
    fn rejects_overfull_ring() {
        let _ = RingRoad::new(RingRoadConfig {
            vehicle_count: 100,
            ..RingRoadConfig::default()
        });
    }

    #[test]
    #[should_panic(expected = "at least one vehicle")]
    fn rejects_empty_ring() {
        let _ = RingRoad::new(RingRoadConfig {
            vehicle_count: 0,
            ..RingRoadConfig::default()
        });
    }
}
