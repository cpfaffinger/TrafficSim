use super::junction::Decision;
use super::*;
use crate::package::{NodeControl, Priority};
use crate::synth::{
    FIXTURE, NetBuilder, corridor, crossroads, fixture_network, grid, grid_with_spacing, roundabout,
    t_junction,
};

fn quiet() -> SimConfig {
    SimConfig {
        default_demand: Some(0.0),
        ..SimConfig::default()
    }
}

fn with_demand(vph: f64) -> SimConfig {
    SimConfig {
        default_demand: Some(vph),
        ..SimConfig::default()
    }
}

fn car() -> VehicleParams {
    VehicleParams::for_class(VehicleClass::Car)
}

/// A vehicle that crawls at 0.5 m/s at most.
fn crawler() -> VehicleParams {
    VehicleParams {
        max_speed: 0.0,
        ..car()
    }
}

fn sim(b: &NetBuilder, config: SimConfig) -> Simulation {
    Simulation::new(b.network(), config, 7).unwrap()
}

fn vehicle(sim: &Simulation, id: u32) -> Option<&Vehicle> {
    sim.vehicles().iter().find(|v| v.id == id)
}

fn link_of(sim: &Simulation, v: &Vehicle) -> String {
    sim.network().links[sim.network().segment_link(v.seg) as usize]
        .id
        .clone()
}

/// Physical invariants that must hold after every step.
fn check_invariants(sim: &mut Simulation) {
    // Occupant lists are rebuilt at the start of every step; refresh them for the check.
    sim.rebuild_lists();
    let sim = &*sim;
    let net = sim.network();
    // (front position, length, id) per segment; vehicles changing lanes also occupy their
    // source lane (#108).
    let mut by_seg: BTreeMap<u32, Vec<(f64, f64, u32)>> = BTreeMap::new();
    for v in sim.vehicles() {
        assert!(v.speed >= 0.0 && v.speed.is_finite(), "speed {}", v.speed);
        assert!(
            v.pos >= 0.0 && v.pos <= net.seg_length[v.seg as usize] + 1e-9,
            "pos {}",
            v.pos
        );
        let limit = net.seg_speed_limit[v.seg as usize].max(
            v.prev_seg_limit(net), // entering a slower segment: allow the braking transient
        );
        assert!(
            v.speed <= limit * v.params.speed_factor + 0.5,
            "speed {} above {}",
            v.speed,
            limit
        );
        by_seg
            .entry(v.seg)
            .or_default()
            .push((v.pos, v.params.length, v.id));
        if v.lc_from != NONE {
            assert!(net.is_lane(v.seg) && v.lc_progress >= 0.0 && v.lc_progress < 1.0);
            let from = &net.lanes[v.lc_from as usize];
            assert_eq!(from.link, net.lanes[v.seg as usize].link);
            assert_eq!(from.index.abs_diff(net.lanes[v.seg as usize].index), 1);
            let s = v.pos * net.seg_length[v.lc_from as usize] / net.seg_length[v.seg as usize];
            by_seg
                .entry(v.lc_from)
                .or_default()
                .push((s, v.params.length, v.id));
        }
    }
    for (seg, vs) in &mut by_seg {
        vs.sort_by(|a, b| b.0.total_cmp(&a.0));
        for w in vs.windows(2) {
            let gap = w[0].0 - w[0].1 - w[1].0;
            assert!(
                gap > -1e-6,
                "overlap {gap} on segment {seg} t={}: {:?} / {:?} lc={:?}",
                sim.time(),
                vehicle(sim, w[0].2),
                vehicle(sim, w[1].2),
                sim.lane_change_log().iter().rev().take(3).collect::<Vec<_>>()
            );
        }
    }
    // Never two vehicles inside the two zones of a crossing at the same time; on a merge, the
    // vehicles inside its zones never overlap measured towards the common end (#109).
    for c in 0..net.connectors.len() as u32 {
        for (&k, &zone) in net.conflicts(c).iter().zip(net.conflict_zones(c)) {
            if net.merges(c, k) {
                let len = |c: u32| net.seg_length[net.connector_segment(c) as usize];
                let other = net.conflict_zone(k, c).unwrap();
                sim.on_connector(c, false, |j, front| {
                    let v = &sim.vehicles[j as usize];
                    if front < zone.0 {
                        return;
                    }
                    let rem = len(c) - front;
                    sim.on_connector(k, false, |o, f2| {
                        let w = &sim.vehicles[o as usize];
                        let rem2 = len(k) - f2;
                        let overlap = (rem + v.params.length).min(rem2 + w.params.length) - rem.max(rem2);
                        assert!(
                            f2 < other.0 || overlap < 1e-6,
                            "merging vehicles overlap by {overlap} on {} / {} at t={}: {v:?} / {w:?}",
                            net.connectors[c as usize].id,
                            net.connectors[k as usize].id,
                            sim.time()
                        );
                    });
                });
                continue;
            }
            sim.on_connector(c, true, |j, front| {
                let v = &sim.vehicles[j as usize];
                if front >= zone.0
                    && front - v.params.length < zone.1
                    && let Some(o) = sim.zone_occupant(k, c, j)
                {
                    panic!(
                        "conflict zone of {} and {} occupied twice at t={}: {:?} / {:?}",
                        net.connectors[c as usize].id,
                        net.connectors[k as usize].id,
                        sim.time(),
                        v,
                        sim.vehicles[o as usize]
                    );
                }
            });
        }
    }
}

impl Vehicle {
    fn prev_seg_limit(&self, net: &Network) -> f64 {
        if self.prev_seg == NONE {
            0.0
        } else {
            net.seg_speed_limit[self.prev_seg as usize]
        }
    }
}

fn run_checked(sim: &mut Simulation, steps: usize) {
    for _ in 0..steps {
        sim.step();
        check_invariants(sim);
    }
}

// ---------------------------------------------------------------- construction & API

#[test]
fn builds_from_json_and_rejects_bad_input() {
    let sim = Simulation::from_json(FIXTURE, "{}", 1).unwrap();
    assert_eq!(sim.network().links.len(), 10);
    assert_eq!(sim.time_step(), 0.1);
    assert_eq!(sim.config().default_demand, None);
    assert_eq!(sim.demand("n1"), Some(2.0 * 600.0), "primary road, two lanes");
    assert!(
        Simulation::from_json("{}", "{}", 1)
            .unwrap_err()
            .contains("invalid network package")
    );
    assert!(
        Simulation::from_json(FIXTURE, "{", 1)
            .unwrap_err()
            .contains("config")
    );
    let e = Simulation::from_json(FIXTURE, r#"{"demand": {"n0": 100}}"#, 1).unwrap_err();
    assert!(e.contains("not an entry node"), "{e}");
    let e = Simulation::from_json(FIXTURE, r#"{"demand": {"zz": 100}}"#, 1).unwrap_err();
    assert!(e.contains("not an entry node"), "{e}");
    let bad = SimConfig {
        time_step: -1.0,
        ..SimConfig::default()
    };
    assert!(Simulation::new(fixture_network(), bad, 1).is_err());
}

#[test]
fn time_advances_in_fixed_steps() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    s.run(10);
    assert_eq!(s.steps(), 10);
    assert_eq!(s.time(), 1.0);
    assert_eq!(s.vehicle_count(), 0);
    let stats = s.stats();
    assert_eq!(stats.mean_speed, 0.0);
    assert_eq!(stats.mean_travel_time, 0.0);
}

#[test]
fn demand_can_be_changed_at_runtime() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    assert_eq!(s.demand("n1"), Some(0.0));
    assert_eq!(s.demand("n0"), None);
    assert_eq!(s.demand("zz"), None);
    s.set_demand("n1", 3600.0).unwrap();
    assert_eq!(s.demand("n1"), Some(3600.0));
    assert!(s.set_demand("n0", 10.0).is_err());
    assert!(s.set_demand("n1", f64::NAN).is_err());
    assert!(s.set_demand("n1", -1.0).is_err());
    s.run(600);
    let generated = s.stats().spawned + s.stats().waiting_to_enter;
    assert!((40..=85).contains(&generated), "{generated}");
    s.set_demand("n1", 0.0).unwrap();
    let before = s.stats().spawned + s.stats().waiting_to_enter;
    s.run(600);
    assert_eq!(s.stats().spawned + s.stats().waiting_to_enter, before);
}

/// #125: trip totals of the vehicle inspector.
#[test]
fn vehicle_info_reports_the_trip_so_far() {
    let mut b = NetBuilder::new();
    b.node("W", -300.0, 0.0, NodeControl::Boundary)
        .node("J", 0.0, 0.0, NodeControl::Signal)
        .node("E", 300.0, 0.0, NodeControl::Boundary)
        .link("in", "W", "J", 1, 13.9)
        .link("out", "J", "E", 1, 13.9)
        .connect("go", "in", 0, "out", 0, Priority::Signal)
        .signal("J", 60.0, &[("g", 40.0, 60.0, 3.0)]);
    b.connector_mut("go").signal_group = Some("g".into());
    let mut s = sim(&b, quiet());
    let id = s.place_vehicle("in", 0, 100.0, 13.9, "out", car()).unwrap();
    assert!(s.vehicle_info(id + 1).is_none());
    s.run(400);
    let info = s.vehicle_info(id).expect("still on the network");
    assert_eq!(info.vehicle_type, "car");
    assert_eq!(info.route, ["in", "out"]);
    assert!((info.travel_time - s.time()).abs() < 1e-9);
    assert!(info.distance > 0.0);
    assert!(info.stops >= 1, "{info:?}");
    assert!(
        info.stopped_time > 0.0 && info.lost_time >= info.stopped_time * 0.99,
        "{info:?}"
    );
    let json = serde_json::to_value(&info).unwrap();
    assert!(json.get("lostTime").is_some() && json.get("routePos").is_some());
}

#[test]
fn place_vehicle_validates_its_arguments() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    assert!(s.place_vehicle("zz", 0, 0.0, 0.0, "l2", car()).is_err());
    assert!(s.place_vehicle("l1", 0, 0.0, 0.0, "zz", car()).is_err());
    assert!(s.place_vehicle("l1", 5, 0.0, 0.0, "l2", car()).is_err());
    assert!(
        s.place_vehicle("l1", 0, 0.0, 0.0, "l4", car()).is_err(),
        "no U-turn"
    );
    let id = s.place_vehicle("l1", 0, 0.0, 0.0, "l2", car()).unwrap();
    let v = vehicle(&s, id).unwrap();
    assert_eq!(s.route_of(v).len(), 2);
}

// ---------------------------------------------------------------- #41 car following

#[test]
fn single_vehicle_drives_through_a_connector_to_its_exit() {
    let b = corridor(1, 300.0, 15.0);
    let mut s = sim(&b, quiet());
    let id = s.place_vehicle("up", 0, 0.0, 0.0, "down", car()).unwrap();
    let mut max_speed: f64 = 0.0;
    let mut seen_down = false;
    for _ in 0..1000 {
        s.step();
        check_invariants(&mut s);
        if let Some(v) = vehicle(&s, id) {
            max_speed = max_speed.max(v.speed);
            seen_down |= link_of(&s, v) == "down";
        }
    }
    assert!(seen_down);
    assert!(max_speed <= 15.0 + 1e-9 && max_speed > 14.0, "{max_speed}");
    let stats = s.stats();
    assert_eq!((stats.spawned, stats.arrived, stats.active), (1, 1, 0));
    // 600 m at up to 15 m/s from standstill.
    assert!(
        stats.mean_travel_time > 40.0 && stats.mean_travel_time < 60.0,
        "{}",
        stats.mean_travel_time
    );
}

#[test]
fn follower_stops_behind_a_slow_leader_across_the_connector() {
    let b = corridor(1, 300.0, 15.0);
    let mut s = sim(&b, quiet());
    let leader = s.place_vehicle("down", 0, 10.0, 0.0, "down", crawler()).unwrap();
    let follower = s.place_vehicle("up", 0, 150.0, 15.0, "down", car()).unwrap();
    for _ in 0..600 {
        s.step();
        check_invariants(&mut s);
        let (l, f) = (vehicle(&s, leader).unwrap(), vehicle(&s, follower).unwrap());
        // Path distance from the follower's front to the leader's rear.
        let net = s.network();
        let f_to_down = match net.segment_connector(f.seg) {
            None if link_of(&s, f) == "up" => {
                net.seg_length[f.seg as usize] - f.pos + net.seg_length[net.connector_segment(0) as usize]
            }
            None => -f.pos,
            Some(_) => net.seg_length[f.seg as usize] - f.pos,
        };
        assert!(
            f_to_down + l.pos - l.params.length > 0.0,
            "follower ran into the leader"
        );
    }
    let f = vehicle(&s, follower).unwrap();
    assert!(
        f.speed < 1.0,
        "follower should be crawling behind the leader: {}",
        f.speed
    );
}

#[test]
fn speed_limit_drops_are_anticipated() {
    let mut b = corridor(1, 300.0, 15.0);
    for lane in &mut b.link_mut("down").lanes {
        lane.speed_limit = 5.0;
    }
    b.link_mut("down").speed_limit = 5.0;
    let mut s = sim(&b, quiet());
    let id = s.place_vehicle("up", 0, 0.0, 15.0, "down", car()).unwrap();
    let mut entry_speed = None;
    for _ in 0..800 {
        s.step();
        if let Some(v) = vehicle(&s, id)
            && entry_speed.is_none()
            && link_of(&s, v) == "down"
            && s.network().is_lane(v.seg)
        {
            entry_speed = Some(v.speed);
        }
    }
    let entry_speed = entry_speed.unwrap();
    assert!(entry_speed <= 5.6, "entered the 5 m/s section at {entry_speed}");
}

#[test]
fn vehicles_brake_for_vehicles_still_leaving_their_lane() {
    // A slow vehicle that turned right is still partly in the shared approach lane; the
    // follower going straight must not drive into its rear.
    let mut b = t_junction(Priority::Minor);
    b.connect("we_s2", "we", 0, "js", 0, Priority::Major);
    let mut s = sim(&b, quiet());
    let turner = s
        .place_vehicle(
            "we",
            0,
            290.0,
            0.0,
            "js",
            VehicleParams {
                length: 12.0,
                ..crawler()
            },
        )
        .unwrap();
    let straight = s.place_vehicle("we", 0, 250.0, 12.0, "je", car()).unwrap();
    for _ in 0..100 {
        s.step();
        check_invariants(&mut s);
    }
    let t = vehicle(&s, turner).unwrap();
    let f = vehicle(&s, straight).unwrap();
    assert!(!s.network().is_lane(t.seg), "turner entered its connector");
    assert!(t.pos < t.params.length, "turner still overlaps the lane");
    assert!(
        f.pos < s.network().seg_length[f.seg as usize] - (t.params.length - t.pos),
        "follower kept clear"
    );
}

#[test]
fn ballistic_update_never_reverses() {
    assert_eq!(ballistic(1.0, -9.0, 0.5), (1.0 / 18.0, 0.0));
    let (d, v) = ballistic(10.0, 1.0, 0.1);
    assert!((d - 1.005).abs() < 1e-12 && (v - 10.1).abs() < 1e-12);
}

// ---------------------------------------------------------------- #52 reaction time, distraction

fn without_perception(mut c: SimConfig) -> SimConfig {
    c.perception.enabled = false;
    c
}

/// Two cars at rest bumper to bumper (gap s0); the leader drives off at t = 0. Returns the
/// follower's position after `steps`.
fn start_up(config: SimConfig, reaction_time: f64, steps: usize) -> f64 {
    let b = corridor(1, 1000.0, 15.0);
    let mut s = sim(&b, config);
    s.place_vehicle("up", 0, 100.0, 0.0, "down", car()).unwrap();
    let follower = VehicleParams {
        reaction_time,
        ..car()
    };
    let id = s
        .place_vehicle("up", 0, 100.0 - 4.5 - 2.0, 0.0, "down", follower)
        .unwrap();
    run_checked(&mut s, steps);
    vehicle(&s, id).unwrap().pos
}

#[test]
fn reaction_time_delays_the_start_up_behind_a_departing_leader() {
    let instant = start_up(without_perception(quiet()), 0.8, 40);
    let quick = start_up(quiet(), 0.4, 40);
    let slow = start_up(quiet(), 1.5, 40);
    assert!(instant > quick && quick > slow, "{instant} {quick} {slow}");
    assert_eq!(
        start_up(quiet(), 0.0, 40),
        instant,
        "zero reaction time = instantaneous"
    );
}

#[test]
fn a_braking_leader_is_noticed_after_the_reaction_time() {
    let run = |config: SimConfig| {
        let b = corridor(1, 1000.0, 15.0);
        let mut s = sim(&b, config);
        let l = s.place_vehicle("up", 0, 300.0, 15.0, "down", car()).unwrap();
        let f = s.place_vehicle("up", 0, 255.0, 15.0, "down", car()).unwrap();
        run_checked(&mut s, 20);
        // The leader slams on the brakes.
        let li = s.vehicles.iter().position(|v| v.id == l).unwrap();
        s.vehicles[li].params.max_speed = 0.0;
        let mut onset = None;
        for step in 0..100 {
            s.step();
            check_invariants(&mut s);
            if onset.is_none() && vehicle(&s, f).unwrap().acc < -1.0 {
                onset = Some(step);
            }
        }
        onset.unwrap()
    };
    let instant = run(without_perception(quiet()));
    let delayed = run(quiet());
    assert!(
        (instant + 5..=instant + 10).contains(&delayed),
        "0.8 s reaction time: {instant} vs {delayed} steps"
    );
}

#[test]
fn distraction_lapses_follow_the_profile_rate_and_freeze_the_acceleration() {
    let config = SimConfig::from_json(
        r#"{"defaultDemand": 1200, "driverMix": {"distracted": 1},
            "driverProfiles": {"distracted": {"lapseRate": 360, "lapseDuration": 1.0}}}"#,
    )
    .unwrap();
    let b = corridor(2, 1000.0, 20.0);
    let mut s = sim(&b, config);
    let mut vehicle_seconds = 0.0;
    let mut frozen = 0;
    for _ in 0..6000 {
        let before: BTreeMap<u32, f64> = s.vehicles().iter().map(|v| (v.id, v.acc)).collect();
        s.step();
        check_invariants(&mut s);
        vehicle_seconds += s.vehicle_count() as f64 * s.time_step();
        for v in s.vehicles() {
            let in_lapse = v.lapse_until > s.time() - s.time_step() && v.lapse_until.is_finite();
            if in_lapse
                && let Some(&a) = before.get(&v.id)
                && v.acc == a
                && a != 0.0
            {
                frozen += 1;
            }
        }
    }
    let expected = vehicle_seconds * 0.1;
    let lapses = s.stats().lapses as f64;
    assert!(
        (lapses - expected).abs() < 0.25 * expected,
        "{lapses} vs {expected}"
    );
    assert!(frozen > 100, "{frozen}");
    // Lapses are off when perception is disabled.
    let mut off = sim(&b, without_perception(s.config().clone()));
    off.run(3000);
    assert_eq!(off.stats().lapses, 0);
}

#[test]
fn mixed_driver_populations_never_collide() {
    let config = SimConfig::from_json(
        r#"{"defaultDemand": 900, "vehicleMix": {"car": 6, "van": 1, "truck": 1, "articulatedTruck": 1, "bus": 1, "motorcycle": 1},
            "driverMix": {"attentive": 1, "average": 1, "distracted": 2, "aggressive": 2, "commuter": 1}}"#,
    )
    .unwrap();
    let mut s = Simulation::new(fixture_network(), config, 11).unwrap();
    run_checked(&mut s, 4000);
    let stats = s.stats();
    assert!(stats.arrived > 200 && stats.lapses > 0, "{stats:?}");
    let moderate = SimConfig {
        default_demand: Some(400.0),
        ..s.config().clone()
    };
    let mut t = sim(&t_junction(Priority::Minor), moderate.clone());
    run_checked(&mut t, 3000);
    let mut r = sim(&roundabout(), moderate);
    run_checked(&mut r, 3000);
    assert!(
        t.stats().arrived > 50 && r.stats().arrived > 50,
        "{:?} {:?}",
        t.stats(),
        r.stats()
    );
}

// ---------------------------------------------------------------- #42 sources, sinks, lifecycle

#[test]
fn poisson_arrivals_match_the_demand() {
    let b = corridor(2, 300.0, 15.0);
    let mut s = sim(
        &b,
        SimConfig {
            demand: BTreeMap::from([("A".to_string(), 1800.0)]),
            ..quiet()
        },
    );
    s.run(12_000);
    let stats = s.stats();
    let generated = stats.spawned + stats.waiting_to_enter;
    // 1800 veh/h for 1200 s: 600 expected, ±3σ ≈ ±75.
    assert!((525..=675).contains(&generated), "{generated}");
    assert_eq!(stats.arrived + stats.active, stats.spawned);
    assert!(stats.arrived > 500);
    assert_eq!(stats.unroutable, 0);
}

#[test]
fn insertion_waits_for_a_safe_gap() {
    let b = corridor(1, 300.0, 15.0);
    let mut s = sim(
        &b,
        SimConfig {
            demand: BTreeMap::from([("A".to_string(), 20_000.0)]),
            ..quiet()
        },
    );
    run_checked(&mut s, 3000);
    let stats = s.stats();
    assert!(stats.waiting_to_enter > 100, "{stats:?}");
    // Capacity of a single lane is far below 20 000 veh/h.
    assert!(stats.spawned < 250, "{stats:?}");
    assert!(stats.spawned > 120, "{stats:?}");
}

#[test]
fn max_vehicles_caps_insertion() {
    let b = corridor(1, 300.0, 15.0);
    let mut s = sim(
        &b,
        SimConfig {
            default_demand: Some(3600.0),
            max_vehicles: 3,
            ..SimConfig::default()
        },
    );
    for _ in 0..400 {
        s.step();
        assert!(s.vehicle_count() <= 3);
    }
}

#[test]
fn vehicle_mix_and_heterogeneity_shape_the_fleet() {
    let mut s = Simulation::new(
        fixture_network(),
        SimConfig {
            default_demand: Some(900.0),
            vehicle_mix: BTreeMap::from([("car".into(), 1.0), ("truck".into(), 1.0)]),
            heterogeneity: 0.2,
            ..SimConfig::default()
        },
        3,
    )
    .unwrap();
    run_checked(&mut s, 1200);
    let classes: std::collections::BTreeSet<VehicleClass> =
        s.vehicles().iter().map(|v| v.params.class).collect();
    assert_eq!(classes, [VehicleClass::Car, VehicleClass::Truck].into());
    let factors: std::collections::BTreeSet<u64> = s
        .vehicles()
        .iter()
        .map(|v| v.params.speed_factor.to_bits())
        .collect();
    assert!(factors.len() > 3);
}

#[test]
fn vehicle_types_and_driver_profiles_come_from_the_config() {
    let config = SimConfig::from_json(
        r#"{"defaultDemand": 900,
            "vehicleMix": {"car": 2, "articulatedTruck": 1, "minibus": 1},
            "vehicleTypes": {"minibus": {"class": "bus", "length": 7.5}},
            "driverMix": {"aggressive": 1, "distracted": 1}}"#,
    )
    .unwrap();
    let mut s = Simulation::new(fixture_network(), config, 4).unwrap();
    run_checked(&mut s, 1500);
    let fleet = s.fleet();
    let types: std::collections::BTreeSet<&str> = s
        .vehicles()
        .iter()
        .map(|v| fleet.catalogue.name(v.params.vehicle_type))
        .collect();
    assert_eq!(types, ["articulatedTruck", "car", "minibus"].into());
    for v in s.vehicles() {
        let name = fleet.catalogue.name(v.params.vehicle_type);
        let expected = fleet.catalogue.get(v.params.vehicle_type);
        assert_eq!(v.params.length, expected.length, "{name}");
        assert_eq!(v.params.class, expected.class);
        let profile = fleet.profiles.name(v.params.driver_profile);
        assert!(profile == "aggressive" || profile == "distracted");
        if profile == "distracted" {
            assert!(v.params.lapse_rate > 0.0);
        }
    }
}

#[test]
fn entries_without_reachable_exits_count_as_unroutable() {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("B", 100.0, 0.0, NodeControl::Priority)
        .link("ab", "A", "B", 1, 10.0);
    let mut s = sim(&b, with_demand(3600.0));
    s.run(600);
    let stats = s.stats();
    assert!(stats.unroutable > 20, "{stats:?}");
    assert_eq!(stats.spawned, 0);
}

#[test]
fn destination_weights_steer_exits() {
    let config = SimConfig {
        demand: BTreeMap::from([("n1".to_string(), 1200.0)]),
        destination_weights: BTreeMap::from([("n4".to_string(), 0.0), ("n3".to_string(), 0.0)]),
        ..quiet()
    };
    let mut s = Simulation::new(fixture_network(), config, 5).unwrap();
    s.run(1200);
    let net = s.network();
    for v in s.vehicles() {
        let dest = *s.route_of(v).last().unwrap();
        assert_eq!(net.links[dest as usize].id, "l2");
    }
    assert!(s.stats().spawned > 10);
}

// ---------------------------------------------------------------- #53 demand model

fn link_ids(s: &Simulation, route: &[u32]) -> Vec<String> {
    route
        .iter()
        .map(|&l| s.network().links[l as usize].id.clone())
        .collect()
}

#[test]
fn od_matrix_routes_between_zones_and_replaces_the_default_demand() {
    let config = SimConfig::from_json(
        r#"{"defaultDemand": 900,
            "zones": {"west": {"nodes": ["n1"]}, "east": {"nodes": ["n2"]}},
            "od": [{"from": "west", "to": "east", "vph": 1800}]}"#,
    )
    .unwrap();
    let mut s = Simulation::new(fixture_network(), config, 3).unwrap();
    assert_eq!(
        s.demand("n3"),
        Some(0.0),
        "defaultDemand is ignored with an OD matrix"
    );
    run_checked(&mut s, 3000);
    let generated = s.stats().spawned + s.stats().waiting_to_enter;
    assert!((120..=180).contains(&generated), "{generated}");
    for v in s.vehicles() {
        assert_eq!(link_ids(&s, s.route_of(v)), ["l1", "l2"]);
    }
    assert_eq!(s.od_demand(0), Some((1800.0, 1.0)));
    assert_eq!(s.od_demand(1), None);
    s.set_od_demand(0, 0.0).unwrap();
    assert!(s.set_od_demand(0, -1.0).is_err());
    assert!(s.set_od_demand(3, 1.0).is_err());
    let before = s.stats().spawned + s.stats().waiting_to_enter;
    s.run(1000);
    assert_eq!(s.stats().spawned + s.stats().waiting_to_enter, before);
}

#[test]
fn time_of_day_profiles_shape_the_arrivals() {
    let config = SimConfig::from_json(
        r#"{"startTimeOfDay": "06:00", "defaultDemand": 0, "demand": {"n1": 3600},
            "curves": {"gate": {"interval": 300, "factors": [0, 1]}},
            "demandCurve": "gate"}"#,
    )
    .unwrap();
    let mut s = Simulation::new(fixture_network(), config, 5).unwrap();
    assert_eq!(s.time_of_day(), 21_600.0);
    s.run(2990);
    assert_eq!(
        s.stats().spawned + s.stats().waiting_to_enter,
        0,
        "factor 0 for 5 minutes"
    );
    s.run(3000);
    let n = s.stats().spawned + s.stats().waiting_to_enter;
    assert!((240..=360).contains(&n), "{n}");
    assert!((s.time_of_day() - (21_600.0 + 599.0)).abs() < 1.0);
    // The built-in weekday curve: the evening peak carries far more traffic than the night.
    let count = |start: &str| {
        let config = SimConfig::from_json(&format!(
            r#"{{"startTimeOfDay": "{start}", "demandCurve": "weekday", "defaultDemand": 1800}}"#
        ))
        .unwrap();
        let mut s = Simulation::new(fixture_network(), config, 5).unwrap();
        s.run(3000);
        s.stats().spawned + s.stats().waiting_to_enter
    };
    assert!(count("17:00") > 8 * count("03:00").max(1));
}

#[test]
fn internal_zones_insert_vehicles_safely_into_passing_traffic() {
    let b = corridor(1, 400.0, 15.0);
    let config = SimConfig::from_json(
        r#"{"demand": {"A": 900},
            "zones": {"res": {"links": ["down"]}, "town": {"nodes": ["B"]}, "start": {"nodes": ["A"]}},
            "od": [{"from": "res", "to": "town", "vph": 600},
                   {"from": "start", "to": "res", "vph": 300}]}"#,
    )
    .unwrap();
    let mut s = sim(&b, config);
    let mut inserted_on_down = 0;
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..6000 {
        s.step();
        check_invariants(&mut s);
        for v in s.vehicles() {
            if seen.insert(v.id) && link_of(&s, v) == "down" {
                inserted_on_down += 1;
            }
        }
    }
    assert!(inserted_on_down > 50, "{inserted_on_down}");
    let stats = s.stats();
    assert!(stats.arrived > 150 && stats.stranded == 0, "{stats:?}");
}

#[test]
fn vehicle_mixes_per_od_and_time_of_day() {
    let config = SimConfig::from_json(
        r#"{"zones": {"w": {"nodes": ["n1"]}, "e": {"nodes": ["n2"]}, "s": {"nodes": ["n4"]}},
            "vehicleMix": {"car": 1, "articulatedTruck": 1},
            "vehicleMixCurves": {"articulatedTruck": "night"},
            "curves": {"night": {"interval": 3600, "factors": [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]}},
            "od": [{"from": "w", "to": "e", "vph": 1200},
                   {"from": "e", "to": "w", "vph": 600, "vehicleMix": {"bus": 1}, "driverMix": {"aggressive": 1}}]}"#,
    )
    .unwrap();
    let mut day = Simulation::new(fixture_network(), config.clone(), 8).unwrap();
    run_checked(&mut day, 2000);
    let fleet = day.fleet().clone();
    for v in day.vehicles() {
        let ty = fleet.catalogue.name(v.params.vehicle_type);
        match link_ids(&day, day.route_of(v))[0].as_str() {
            "l1" => assert_eq!(ty, "car", "no trucks at 07:00"),
            _ => {
                assert_eq!(ty, "bus");
                assert_eq!(fleet.profiles.name(v.params.driver_profile), "aggressive");
            }
        }
    }
    let night = SimConfig {
        start_time_of_day: crate::demand::TimeOfDay(2.0 * 3600.0),
        ..config
    };
    let mut s = Simulation::new(fixture_network(), night, 8).unwrap();
    s.run(2000);
    assert!(
        s.vehicles()
            .iter()
            .any(|v| s.fleet().catalogue.name(v.params.vehicle_type) == "articulatedTruck")
    );
}

/// A two-lane motorway corridor A → B and a residential street C → D, both through plain joints.
fn motorway_and_residential() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("M", 500.0, 0.0, NodeControl::None)
        .node("B", 1000.0, 0.0, NodeControl::Boundary)
        .node("C", 0.0, 300.0, NodeControl::Boundary)
        .node("N", 300.0, 300.0, NodeControl::None)
        .node("D", 600.0, 300.0, NodeControl::Boundary)
        .link("am", "A", "M", 2, 33.3)
        .link("mb", "M", "B", 2, 33.3)
        .link("cn", "C", "N", 1, 8.333)
        .link("nd", "N", "D", 1, 8.333)
        .connect("m0", "am", 0, "mb", 0, Priority::Major)
        .connect("m1", "am", 1, "mb", 1, Priority::Major)
        .connect("r0", "cn", 0, "nd", 0, Priority::Major);
    for l in ["am", "mb"] {
        b.link_mut(l).road_class = crate::package::RoadClass::Motorway;
    }
    for l in ["cn", "nd"] {
        b.link_mut(l).road_class = crate::package::RoadClass::Residential;
    }
    b
}

#[test]
fn entry_demand_defaults_to_road_class_profiles() {
    let net = motorway_and_residential();
    let build = |json: &str| Simulation::new(net.network(), SimConfig::from_json(json).unwrap(), 2).unwrap();
    let s = build(r#"{"startTimeOfDay": "17:00"}"#);
    assert_eq!(s.demand("A"), Some(2.0 * 1400.0));
    assert_eq!(s.demand("C"), Some(60.0));
    let sources = s.demand_sources();
    assert!(sources.iter().all(|d| d.kind == "boundary" && d.factor == 1.0));
    let mut s = s;
    s.run(6000);
    let count = |s: &Simulation, link: &str| s.vehicles().iter().filter(|v| link_of(s, v) == link).count();
    assert!(s.stats().spawned > 300);
    assert!(count(&s, "am") + count(&s, "mb") > 5 * (count(&s, "cn") + count(&s, "nd")).max(1));
    // Overrides: profiles patch the class, entries / demand / defaultDemand take precedence.
    let s = build(r#"{"profiles": {"residential": {"volumePerLane": 200, "curve": "flat"}}}"#);
    assert_eq!(s.demand("C"), Some(200.0));
    assert_eq!(s.demand_sources()[1].factor, 1.0);
    let s = build(r#"{"entries": {"A": {"vph": 100, "curve": "freight"}}, "demand": {"A": 7, "C": 50}}"#);
    assert_eq!((s.demand("A"), s.demand("C")), (Some(100.0), Some(50.0)));
    let s = build(r#"{"defaultDemand": 300}"#);
    assert_eq!((s.demand("A"), s.demand("C")), (Some(300.0), Some(300.0)));
    let s = build(r#"{"autoEntries": false, "entries": {"C": 5}}"#);
    assert_eq!((s.demand("A"), s.demand("C")), (Some(0.0), Some(5.0)));
    let err = |json: &str| {
        Simulation::new(net.network(), SimConfig::from_json(json).unwrap_or_default(), 1)
            .err()
            .unwrap_or_default()
    };
    assert!(err(r#"{"entries": {"M": 5}}"#).contains("not an entry node"));
    assert!(SimConfig::from_json(r#"{"profiles": {"tram": {"volumePerLane": 1}}}"#).is_err());
    assert!(SimConfig::from_json(r#"{"profiles": {"primary": {"volumePerLane": -1}}}"#).is_err());
    assert!(SimConfig::from_json(r#"{"profiles": {"primary": {"curve": "x"}}}"#).is_err());
}

/// Primary road A → X → B with a residential dead-end street X → R → X (U-turn at R).
fn residential_street() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("X", 400.0, 0.0, NodeControl::Priority)
        .node("B", 800.0, 0.0, NodeControl::Boundary)
        .node("R", 400.0, 250.0, NodeControl::Priority)
        .link("ax", "A", "X", 1, 13.889)
        .link("xb", "X", "B", 1, 13.889)
        .link("xr", "X", "R", 1, 8.333)
        .link("rx", "R", "X", 1, 8.333)
        .connect("through", "ax", 0, "xb", 0, Priority::Major)
        .connect("in", "ax", 0, "xr", 0, Priority::Major)
        .connect("out", "rx", 0, "xb", 0, Priority::Minor)
        .connect("turn", "xr", 0, "rx", 0, Priority::Major)
        .auto_conflicts("X");
    for l in ["xr", "rx"] {
        b.link_mut(l).road_class = crate::package::RoadClass::Residential;
    }
    b
}

#[test]
fn residential_trips_start_and_end_inside_the_network() {
    let config = SimConfig::from_json(
        r#"{"autoZones": true, "autoEntries": false, "entries": {"A": 300},
            "residential": {"outboundPerKm": 1500, "inboundPerKm": 1500}}"#,
    )
    .unwrap();
    let mut s = sim(&residential_street(), config.clone());
    let sources = s.demand_sources();
    let kinds: Vec<&str> = sources.iter().map(|d| d.kind).collect();
    assert_eq!(kinds, ["boundary", "residentialOut", "residentialIn"]);
    let homes_km = 2.0 * (250.0 - 8.0 - 8.0) / 1000.0;
    assert!((sources[1].vph - 1500.0 * homes_km).abs() < 1e-6);
    assert_eq!((sources[1].factor, sources[2].factor), (1.0, 0.30), "07:00");
    let mut along = 0;
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..6000 {
        s.step();
        check_invariants(&mut s);
        for v in s.vehicles() {
            if seen.insert(v.id) && ["xr", "rx"].contains(&link_of(&s, v).as_str()) && v.pos > 5.0 {
                along += 1;
            }
        }
    }
    assert!(along > 50, "outbound trips start along the street: {along}");
    let stats = s.stats();
    assert!(stats.arrived > 100 && stats.stranded == 0, "{stats:?}");
    // Inbound trips end on the residential links.
    let ends_home = s
        .vehicles()
        .iter()
        .filter(|v| ["xr", "rx"].contains(&link_ids(&s, s.route_of(v)).last().unwrap().as_str()))
        .count();
    assert!(ends_home > 0);
    // Deterministic.
    let mut again = sim(&residential_street(), config);
    again.run(6000);
    assert_eq!(again.state_checksum(), s.state_checksum());
    assert!(
        SimConfig::from_json(r#"{"residential": {"classes": ["tram"]}}"#)
            .unwrap_err()
            .contains("unknown road class")
    );
    assert!(SimConfig::from_json(r#"{"residential": {"exitWeight": -1}}"#).is_err());
    assert!(SimConfig::from_json(r#"{"residential": {"inboundCurve": "x"}}"#).is_err());
}

#[test]
fn zones_also_parse_as_a_list() {
    let config = SimConfig::from_json(
        r#"{"zones": [{"id": "w", "nodes": ["n1"]}, {"id": "e", "nodes": ["n2"]}],
            "od": [{"from": "w", "to": "e", "vph": 600}]}"#,
    )
    .unwrap();
    assert_eq!(config.zones.len(), 2);
    assert!(Simulation::new(fixture_network(), config, 1).is_ok());
    let dup = SimConfig::from_json(r#"{"zones": [{"id": "w"}, {"id": "w"}]}"#);
    assert!(dup.is_err());
}

#[test]
fn zones_are_checked_against_the_network() {
    let build = |zones: &str| {
        let json = format!(r#"{{"zones": {zones}, "od": [{{"from": "a", "to": "b", "vph": 100}}]}}"#);
        Simulation::new(fixture_network(), SimConfig::from_json(&json).unwrap(), 1)
            .err()
            .unwrap_or_default()
    };
    assert!(build(r#"{"a": {"nodes": ["zz"]}, "b": {"nodes": ["n2"]}}"#).contains("unknown node 'zz'"));
    assert!(build(r#"{"a": {"links": ["zz"]}, "b": {"nodes": ["n2"]}}"#).contains("unknown link 'zz'"));
    assert!(build(r#"{"a": {}, "b": {"nodes": ["n2"]}}"#).contains("no origin links"));
    assert!(build(r#"{"a": {"nodes": ["n1"]}, "b": {}}"#).contains("no destination links"));
    assert_eq!(
        build(r#"{"a": {"nodes": ["n1"]}, "b": {"nodes": ["n2", "n0"]}}"#),
        ""
    );
}

// ---------------------------------------------------------------- #44 signals

fn refresh_signals(s: &mut Simulation) {
    s.net.signals.states_into(s.time, &mut s.signal_state);
}

#[test]
fn vehicles_stop_at_red_and_enter_only_on_green_or_amber() {
    let config = SimConfig {
        default_demand: Some(900.0),
        ..SimConfig::default()
    };
    let mut s = Simulation::new(fixture_network(), config, 11).unwrap();
    s.set_event_logging(true);
    let mut held_at_red = 0;
    for _ in 0..3600 {
        s.step();
        check_invariants(&mut s);
        let red: Vec<u8> = s.signal_states();
        for v in s.vehicles() {
            if v.stop_dist.is_finite() && s.network().is_lane(v.seg) && v.next_conn != NONE {
                let g = s.network().connectors[v.next_conn as usize].signal_group;
                if g != NONE && red[g as usize] == 0 {
                    held_at_red += 1;
                }
            }
        }
    }
    assert!(held_at_red > 100);
    let log = s.entry_log();
    assert!(log.len() > 150, "{}", log.len());
    for e in log {
        assert_ne!(e.signal, Some(SignalState::Red), "entry on red at t={}", e.time);
        assert!(e.signal.is_some());
    }
    assert!(
        log.iter().any(|e| e.signal == Some(SignalState::Amber)),
        "some vehicles decide to go at amber"
    );
    assert!(s.stats().arrived > 300);
}

#[test]
fn amber_dilemma_zone_rule() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    s.run(400); // t = 40 s: group n0:g0 turns amber
    let near = s.place_vehicle("l1", 0, 135.0, 13.0, "l2", car()).unwrap();
    let far = s.place_vehicle("l1", 1, 60.0, 13.0, "l2", car()).unwrap();
    s.rebuild_lists();
    refresh_signals(&mut s);
    assert_eq!(s.signal_states()[0], SignalState::Amber as u8);
    let idx = |id| s.vehicles().iter().position(|v| v.id == id).unwrap();
    let c0 = s.network().connector_index("c0").unwrap();
    let c1 = s.network().connector_index("c1").unwrap();
    // 5 m before the line at 13 m/s: braking distance 42 m > 5 m → go.
    assert_eq!(s.decide(idx(near), c0, 5.0, false), Decision::EnterNow);
    // 80 m before the line: a comfortable stop is possible → stop.
    assert_eq!(s.decide(idx(far), c1, 80.0, false), Decision::Stop);
    s.run(300);
    // The far vehicle waits at the red light.
    let v = vehicle(&s, far).unwrap();
    assert_eq!(link_of(&s, v), "l1");
    assert!(v.speed < 0.1);
    assert!(vehicle(&s, near).is_none_or(|v| link_of(&s, v) != "l1"));
}

#[test]
fn permissive_left_turn_yields_to_oncoming_traffic_on_green() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    s.set_event_logging(true);
    let net = s.network();
    let (c3, c4) = (
        net.connector_index("c3").unwrap(),
        net.connector_index("c4").unwrap(),
    );
    assert!(
        s.yields(c3, c4),
        "left turn yields to the opposing through movement"
    );
    assert!(!s.yields(c4, c3));
    let left = s.place_vehicle("l1", 1, 125.0, 0.0, "l8", car()).unwrap();
    // Arrives at the conflict zone about 3.5 s from now: less than the critical gap (#109).
    let oncoming = s.place_vehicle("l3", 0, 100.0, 13.0, "l4", car()).unwrap();
    run_checked(&mut s, 300);
    let log = s.entry_log();
    let t = |id| log.iter().find(|e| e.vehicle == id).map(|e| e.time).unwrap();
    assert!(t(oncoming) < t(left), "oncoming vehicle goes first");
}

// ---------------------------------------------------------------- #45 unsignalised junctions

#[test]
fn minor_road_waits_for_a_gap_in_major_traffic() {
    let b = t_junction(Priority::Minor);
    let mut s = sim(&b, quiet());
    s.set_event_logging(true);
    let minor = s.place_vehicle("sj", 0, 280.0, 0.0, "je", car()).unwrap();
    // Reaches the conflict zone about 4 s from now, before the minor vehicle could (#109).
    let major = s.place_vehicle("we", 0, 250.0, 13.0, "je", car()).unwrap();
    run_checked(&mut s, 400);
    let log = s.entry_log();
    let t = |id| log.iter().find(|e| e.vehicle == id).map(|e| e.time).unwrap();
    assert!(t(major) < t(minor), "major vehicle has priority");
    s.run(600);
    assert_eq!(s.stats().arrived, 2);
}

#[test]
fn minor_road_enters_when_the_major_road_is_far_away() {
    let b = t_junction(Priority::Minor);
    let mut s = sim(&b, quiet());
    s.set_event_logging(true);
    let minor = s.place_vehicle("sj", 0, 280.0, 0.0, "je", car()).unwrap();
    let major = s.place_vehicle("we", 0, 0.0, 0.0, "je", car()).unwrap();
    run_checked(&mut s, 400);
    let log = s.entry_log();
    let t = |id| log.iter().find(|e| e.vehicle == id).map(|e| e.time).unwrap();
    assert!(t(minor) < t(major), "a large gap is accepted");
}

#[test]
fn stop_sign_requires_a_full_stop() {
    let b = t_junction(Priority::Stop);
    let mut s = sim(&b, quiet());
    s.set_event_logging(true);
    let id = s.place_vehicle("sj", 0, 200.0, 10.0, "je", car()).unwrap();
    let mut min_speed_before_claim = f64::INFINITY;
    for _ in 0..600 {
        s.step();
        check_invariants(&mut s);
        if let Some(v) = vehicle(&s, id)
            && link_of(&s, v) == "sj"
            && s.network().is_lane(v.seg)
            && v.claimed == NONE
            && v.pos > 250.0
        {
            min_speed_before_claim = min_speed_before_claim.min(v.speed);
        }
    }
    assert!(min_speed_before_claim < 0.3, "{min_speed_before_claim}");
    assert_eq!(s.entry_log().len(), 1);
    assert_eq!(s.stats().arrived, 1);
}

#[test]
fn major_left_turn_yields_to_oncoming_major_traffic() {
    let b = t_junction(Priority::Minor);
    let s = sim(&b, quiet());
    let net = s.network();
    let c = |id| net.connector_index(id).unwrap();
    assert!(s.yields(c("ew_s"), c("we_e")));
    assert!(!s.yields(c("we_e"), c("ew_s")));
    assert!(s.yields(c("sj_w"), c("ew_w")));
    assert!(!s.yields(c("ew_w"), c("sj_w")));
    assert!(
        s.yields(c("ew_s"), c("we_s")),
        "left turn yields to the oncoming right turn"
    );
    assert!(!s.yields(c("we_s"), c("ew_s")));
}

#[test]
fn right_before_left_at_equal_priority() {
    let b = crossroads(
        NodeControl::RightBeforeLeft,
        Priority::RightBeforeLeft,
        Priority::RightBeforeLeft,
    );
    let s = sim(&b, quiet());
    let net = s.network();
    let c = |id| net.connector_index(id).unwrap();
    // From W heading east, traffic from S (heading north) comes from the right.
    assert!(s.yields(c("WE"), c("SN")));
    assert!(!s.yields(c("SN"), c("WE")));
    // Oncoming left turn yields to through traffic.
    assert!(s.yields(c("WN"), c("EW")));
    assert!(!s.yields(c("EW"), c("WN")));
    // Signal priority over unsignalised movements in mixed control.
    let mut mixed = crossroads(NodeControl::Signal, Priority::Major, Priority::Minor);
    mixed.signal("C", 60.0, &[("g", 0.0, 30.0, 3.0)]);
    mixed.connector_mut("WE").priority = Priority::Signal;
    mixed.connector_mut("WE").signal_group = Some("g".into());
    let s = sim(&mixed, quiet());
    let net = s.network();
    let c = |id| net.connector_index(id).unwrap();
    assert!(s.yields(c("SN"), c("WE")));
    assert!(!s.yields(c("WE"), c("SN")));
}

#[test]
fn right_before_left_junction_never_deadlocks() {
    let b = crossroads(
        NodeControl::RightBeforeLeft,
        Priority::RightBeforeLeft,
        Priority::RightBeforeLeft,
    );
    let mut s = sim(&b, with_demand(200.0));
    run_checked(&mut s, 6000);
    let stats = s.stats();
    assert!(stats.arrived > 100, "{stats:?}");
    let a = stats.arrived;
    s.run(1200);
    assert!(s.stats().arrived > a + 20, "traffic keeps flowing");
}

#[test]
fn deadlock_breaker_forces_entry_after_max_wait() {
    let b = t_junction(Priority::Minor);
    // An impatient-proof critical gap: the crawling major vehicle is always "too close".
    let mut s = sim(
        &b,
        SimConfig {
            junction: crate::config::JunctionConfig {
                max_wait: 5.0,
                critical_gap_minor: 100.0,
                ..Default::default()
            },
            ..quiet()
        },
    );
    let minor = s.place_vehicle("sj", 0, 285.0, 0.0, "je", car()).unwrap();
    // A crawling major vehicle near the junction keeps the gap "too small" for a long time.
    s.place_vehicle("we", 0, 287.0, 0.0, "je", crawler()).unwrap();
    s.rebuild_lists();
    refresh_signals(&mut s);
    let i = s.vehicles().iter().position(|v| v.id == minor).unwrap();
    let c = s.network().connector_index("sj_e").unwrap();
    assert_eq!(s.decide(i, c, 5.0, false), Decision::Stop);
    assert_eq!(s.decide(i, c, 5.0, true), Decision::Enter);
    s.run(900);
    assert_eq!(s.stats().forced_entries, 1, "{:?}", s.stats());
}

#[test]
fn follow_up_time_spaces_consecutive_minor_entries() {
    let b = t_junction(Priority::Minor);
    let mut s = sim(
        &b,
        SimConfig {
            demand: BTreeMap::from([("S".to_string(), 3000.0), ("W".to_string(), 200.0)]),
            ..quiet()
        },
    );
    s.set_event_logging(true);
    run_checked(&mut s, 3000);
    let net = s.network();
    let minor: Vec<f64> = s
        .entry_log()
        .iter()
        .filter(|e| net.connectors[e.connector as usize].from_link == net.link_index("sj").unwrap())
        .map(|e| e.time)
        .collect();
    assert!(minor.len() > 20);
    for w in minor.windows(2) {
        assert!(w[1] - w[0] >= 2.0 - 1e-9, "follow-up {}", w[1] - w[0]);
    }
}

#[test]
fn busy_t_junction_keeps_conflicts_exclusive() {
    let b = t_junction(Priority::Minor);
    let mut s = sim(&b, with_demand(300.0));
    run_checked(&mut s, 6000);
    let stats = s.stats();
    assert!(stats.arrived > 120, "{stats:?}");
    assert!(stats.mean_travel_time < 70.0, "{stats:?}");
}

// ---------------------------------------------------------------- #109 conflict zones

/// Index of vehicle `id` after refreshing the occupant lists and signal aspects.
fn prepare(s: &mut Simulation, id: u32) -> usize {
    s.rebuild_lists();
    refresh_signals(s);
    s.vehicles().iter().position(|v| v.id == id).unwrap()
}

/// Moves vehicle `id` (placed on the lane before `conn`) onto connector `conn` at `pos`.
fn put_on_connector(s: &mut Simulation, id: u32, conn: &str, pos: f64) {
    let c = s.network().connector_index(conn).unwrap();
    let (seg, from) = (
        s.network().connector_segment(c),
        s.network().connectors[c as usize].from_lane,
    );
    let v = s.vehicles.iter_mut().find(|v| v.id == id).unwrap();
    assert_eq!(v.next_conn, c);
    (v.prev_seg, v.seg, v.pos) = (from, seg, pos);
    v.route_pos += 1;
    v.next_conn = NONE;
}

#[test]
fn minor_vehicle_may_enter_while_a_major_vehicle_is_still_on_the_merge() {
    let b = t_junction(Priority::Minor);
    let mut s = sim(&b, quiet());
    // Waiting at the line (2.5 m before it) to turn right into the major road.
    let minor = s.place_vehicle("sj", 0, 289.5, 0.0, "je", car()).unwrap();
    let major = s.place_vehicle("we", 0, 291.0, 13.0, "je", car()).unwrap();
    put_on_connector(&mut s, major, "we_e", 3.0);
    let c = s.network().connector_index("sj_e").unwrap();
    let i = prepare(&mut s, minor);
    // The point model blocked the merge until the major vehicle had left the connector; with
    // zones, the minor vehicle can follow it once it entered the merge first.
    assert_eq!(s.decide(i, c, 2.5, false), Decision::Enter);
    let net = s.network().clone();
    let (we_e, sj_e) = (net.connector_index("we_e").unwrap(), c);
    let len = net.seg_length[net.connector_segment(sj_e) as usize];
    let theirs = net.conflict_zone(we_e, sj_e).unwrap();
    // A follower on the merging connector sees the major vehicle as its leader once it is
    // inside its merge zone.
    assert_eq!(s.merging_leader(sj_e, len, i as u32), None, "not in the zone yet");
    let v = s.vehicles.iter_mut().find(|v| v.id == major).unwrap();
    v.pos = theirs.0 + 1.0;
    let rem = net.seg_length[net.connector_segment(we_e) as usize] - theirs.0 - 1.0;
    let (j, gap) = s.merging_leader(sj_e, len, i as u32).unwrap();
    assert_eq!(s.vehicles[j as usize].id, major);
    assert!((gap - (len - rem - 4.5)).abs() < 1e-9, "{gap}");
}

#[test]
fn crossing_waits_until_a_committed_vehicle_will_have_cleared_the_zone() {
    let b = crossroads(NodeControl::Priority, Priority::Major, Priority::Minor);
    let mut s = sim(&b, quiet());
    let minor = s.place_vehicle("Sin", 0, 239.5, 0.0, "Nout", car()).unwrap();
    let slow = s.place_vehicle("Win", 0, 241.0, 0.5, "Eout", crawler()).unwrap();
    let net = s.network();
    let (sn, we) = (
        net.connector_index("SN").unwrap(),
        net.connector_index("WE").unwrap(),
    );
    let zone = net.conflict_zone(we, sn).unwrap();
    // A crawler still far from the zone can be passed before it gets there...
    put_on_connector(&mut s, slow, "WE", 0.5);
    let i = prepare(&mut s, minor);
    assert!(s.zone_clear(i, sn, 2.5, we));
    // ...one inside it blocks the zone for long.
    s.vehicles.iter_mut().find(|v| v.id == slow).unwrap().pos = zone.0 + 1.0;
    let i = prepare(&mut s, minor);
    assert!(!s.zone_clear(i, sn, 2.5, we));
    assert_eq!(s.decide(i, sn, 2.5, false), Decision::Stop);
    // Past the zone (rear beyond its exit) the crawler no longer matters.
    s.vehicles.iter_mut().find(|v| v.id == slow).unwrap().pos = zone.1 + 4.6;
    let i = prepare(&mut s, minor);
    assert!(s.zone_clear(i, sn, 2.5, we));
    assert_eq!(s.decide(i, sn, 2.5, false), Decision::Enter);
    // A fast vehicle that has just entered the junction clears the zone before the waiting
    // vehicle could reach it (with the clearance time to spare).
    let fast = s.place_vehicle("Win", 0, 241.0, 13.0, "Eout", car()).unwrap();
    put_on_connector(&mut s, fast, "WE", 0.5);
    let i = prepare(&mut s, minor);
    assert!(s.zone_clear(i, sn, 2.5, we));
}

#[test]
fn committed_vehicles_hold_before_an_occupied_crossing_zone() {
    let b = crossroads(NodeControl::Priority, Priority::Major, Priority::Minor);
    let mut s = sim(&b, quiet());
    let stuck = s.place_vehicle("Win", 0, 241.0, 0.0, "Eout", crawler()).unwrap();
    let net = s.network();
    let (sn, we) = (
        net.connector_index("SN").unwrap(),
        net.connector_index("WE").unwrap(),
    );
    let zone = net.conflict_zone(we, sn).unwrap();
    put_on_connector(&mut s, stuck, "WE", zone.0 + 1.0);
    let mover = s.place_vehicle("Sin", 0, 230.0, 5.0, "Nout", car()).unwrap();
    let i = prepare(&mut s, mover);
    // Committed (claimed) before the crawler appeared.
    s.vehicles[i].claimed = sn;
    s.conn_claims[sn as usize] += 1;
    let mine = s.network().conflict_zone(sn, we).unwrap();
    let hold = s.zone_hold(i);
    assert!((hold - (242.0 - 230.0 + mine.0)).abs() < 1e-9, "{hold}");
    for _ in 0..200 {
        s.step();
        check_invariants(&mut s);
        let v = vehicle(&s, stuck).unwrap();
        // Keep the crawler inside the zone.
        if v.pos > zone.0 + 2.0 {
            s.vehicles.iter_mut().find(|v| v.id == stuck).unwrap().pos = zone.0 + 1.0;
        }
    }
    let v = vehicle(&s, mover).unwrap();
    assert!(v.speed < 0.1, "{v:?}");
    assert_ne!(v.flags & flags::YIELDING, 0);
}

#[test]
fn roundabout_entries_never_fill_the_ring_link() {
    let b = roundabout();
    let mut s = sim(&b, quiet());
    let entry = s.place_vehicle("in0", 0, 191.5, 0.0, "out1", car()).unwrap();
    let e0 = s.network().connector_index("e0").unwrap();
    let ring_len = s.network().seg_length[s
        .network()
        .link_lane(s.network().link_index("ring0").unwrap(), 0)
        .unwrap() as usize];
    let i = prepare(&mut s, entry);
    assert!(s.exit_space_ok(e0, i));
    // A stopped truck leaves room for the entering car at the start of the ring link, but the
    // ring link would be full afterwards.
    let truck = VehicleParams {
        length: ring_len - 6.5 - 1.0,
        ..crawler()
    };
    s.place_vehicle("ring0", 0, ring_len - 1.0, 0.0, "out1", truck)
        .unwrap();
    let i = prepare(&mut s, entry);
    assert!(!s.exit_space_ok(e0, i));
}

/// #120: Krems, Bertschingerstrasse: two roundabout arms a metre apart leave a 1 m ring link.
/// The entry must count the ring link after it, or it never gets in.
#[test]
fn roundabout_entry_onto_a_one_metre_ring_link() {
    let mut b = NetBuilder::new();
    let v = 8.0;
    b.node("R1", 0.0, 0.0, NodeControl::Roundabout)
        .node("R2", 17.0, 0.0, NodeControl::Roundabout)
        .node("W", -300.0, 0.0, NodeControl::Boundary)
        .node("E", 317.0, 0.0, NodeControl::Boundary)
        .node("S", 0.0, -300.0, NodeControl::Boundary)
        .link("w", "W", "R1", 1, v)
        .link("r", "R1", "R2", 1, v)
        .link("e", "R2", "E", 1, v)
        .link("s", "S", "R1", 1, v)
        .connect("ring_in", "w", 0, "r", 0, Priority::RoundaboutRing)
        .connect("entry", "s", 0, "r", 0, Priority::RoundaboutEntry)
        .connect("ring_on", "r", 0, "e", 0, Priority::RoundaboutRing)
        .conflict("entry", "ring_in");
    let mut s = sim(&b, quiet());
    s.set_event_logging(true);
    let ring = s
        .network()
        .link_lane(s.network().link_index("r").unwrap(), 0)
        .unwrap();
    assert!(s.network().seg_length[ring as usize] < 2.0);
    let entry = s.place_vehicle("s", 0, 291.5, 0.0, "e", car()).unwrap();
    let c = s.network().connector_index("entry").unwrap();
    let i = prepare(&mut s, entry);
    assert!(s.exit_space_ok(c, i), "the ring beyond the 1 m link is empty");
    run_checked(&mut s, 300);
    assert!(
        s.entry_log()
            .iter()
            .any(|e| e.vehicle == entry && e.connector == c),
        "the entry got in"
    );
    // A car standing on the 1 m link itself still blocks the entry.
    let mut s = sim(&b, quiet());
    s.place_vehicle("r", 0, 1.0, 0.0, "e", crawler()).unwrap();
    let entry = s.place_vehicle("s", 0, 291.5, 0.0, "e", car()).unwrap();
    let i = prepare(&mut s, entry);
    assert!(!s.exit_space_ok(c, i));
}

// ---------------------------------------------------------------- #46 MOBIL lane changes

fn overtaking(allow_left: bool) -> Simulation {
    let mut b = corridor(2, 1000.0, 15.0);
    for id in ["up", "down"] {
        b.link_mut(id).boundaries[0].allow_left = allow_left;
    }
    let mut s = sim(&b, quiet());
    s.set_event_logging(true);
    let slow = VehicleParams {
        max_speed: 5.0,
        ..car()
    };
    s.place_vehicle("up", 0, 100.0, 5.0, "down", slow).unwrap();
    s.place_vehicle("up", 0, 20.0, 15.0, "down", car()).unwrap();
    s
}

#[test]
fn fast_vehicle_overtakes_a_slow_one() {
    let mut s = overtaking(true);
    run_checked(&mut s, 600);
    let log = s.lane_change_log();
    assert!(!log.is_empty());
    assert_eq!((log[0].vehicle, log[0].from_index, log[0].to_index), (1, 0, 1));
    assert!(!log[0].mandatory);
    let (slow, fast) = (vehicle(&s, 0).unwrap(), vehicle(&s, 1).unwrap());
    let ahead = link_of(&s, fast) == "down" && link_of(&s, slow) == "up" || fast.pos > slow.pos;
    assert!(ahead, "the fast vehicle passed");
}

#[test]
fn solid_line_prevents_overtaking() {
    let mut s = overtaking(false);
    run_checked(&mut s, 600);
    assert!(s.lane_change_log().is_empty());
    assert_eq!(s.stats().lane_changes, 0);
}

#[test]
fn mandatory_change_reaches_the_turn_lane_before_the_solid_zone() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    s.set_event_logging(true);
    // Lane 0 of l1 has no connector to l8 (left turn), lane 1 has.
    let id = s.place_vehicle("l1", 0, 0.0, 10.0, "l8", car()).unwrap();
    run_checked(&mut s, 1200);
    let log = s.lane_change_log();
    let e = log.iter().find(|e| e.vehicle == id).expect("lane change");
    assert!(e.mandatory);
    assert_eq!((e.from_index, e.to_index), (0, 1));
    assert!(e.pos < 140.0 - 30.0);
    assert_eq!(s.stats().arrived, 1);
    assert_eq!(s.stats().rerouted, 0);
}

#[test]
fn blocked_mandatory_change_reroutes_from_the_current_lane() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    s.set_event_logging(true);
    // l3 has solid_dashed: lane 1 may not change right. Lane 0 is needed for the right turn
    // to l8 (c7), so a vehicle in lane 1 must re-route (through to l4 or left to l6).
    let id = s.place_vehicle("l3", 1, 0.0, 10.0, "l8", car()).unwrap();
    let mut links = Vec::new();
    for _ in 0..1500 {
        s.step();
        check_invariants(&mut s);
        if let Some(v) = vehicle(&s, id) {
            let l = link_of(&s, v);
            if links.last() != Some(&l) {
                links.push(l);
            }
        }
    }
    assert!(s.lane_change_log().iter().all(|e| e.vehicle != id));
    assert_eq!(s.stats().rerouted, 1);
    assert_eq!(s.stats().arrived, 1);
    assert_ne!(links.last().unwrap(), "l8");
}

#[test]
fn lane_without_any_way_on_strands_the_vehicle() {
    // Only lane 0 continues; lane 1 is a dead end separated by a solid line.
    let mut b = corridor(2, 300.0, 15.0);
    b.package.connectors.retain(|c| c.id == "c0");
    b.link_mut("up").boundaries[0].allow_right = false;
    let mut s = sim(&b, quiet());
    s.place_vehicle("up", 1, 0.0, 10.0, "down", car()).unwrap();
    run_checked(&mut s, 800);
    let stats = s.stats();
    assert_eq!(
        (stats.rerouted, stats.stranded, stats.arrived, stats.active),
        (1, 1, 0, 0)
    );
}

#[test]
fn keep_right_bias_on_motorways() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    s.set_event_logging(true);
    // l9 is a motorway: a lone vehicle on the left lane returns to the right lane.
    s.place_vehicle("l9", 1, 0.0, 25.0, "l9", car()).unwrap();
    // l2 is a primary road: no bias, the vehicle stays.
    s.place_vehicle("l2", 1, 0.0, 13.0, "l2", car()).unwrap();
    while s.lane_change_log().is_empty() && s.steps() < 100 {
        s.step();
    }
    let v = vehicle(&s, 0).unwrap();
    assert_ne!(v.flags & flags::CHANGING_LANE, 0);
    assert!(
        v.lat_offset > 0.0,
        "drawn left of the new lane centre while moving right"
    );
    run_checked(&mut s, 100);
    let log = s.lane_change_log();
    assert_eq!(log.len(), 1);
    assert_eq!((log[0].vehicle, log[0].from_index, log[0].to_index), (0, 1, 0));
    assert_eq!(vehicle(&s, 0).unwrap().lat_offset, 0.0);
}

// ---------------------------------------------------------------- #108 continuous lane changes

fn lanes_of(s: &Simulation, link: &str) -> (u32, u32) {
    let net = s.network();
    let l = net.link_index(link).unwrap();
    (net.link_lane(l, 0).unwrap(), net.link_lane(l, 1).unwrap())
}

fn snapshot_of(s: &Simulation, id: u32) -> [f32; SNAPSHOT_STRIDE] {
    let snap = s.snapshot();
    let k = s.vehicles().iter().position(|v| v.id == id).unwrap();
    snap[k * SNAPSHOT_STRIDE..(k + 1) * SNAPSHOT_STRIDE]
        .try_into()
        .unwrap()
}

#[test]
fn lane_changes_take_their_duration_and_occupy_both_lanes() {
    let mut s = overtaking(true);
    let (lane0, lane1) = lanes_of(&s, "up");
    while s.lane_change_log().is_empty() {
        s.step();
        check_invariants(&mut s);
    }
    let start = s.time();
    let v = vehicle(&s, 1).unwrap();
    assert_eq!((v.seg, v.lc_from), (lane1, lane0));
    assert!(v.lc_progress > 0.0 && v.lc_progress < 0.1);
    assert_ne!(v.flags & flags::CHANGING_LANE, 0);
    let duration = s.config().lane_change.duration_at(v.speed);
    assert!(duration > 2.9, "{duration}");
    // The vehicle is listed on its target lane and as a shadow on its source lane.
    s.rebuild_lists();
    assert_eq!(s.seg_shadows[lane0 as usize], [1]);
    let y = |s: &Simulation| f64::from(snapshot_of(s, 1)[1]);
    let heading = |s: &Simulation| f64::from(snapshot_of(s, 1)[3]);
    let mut last_y = y(&s);
    assert!(
        (last_y - -4.875).abs() < 0.1,
        "starts near the centre of lane 0: {last_y}"
    );
    let mut max_heading: f64 = 0.0;
    while vehicle(&s, 1).unwrap().lc_from != NONE {
        s.step();
        check_invariants(&mut s);
        let now = y(&s);
        assert!(
            now >= last_y - 1e-6 && now - last_y < 0.3,
            "smooth lateral motion {last_y} -> {now}"
        );
        max_heading = max_heading.max(heading(&s));
        last_y = now;
        assert!(s.time() - start < duration + 0.2, "change takes too long");
    }
    assert!(
        s.time() - start > duration - 0.2,
        "change ended after {}",
        s.time() - start
    );
    assert!(
        max_heading > 0.05,
        "heading turns left while moving left: {max_heading}"
    );
    assert!(
        (last_y - -1.625).abs() < 1e-3,
        "ends on the lane 1 centre: {last_y}"
    );
    let v = vehicle(&s, 1).unwrap();
    assert_eq!((v.lat_offset, v.flags & flags::CHANGING_LANE), (0.0, 0));
    assert_eq!(s.lane_change_log().len(), 1, "no second change while changing");
}

#[test]
fn followers_on_the_source_lane_brake_for_a_changing_vehicle() {
    let mut b = corridor(2, 1000.0, 15.0);
    b.link_mut("up").boundaries[0].allow_right = false;
    let config = SimConfig {
        lane_change: crate::config::LaneChangeConfig {
            duration: 8.0,
            min_duration: 8.0,
            ..Default::default()
        },
        ..quiet()
    };
    let mut s = sim(&b, config);
    s.set_event_logging(true);
    let (lane0, _) = lanes_of(&s, "up");
    let slow = VehicleParams {
        max_speed: 4.0,
        ..car()
    };
    let stay = VehicleParams {
        lane_change_threshold: 1000.0,
        ..car()
    };
    s.place_vehicle("up", 0, 160.0, 4.0, "down", slow).unwrap();
    let changer = s.place_vehicle("up", 0, 120.0, 6.0, "down", car()).unwrap();
    let follower = s.place_vehicle("up", 0, 70.0, 15.0, "down", stay).unwrap();
    let mut compared = false;
    for _ in 0..400 {
        s.step();
        check_invariants(&mut s);
        let c = vehicle(&s, changer).unwrap();
        if c.lc_from == lane0 && !compared {
            // The follower's IDM leader is the shadow: without it, it would brake less.
            compared = true;
            s.rebuild_lists();
            let f = s.vehicles().iter().position(|v| v.id == follower).unwrap();
            let with_shadow = s.acceleration(f);
            let shadows = std::mem::take(&mut s.seg_shadows[lane0 as usize]);
            let without = s.acceleration(f);
            s.seg_shadows[lane0 as usize] = shadows;
            assert!(with_shadow < without - 0.3, "{with_shadow} vs {without}");
        }
    }
    assert!(compared);
    assert_eq!(s.lane_change_log().len(), 1);
}

#[test]
fn lane_change_aborts_when_a_conflict_appears_in_the_first_half() {
    for (late, aborted) in [(false, 1), (true, 0)] {
        let mut s = overtaking(true);
        let (lane0, lane1) = lanes_of(&s, "up");
        while s.lane_change_log().is_empty() {
            s.step();
        }
        let progress = if late { 0.5 } else { 0.3 };
        while vehicle(&s, 1).unwrap().lc_progress < progress {
            s.step();
        }
        let pos = vehicle(&s, 1).unwrap().pos;
        // A fast vehicle appears close behind on the target lane.
        s.place_vehicle("up", 1, pos - 6.5, 15.0, "down", car()).unwrap();
        s.step();
        check_invariants(&mut s);
        let v = vehicle(&s, 1).unwrap();
        assert_eq!(s.stats().lane_change_aborts, aborted, "late={late}");
        if aborted == 1 {
            assert_eq!((v.seg, v.lc_from), (lane0, lane1), "back towards lane 0");
            assert!(v.lc_progress > 0.5 && v.lat_offset > 0.0);
            run_checked(&mut s, 40);
            let v = vehicle(&s, 1).unwrap();
            assert_eq!((v.seg, v.lc_from), (lane0, NONE));
        } else {
            assert_eq!((v.seg, v.lc_from), (lane1, lane0), "finishes the change");
        }
    }
}

#[test]
fn zero_duration_keeps_instantaneous_lane_changes() {
    let mut b = corridor(2, 1000.0, 15.0);
    b.link_mut("up").boundaries[0].allow_left = true;
    let config = SimConfig {
        lane_change: crate::config::LaneChangeConfig {
            duration: 0.0,
            ..Default::default()
        },
        ..quiet()
    };
    let mut s = sim(&b, config);
    s.set_event_logging(true);
    let slow = VehicleParams {
        max_speed: 5.0,
        ..car()
    };
    s.place_vehicle("up", 0, 100.0, 5.0, "down", slow).unwrap();
    s.place_vehicle("up", 0, 20.0, 15.0, "down", car()).unwrap();
    while s.lane_change_log().is_empty() {
        s.step();
    }
    let v = vehicle(&s, 1).unwrap();
    assert_eq!(v.lc_from, NONE);
    assert!(v.lat_offset < 0.0);
    assert_ne!(v.flags & flags::CHANGING_LANE, 0);
    run_checked(&mut s, 40);
    assert_eq!(vehicle(&s, 1).unwrap().lat_offset, 0.0);
}

// ---------------------------------------------------------------- #97 markings, roundabouts, bridges

#[test]
fn lane_changes_obey_boundaries_and_no_change_zones() {
    let config = SimConfig {
        default_demand: Some(900.0),
        ..SimConfig::default()
    };
    let mut s = Simulation::new(fixture_network(), config, 2).unwrap();
    s.set_event_logging(true);
    run_checked(&mut s, 6000);
    let net = s.network();
    let log = s.lane_change_log();
    assert!(log.len() > 50, "{}", log.len());
    for e in log {
        let link = &net.links[e.link as usize];
        let from = &net.lanes[(link.first_lane + e.from_index) as usize];
        let allowed = if e.to_index > e.from_index {
            from.can_change_left
        } else {
            from.can_change_right
        };
        assert!(allowed, "{} crossed a solid boundary", link.id);
        assert_eq!(e.from_index.abs_diff(e.to_index), 1);
        assert!(
            e.pos < link.length - link.no_lane_change_zone,
            "lane change inside the zone"
        );
        assert!(
            !(link.id == "l3" && e.from_index == 1 && e.to_index == 0),
            "l3 lane 1 may not change right"
        );
    }
}

#[test]
fn roundabout_entries_yield_to_circulating_traffic() {
    let b = roundabout();
    let mut s = sim(&b, quiet());
    s.set_event_logging(true);
    let net = s.network().clone();
    let c = |id: &str| net.connector_index(id).unwrap();
    assert!(s.yields(c("e1"), c("t1")));
    assert!(!s.yields(c("t1"), c("e1")));
    // Ring vehicle on ring0 (rE → rN) heading through rN, entry vehicle waiting at in1 (from N).
    let ring = s.place_vehicle("ring0", 0, 5.0, 8.0, "out2", car()).unwrap();
    let entry = s.place_vehicle("in1", 0, 191.0, 0.0, "out3", car()).unwrap();
    run_checked(&mut s, 200);
    let log = s.entry_log();
    let t = |id: u32, conn: &str| {
        log.iter()
            .find(|e| e.vehicle == id && e.connector == c(conn))
            .map(|e| e.time)
    };
    assert!(t(ring, "t1").unwrap() < t(entry, "e1").unwrap());
}

#[test]
fn busy_roundabout_flows_without_conflicts() {
    let b = roundabout();
    let mut s = sim(&b, with_demand(300.0));
    run_checked(&mut s, 6000);
    let stats = s.stats();
    assert!(stats.arrived > 150, "{stats:?}");
    assert!(stats.mean_travel_time < 70.0, "{stats:?}");
    assert_eq!(stats.stranded, 0);
}

/// #116: OSM splits roads at every node, so exit lanes of a few metres are common. A yielding
/// merge may enter such a lane while it is empty, even though the lane cannot also hold the
/// prioritised vehicle about to merge; once the lane is occupied, the merge waits.
#[test]
fn yielding_merge_may_enter_a_short_empty_exit_lane() {
    let mut b = NetBuilder::new();
    let v = 13.889;
    // The exit link "je" is 11 m long (junction trim 8 m).
    b.node("J", 0.0, 0.0, NodeControl::Priority)
        .node("W", -300.0, 0.0, NodeControl::Boundary)
        .node("E", 19.0, 0.0, NodeControl::Boundary)
        .node("S", 0.0, -300.0, NodeControl::Boundary)
        .link("we", "W", "J", 1, v)
        .link("je", "J", "E", 1, v)
        .link("sj", "S", "J", 1, v)
        .connect("we_e", "we", 0, "je", 0, Priority::Major)
        .connect("sj_e", "sj", 0, "je", 0, Priority::Minor)
        .conflict("sj_e", "we_e");
    let mut s = sim(&b, quiet());
    let minor = s.place_vehicle("sj", 0, 289.5, 0.0, "je", car()).unwrap();
    // A major vehicle queued 20 m before its line: the merge keeps room for it.
    s.place_vehicle("we", 0, 272.0, 0.0, "je", car()).unwrap();
    let c = s.network().connector_index("sj_e").unwrap();
    let i = prepare(&mut s, minor);
    assert!(s.exit_space_ok(c, i), "an empty lane always has room");
    s.place_vehicle("je", 0, 8.0, 0.0, "je", car()).unwrap();
    let i = prepare(&mut s, minor);
    assert!(!s.exit_space_ok(c, i), "the merge must not fill an occupied lane");
}

/// #117: two signal nodes 18 m apart leave a 2 m link between them (e.g. a side road crossing a
/// dual carriageway). A vehicle that gets green at the first one but red at the second must wait
/// at the first stop line, not inside the junction, and then pass both without stopping.
#[test]
fn chained_junctions_are_entered_only_when_all_can_be_passed() {
    let mut b = NetBuilder::new();
    let v = 13.889;
    b.node("J1", 0.0, 0.0, NodeControl::Signal)
        .node("J2", 18.0, 0.0, NodeControl::Signal)
        .node("W", -300.0, 0.0, NodeControl::Boundary)
        .node("E", 318.0, 0.0, NodeControl::Boundary)
        .link("we", "W", "J1", 1, v)
        .link("mid", "J1", "J2", 1, v)
        .link("je", "J2", "E", 1, v)
        .connect("c1", "we", 0, "mid", 0, Priority::Signal)
        .connect("c2", "mid", 0, "je", 0, Priority::Signal)
        .signal("J1", 60.0, &[("g1", 0.0, 60.0, 3.0)])
        .signal("J2", 60.0, &[("g2", 30.0, 55.0, 3.0)]);
    b.connector_mut("c1").signal_group = Some("g1".into());
    b.connector_mut("c2").signal_group = Some("g2".into());
    let mut s = sim(&b, quiet());
    assert!(
        s.network().seg_length[s
            .network()
            .link_lane(s.network().link_index("mid").unwrap(), 0)
            .unwrap() as usize]
            < 3.0
    );
    let id = s.place_vehicle("we", 0, 200.0, 10.0, "je", car()).unwrap();
    while s.time < 29.0 {
        s.step();
        let v = vehicle(&s, id).unwrap();
        assert_eq!(link_of(&s, v), "we", "t = {}", s.time);
        assert!(s.network().is_lane(v.seg));
    }
    // Green at both: passes the two junctions without stopping in between.
    while let Some(v) = vehicle(&s, id) {
        if link_of(&s, v) == "je" {
            break;
        }
        if !s.network().is_lane(v.seg) || link_of(&s, v) == "mid" {
            assert!(v.speed > 1.0, "stopped inside the junction at t = {}", s.time);
        }
        s.step();
        assert!(s.time < 60.0);
    }
}

/// #126: B3 in Krems: two chained signals that are never green together. The vehicle gives up on
/// the chain after twice `maxWait` and waits at the second stop line instead of forever at the first.
#[test]
fn chained_signals_never_green_together_do_not_hold_a_vehicle_forever() {
    let mut b = NetBuilder::new();
    let v = 13.889;
    b.node("J1", 0.0, 0.0, NodeControl::Signal)
        .node("J2", 18.0, 0.0, NodeControl::Signal)
        .node("W", -300.0, 0.0, NodeControl::Boundary)
        .node("E", 318.0, 0.0, NodeControl::Boundary)
        .link("we", "W", "J1", 1, v)
        .link("mid", "J1", "J2", 1, v)
        .link("je", "J2", "E", 1, v)
        .connect("c1", "we", 0, "mid", 0, Priority::Signal)
        .connect("c2", "mid", 0, "je", 0, Priority::Signal)
        .signal("J1", 90.0, &[("g1", 0.0, 40.0, 3.0)])
        .signal("J2", 90.0, &[("g2", 45.0, 85.0, 3.0)]);
    b.connector_mut("c1").signal_group = Some("g1".into());
    b.connector_mut("c2").signal_group = Some("g2".into());
    let mut s = sim(&b, quiet());
    let id = s.place_vehicle("we", 0, 250.0, 0.0, "je", car()).unwrap();
    while vehicle(&s, id).is_some_and(|v| link_of(&s, v) != "je") {
        s.step();
        assert!(s.time < 300.0, "still waiting for both signals at t = {}", s.time);
    }
}

/// #126: a vehicle standing still inside a junction for `junction.stuckTimeout` is taken out, so a
/// gridlock among the inner links of a junction dissolves; vehicles on lanes are kept.
#[test]
fn vehicles_stuck_inside_a_junction_are_taken_out() {
    let mut b = NetBuilder::new();
    b.node("W", -300.0, 0.0, NodeControl::Boundary)
        .node("J", 0.0, 0.0, NodeControl::Priority)
        .node("E", 300.0, 0.0, NodeControl::Boundary)
        .link("in", "W", "J", 1, 13.9)
        .link("out", "J", "E", 1, 13.9)
        .connect("go", "in", 0, "out", 0, Priority::Major);
    let mut config = quiet();
    config.junction.stuck_timeout = 20.0;
    let mut s = sim(&b, config);
    // Gridlock: a vehicle that cannot move on right behind the junction.
    let blocker = s.place_vehicle("out", 0, 4.0, 0.0, "out", crawler()).unwrap();
    let inside = s.place_vehicle("in", 0, 291.0, 0.0, "out", car()).unwrap();
    put_on_connector(&mut s, inside, "go", 6.0);
    let waiting = s.place_vehicle("in", 0, 200.0, 0.0, "out", car()).unwrap();
    let hold = |s: &mut Simulation| {
        if let Some(v) = s.vehicles.iter_mut().find(|v| v.id == blocker) {
            (v.pos, v.speed) = (4.0, 0.0);
        }
    };
    while s.time < 15.0 {
        s.step();
        hold(&mut s);
    }
    assert!(vehicle(&s, inside).is_some());
    while s.time < 40.0 {
        s.step();
        hold(&mut s);
    }
    assert!(vehicle(&s, inside).is_none(), "taken out of the junction");
    assert!(
        vehicle(&s, waiting).is_some() && vehicle(&s, blocker).is_some(),
        "vehicles on lanes stay"
    );
    assert_eq!(s.stats().removed_stuck, 1);
}

/// #126: a lane that reaches the next link but there only a turn the route does not take (a junction
/// of several nodes with 1 m links) is no target for a discretionary lane change.
#[test]
fn discretionary_lane_changes_look_through_short_links() {
    let build = |left_turn_only: bool| {
        let mut b = NetBuilder::new();
        b.node("W", -400.0, 0.0, NodeControl::Boundary)
            .node("J1", 0.0, 0.0, NodeControl::Priority)
            .node("J2", 17.0, 0.0, NodeControl::Priority)
            .node("E", 400.0, 0.0, NodeControl::Boundary)
            .node("N", 17.0, 400.0, NodeControl::Boundary)
            .link("in", "W", "J1", 2, 13.9)
            .link("mid", "J1", "J2", 2, 13.9)
            .link("east", "J2", "E", 1, 13.9)
            .link("north", "J2", "N", 1, 13.9)
            .connect("a0", "in", 0, "mid", 0, Priority::Major)
            .connect("a1", "in", 1, "mid", 1, Priority::Major)
            .connect("b0", "mid", 0, "east", 0, Priority::Major)
            .connect("b1", "mid", 1, "north", 0, Priority::Major);
        if !left_turn_only {
            b.connect("b2", "mid", 1, "east", 0, Priority::Major);
        }
        b
    };
    for left_turn_only in [true, false] {
        let b = build(left_turn_only);
        let mut s = sim(&b, quiet());
        let slow = VehicleParams {
            max_speed: 3.0,
            ..car()
        };
        s.place_vehicle("in", 0, 150.0, 3.0, "east", slow).unwrap();
        let id = s.place_vehicle("in", 0, 60.0, 13.0, "east", car()).unwrap();
        let mut changed = false;
        while let Some(v) = vehicle(&s, id) {
            if !s.network().is_lane(v.seg) || link_of(&s, v) != "in" {
                break;
            }
            changed |= s.network().lanes[v.seg as usize].index == 1;
            s.step();
            assert!(s.time < 120.0);
        }
        assert_eq!(changed, !left_turn_only, "left turn only: {left_turn_only}");
    }
}

/// #116: dense grids, deterministic per seed. Blocks of 28 m leave exit lanes of 12 m that cannot
/// hold a merging car and the reserved space for a prioritised one: yielding merges must still
/// enter them while they are empty (c598e2b: 72 arrivals). Blocks of 60 m: yielding merges never
/// fill an occupied exit lane, which keeps the grid from locking up (without that rule: 664).
#[test]
fn congested_short_block_grids_keep_their_throughput() {
    let mut s = sim(&grid_with_spacing(3, 1, 28.0), with_demand(200.0));
    run_checked(&mut s, 9000);
    assert!(s.stats().arrived > 250, "{:?}", s.stats());
    let mut s = sim(&grid_with_spacing(3, 2, 60.0), with_demand(600.0));
    run_checked(&mut s, 9000);
    assert!(s.stats().arrived > 800, "{:?}", s.stats());
}

#[test]
fn bridge_traffic_never_interacts_with_the_road_below() {
    // Structural: no connector touches the bridge links.
    let net = fixture_network();
    let bridge = [net.link_index("l9").unwrap(), net.link_index("l10").unwrap()];
    assert!(
        net.connectors
            .iter()
            .all(|c| !bridge.contains(&c.from_link) && !bridge.contains(&c.to_link))
    );
    // Behavioural: bridge vehicles evolve bit-identically with and without heavy traffic on the
    // side road below (per-entry RNG streams make the bridge arrivals identical).
    let bridge_only = SimConfig {
        demand: BTreeMap::from([("n5".to_string(), 1500.0), ("n7".to_string(), 1500.0)]),
        ..quiet()
    };
    let mut busy = bridge_only.clone();
    busy.demand.extend([
        ("n3".to_string(), 1500.0),
        ("n4".to_string(), 1500.0),
        ("n1".to_string(), 900.0),
    ]);
    let mut a = Simulation::new(net.clone(), bridge_only, 9).unwrap();
    let mut b = Simulation::new(net, busy, 9).unwrap();
    let on_bridge = |s: &Simulation| -> Vec<(u32, u64, u64)> {
        let mut v: Vec<_> = s
            .vehicles()
            .iter()
            .filter(|v| bridge.contains(&s.network().segment_link(v.seg)))
            .map(|v| (v.seg, v.pos.to_bits(), v.speed.to_bits()))
            .collect();
        v.sort_unstable();
        v
    };
    for step in 0..3000 {
        a.step();
        b.step();
        assert_eq!(on_bridge(&a), on_bridge(&b), "step {step}");
        for v in b
            .vehicles()
            .iter()
            .filter(|v| bridge.contains(&b.network().segment_link(v.seg)))
        {
            assert_eq!(v.flags & flags::YIELDING, 0);
        }
    }
    assert!(b.stats().spawned > a.stats().spawned + 150);
    assert!(!on_bridge(&a).is_empty());
}

// ---------------------------------------------------------------- #48 determinism

fn busy_fixture(seed: u64) -> Simulation {
    let config = SimConfig {
        default_demand: Some(800.0),
        vehicle_mix: BTreeMap::from([
            ("car".into(), 8.0),
            ("truck".into(), 1.0),
            ("motorcycle".into(), 1.0),
        ]),
        heterogeneity: 0.15,
        ..SimConfig::default()
    };
    Simulation::new(fixture_network(), config, seed).unwrap()
}

#[test]
fn same_inputs_and_seed_give_bit_identical_runs() {
    let mut a = busy_fixture(42);
    let mut b = busy_fixture(42);
    for _ in 0..30 {
        a.run(100);
        b.run(100);
        assert_eq!(a.state_checksum(), b.state_checksum());
    }
    assert_eq!(a.snapshot(), b.snapshot());
    assert_eq!(a.stats(), b.stats());
    // A clone continues identically: the state is fully captured.
    let mut c = a.clone();
    a.run(500);
    c.run(500);
    assert_eq!(a.state_checksum(), c.state_checksum());
}

#[test]
fn different_seeds_give_different_runs() {
    let mut a = busy_fixture(1);
    let mut b = busy_fixture(2);
    a.run(1000);
    b.run(1000);
    assert_ne!(a.state_checksum(), b.state_checksum());
}

/// Golden runs: checksums of the full state after N steps. They change whenever the model
/// changes on purpose; update them together with the change (same build ⇒ same values).
#[test]
fn golden_runs() {
    let profiles = SimConfig::from_json(
        r#"{"defaultDemand": 700, "vehicleMix": {"car": 8, "articulatedTruck": 1, "motorcycle": 1},
            "driverMix": {"attentive": 1, "average": 2, "distracted": 1, "aggressive": 1}}"#,
    )
    .unwrap();
    let od = SimConfig::from_json(
        r#"{"startTimeOfDay": "16:30", "demand": {"n7": 600}, "demandCurve": "weekday",
            "zones": {"w": {"nodes": ["n1"]}, "e": {"nodes": ["n2"]}, "ns": {"nodes": ["n3", "n4"]}},
            "vehicleMix": {"car": 9, "articulatedTruck": 1}, "vehicleMixCurves": {"articulatedTruck": "freight"},
            "od": [{"from": "w", "to": "e", "vph": 900, "curve": "eveningPeak"},
                   {"from": "ns", "to": "ns", "vph": 500, "driverMix": {"commuter": 1}},
                   {"from": "e", "to": "ns", "vph": 400, "vehicleMix": {"van": 1}}]}"#,
    )
    .unwrap();
    let merge = SimConfig::from_json(
        r#"{"defaultDemand": 0, "demand": {"A": 2600, "R": 600},
            "driverMix": {"average": 3, "aggressive": 1, "distracted": 1}}"#,
    )
    .unwrap();
    let cases: [(&str, Simulation, usize, u64); 7] = [
        (
            "motorway-merge",
            Simulation::new(crate::synth::motorway_merge().network(), merge, 42).unwrap(),
            3000,
            0x4993_b216_2219_af83,
        ),
        ("fixture", busy_fixture(42), 3000, 0x0122_ee62_46ec_20df),
        (
            "t-junction",
            sim(&t_junction(Priority::Minor), with_demand(600.0)),
            3000,
            0xd599_d1d2_f4c7_686c,
        ),
        (
            "roundabout",
            sim(&roundabout(), with_demand(500.0)),
            3000,
            0x15fb_8f5a_252d_ce8b,
        ),
        (
            "driver-profiles",
            Simulation::new(fixture_network(), profiles, 42).unwrap(),
            3000,
            0x02fa_f5f9_557b_c679,
        ),
        (
            "od-matrix",
            Simulation::new(fixture_network(), od, 42).unwrap(),
            3000,
            0x41f9_ffaf_c235_9bdb,
        ),
        (
            "rbl-crossroads",
            sim(
                &crossroads(
                    NodeControl::RightBeforeLeft,
                    Priority::RightBeforeLeft,
                    Priority::RightBeforeLeft,
                ),
                with_demand(400.0),
            ),
            3000,
            0x58af_5b12_5930_ffaf,
        ),
    ];
    let mut report = String::new();
    let mut changed = Vec::new();
    for (name, mut s, steps, expected) in cases {
        s.run(steps);
        let got = s.state_checksum();
        report.push_str(&format!("{name}: {got:#018x} {}\n", s.stats_json()));
        if got != expected {
            changed.push(name);
        }
    }
    assert!(changed.is_empty(), "golden runs {changed:?} changed:\n{report}");
    println!("{report}");
}

// ---------------------------------------------------------------- outputs

#[test]
fn snapshot_layout() {
    let mut s = Simulation::new(fixture_network(), quiet(), 1).unwrap();
    s.place_vehicle(
        "l9",
        0,
        100.0,
        20.0,
        "l9",
        VehicleParams::for_class(VehicleClass::Truck),
    )
    .unwrap();
    s.place_vehicle("l5", 0, 2.0, 0.0, "l6", car()).unwrap();
    s.step();
    let snap = s.snapshot();
    assert_eq!(snap.len(), 2 * SNAPSHOT_STRIDE);
    let truck = &snap[..SNAPSHOT_STRIDE];
    // Centre 6 m behind the front, on lane 0 of the eastbound bridge at z = 6.
    assert!((truck[0] - (-150.0 + 102.0 - 6.0)).abs() < 0.1, "{}", truck[0]);
    assert!((truck[1] - 58.375).abs() < 1e-3);
    assert_eq!(truck[2], 6.0);
    assert!(truck[3].abs() < 1e-6, "heading east");
    assert!((truck[4] - 20.0).abs() < 0.5);
    assert_eq!(truck[5], 12.0);
    assert_eq!(truck[6], f32::from(VehicleClass::Truck.id()));
    assert_eq!(truck[8], 0.0);
    let southbound = &snap[SNAPSHOT_STRIDE..];
    assert!(
        (southbound[3] + std::f32::consts::FRAC_PI_2).abs() < 1e-5,
        "heading south"
    );
    assert_eq!(southbound[8], 1.0);
    assert_ne!(southbound[7] as u8 & flags::WAITING, 0);
}

#[test]
fn snapshot_draws_vehicles_straddling_a_connector_from_the_previous_segment() {
    let b = corridor(1, 300.0, 15.0);
    let mut s = sim(&b, quiet());
    s.place_vehicle("up", 0, 299.0, 10.0, "down", car()).unwrap();
    s.step();
    let v = &s.vehicles()[0];
    assert!(!s.network().is_lane(v.seg) && v.pos < v.params.length / 2.0);
    let snap = s.snapshot();
    assert!(snap[0] < 300.0 && snap[0] > 295.0, "{}", snap[0]);
}

#[test]
fn stats_and_signal_outputs() {
    let mut s = Simulation::new(fixture_network(), with_demand(600.0), 1).unwrap();
    s.run(500);
    let json = s.stats_json();
    for key in [
        "\"spawned\"",
        "\"arrived\"",
        "\"waitingToEnter\"",
        "\"meanSpeed\"",
        "\"laneChanges\"",
    ] {
        assert!(json.contains(key), "{json}");
    }
    assert_eq!(s.signal_group_ids(), ["n0:g0", "n0:g1"]);
    assert_eq!(
        s.signal_states(),
        [SignalState::Red as u8, SignalState::Green as u8]
    );
    assert!(s.stats().mean_speed > 0.0);
}

#[test]
fn travel_time_updates_affect_new_routes_only() {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("X", 100.0, 0.0, NodeControl::Priority)
        .node("Y", 300.0, 0.0, NodeControl::Priority)
        .node("D", 200.0, 300.0, NodeControl::Priority)
        .node("B", 400.0, 0.0, NodeControl::Boundary)
        .link("ax", "A", "X", 1, 10.0)
        .link("xy", "X", "Y", 1, 10.0)
        .link("xd", "X", "D", 1, 10.0)
        .link("dy", "D", "Y", 1, 10.0)
        .link("yb", "Y", "B", 1, 10.0)
        .connect("c1", "ax", 0, "xy", 0, Priority::Major)
        .connect("c2", "ax", 0, "xd", 0, Priority::Major)
        .connect("c3", "xd", 0, "dy", 0, Priority::Major)
        .connect("c4", "xy", 0, "yb", 0, Priority::Major)
        .connect("c5", "dy", 0, "yb", 0, Priority::Major);
    let mut s = sim(&b, quiet());
    let first = s.place_vehicle("ax", 0, 0.0, 0.0, "yb", car()).unwrap();
    assert!(s.set_link_travel_time("zz", 1.0).is_err());
    s.set_link_travel_time("xy", 1e5).unwrap();
    assert_eq!(
        s.router().link_travel_time(s.network().link_index("xy").unwrap()),
        1e5
    );
    let second = s.place_vehicle("ax", 0, 50.0, 0.0, "yb", car()).unwrap();
    let names = |s: &Simulation, id| {
        let v = vehicle(s, id).unwrap();
        s.route_of(v)
            .iter()
            .map(|&l| s.network().links[l as usize].id.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&s, first), ["ax", "xy", "yb"]);
    assert_eq!(names(&s, second), ["ax", "xd", "dy", "yb"]);
}

// ---------------------------------------------------------------- #55 commuter re-routing

/// A → B directly over `xy` (200 m) or over the detour `xd`, `dy` (≈ 630 m). The approach
/// `ax` has a lane per direction (right: detour, left: direct).
fn detour_network() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", -300.0, 0.0, NodeControl::Boundary)
        .node("X", 300.0, 0.0, NodeControl::Priority)
        .node("Y", 500.0, 0.0, NodeControl::Priority)
        .node("D", 400.0, 300.0, NodeControl::Priority)
        .node("B", 800.0, 0.0, NodeControl::Boundary)
        .link("ax", "A", "X", 2, 13.889)
        .link("xy", "X", "Y", 1, 13.889)
        .link("xd", "X", "D", 1, 13.889)
        .link("dy", "D", "Y", 1, 13.889)
        .link("yb", "Y", "B", 1, 13.889)
        .connect("c1", "ax", 1, "xy", 0, Priority::Major)
        .connect("c2", "ax", 0, "xd", 0, Priority::Major)
        .connect("c3", "xd", 0, "dy", 0, Priority::Major)
        .connect("c4", "xy", 0, "yb", 0, Priority::Major)
        .connect("c5", "dy", 0, "yb", 0, Priority::Minor)
        .auto_conflicts("Y");
    b
}

/// Blocks `xy` with a crawler and counts the vehicles that took the detour.
fn detour_run(driver_mix: &str, interval: f64) -> (Simulation, usize) {
    let config = SimConfig::from_json(&format!(
        r#"{{"defaultDemand": 600, "driverMix": {driver_mix}, "reRouting": {{"interval": {interval}}}}}"#
    ))
    .unwrap();
    let mut s = sim(&detour_network(), config);
    s.place_vehicle("xy", 0, 5.0, 0.0, "xy", crawler()).unwrap();
    let mut detour = std::collections::BTreeSet::new();
    for _ in 0..6000 {
        s.step();
        check_invariants(&mut s);
        for v in s.vehicles() {
            if link_of(&s, v) == "xd" {
                detour.insert(v.id);
            }
        }
    }
    (s, detour.len())
}

#[test]
fn commuters_avoid_a_congested_link_others_do_not() {
    let (s, detour) = detour_run(r#"{"commuter": 1}"#, 30.0);
    let xy = s.network().link_index("xy").unwrap();
    let informed = s.informed_router().link_travel_time(xy);
    assert!(informed > 3.0 * s.router().free_flow_time(xy), "{informed}");
    assert_eq!(s.router().link_travel_time(xy), s.router().free_flow_time(xy));
    assert!(detour > 20, "commuters take the detour: {detour}");
    // En-route re-planning: with frequent updates, commuters already on their way switch while
    // the jam builds up.
    let (frequent, _) = detour_run(r#"{"commuter": 1}"#, 15.0);
    assert!(frequent.stats().commuter_reroutes > 0, "{:?}", frequent.stats());
    let (unfamiliar, detour) = detour_run(r#"{"average": 1}"#, 30.0);
    assert_eq!(detour, 0);
    assert_eq!(unfamiliar.stats().commuter_reroutes, 0);
    // Disabled re-routing: commuters behave like everybody else.
    let config = SimConfig::from_json(
        r#"{"defaultDemand": 600, "driverMix": {"commuter": 1}, "reRouting": {"enabled": false}}"#,
    )
    .unwrap();
    let mut off = sim(&detour_network(), config);
    off.place_vehicle("xy", 0, 5.0, 0.0, "xy", crawler()).unwrap();
    off.run(3000);
    assert!(off.vehicles().iter().all(|v| link_of(&off, v) != "xd"));
}

#[test]
fn experienced_travel_times_track_free_flow_traffic() {
    let b = corridor(1, 300.0, 15.0);
    let mut s = sim(&b, with_demand(300.0));
    s.run(6000);
    let up = s.network().link_index("up").unwrap();
    let t = s.informed_router().link_travel_time(up);
    assert!((20.0..22.0).contains(&t), "{t}");
    // Without traffic the estimate relaxes towards free flow.
    s.set_demand("A", 0.0).unwrap();
    s.run(12_000);
    let t = s.informed_router().link_travel_time(up);
    assert!((t - 20.0).abs() < 0.2, "{t}");
}

// ---------------------------------------------------------------- #82 actuated signals

/// Signalised crossroads: east-west movements in group "ew" (green 0–27 s), north-south in
/// "ns" (green 30–57 s) of a 60 s cycle.
fn signal_crossroads() -> NetBuilder {
    let mut b = crossroads(NodeControl::Signal, Priority::Signal, Priority::Signal);
    b.signal("C", 60.0, &[("ew", 0.0, 27.0, 3.0), ("ns", 30.0, 57.0, 3.0)]);
    let ids: Vec<String> = b.package.connectors.iter().map(|c| c.id.clone()).collect();
    for id in ids {
        let group = if id.starts_with('W') || id.starts_with('E') {
            "ew"
        } else {
            "ns"
        };
        b.connector_mut(&id).signal_group = Some(group.into());
    }
    b
}

/// Runs `steps` and returns the green durations (s) per group (0 = ew, 1 = ns).
fn green_times(s: &mut Simulation, steps: usize) -> [Vec<f64>; 2] {
    let mut greens: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    let mut since = [None::<f64>; 2];
    for _ in 0..steps {
        s.step();
        check_invariants(s);
        let states = s.signal_states();
        for g in 0..2 {
            let green = states[g] == SignalState::Green as u8;
            match (green, since[g]) {
                (true, None) => since[g] = Some(s.time()),
                (false, Some(t0)) => {
                    greens[g].push(s.time() - t0);
                    since[g] = None;
                }
                _ => {}
            }
        }
    }
    greens
}

#[test]
fn actuated_signals_rest_in_green_without_conflicting_calls() {
    let config = |actuated: &str| {
        SimConfig::from_json(&format!(
            r#"{{"defaultDemand": 0, "demand": {{"W": 600, "E": 600}}, "signalControl": {{"actuated": {actuated}}}}}"#
        ))
        .unwrap()
    };
    let mut fixed = sim(&signal_crossroads(), config("false"));
    let mut actuated = sim(&signal_crossroads(), config(r#"["C"]"#));
    fixed.set_event_logging(true);
    actuated.set_event_logging(true);
    green_times(&mut fixed, 3000);
    let greens = green_times(&mut actuated, 3000);
    assert!(
        greens[0].is_empty() && greens[1].is_empty(),
        "ew rests in green: {greens:?}"
    );
    assert_eq!(
        actuated.signal_states(),
        [SignalState::Green as u8, SignalState::Red as u8]
    );
    let stopped = |s: &Simulation| {
        s.entry_log()
            .iter()
            .filter(|e| e.signal == Some(SignalState::Green))
            .count()
    };
    assert_eq!(stopped(&actuated), actuated.entry_log().len());
    assert!(
        actuated.stats().mean_travel_time < fixed.stats().mean_travel_time - 2.0,
        "{:?} vs {:?}",
        actuated.stats(),
        fixed.stats()
    );
}

#[test]
fn actuated_greens_gap_out_and_respect_min_and_max_green() {
    let config = SimConfig::from_json(
        r#"{"defaultDemand": 0, "demand": {"W": 500, "E": 500, "N": 100, "S": 100},
            "signalControl": {"actuated": true, "minGreen": 6, "maxGreen": 40, "extension": 2.5}}"#,
    )
    .unwrap();
    let mut s = sim(&signal_crossroads(), config);
    let greens = green_times(&mut s, 12_000);
    assert!(greens[0].len() > 5 && greens[1].len() > 5, "{greens:?}");
    // Min green always; max green whenever another phase was waiting (a phase without a
    // conflicting call may rest beyond it).
    assert!(greens.iter().flatten().all(|&g| g >= 6.0 - 1e-6), "{greens:?}");
    let all: Vec<f64> = greens.iter().flatten().copied().collect();
    let within = all.iter().filter(|&&g| g <= 40.0 + 0.2).count();
    assert!(within * 10 >= all.len() * 9, "{greens:?}");
    // The light north-south traffic gaps out early, the busy east-west phase runs longer.
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    assert!(mean(&greens[1]) < mean(&greens[0]), "{greens:?}");
    let c = &s.actuated[0];
    assert!(c.gap_outs > 0 && c.switches > 10, "{c:?}");
    assert!(s.stats().arrived > 300, "{:?} {greens:?}", s.stats());
    // Unknown actuated nodes are rejected.
    let bad = SimConfig::from_json(r#"{"signalControl": {"actuated": ["W"]}}"#).unwrap();
    let e = Simulation::new(signal_crossroads().network(), bad, 1)
        .err()
        .unwrap();
    assert!(e.contains("no signal controller"), "{e}");
}

// ---------------------------------------------------------------- #81 motorway behaviour

use crate::synth::{lane_drop, motorway_merge, weaving};

/// Runs a motorway scenario; returns the simulation and the number of vehicles that came to a
/// standstill on an ending lane (mergers that found no gap while moving).
fn motorway_run(b: &NetBuilder, json: &str, cooperation: bool, steps: usize) -> (Simulation, usize) {
    let mut config = SimConfig::from_json(json).unwrap();
    config.merging.cooperation = cooperation;
    let mut s = sim(b, config);
    s.set_event_logging(true);
    let mut stopped = std::collections::BTreeSet::new();
    for _ in 0..steps {
        s.step();
        check_invariants(&mut s);
        for v in s.vehicles() {
            if v.speed < 0.5 && s.network().is_lane(v.seg) && s.network().lane_ends(v.seg) {
                stopped.insert(v.id);
            }
        }
    }
    (s, stopped.len())
}

#[test]
fn on_ramp_traffic_merges_with_cooperative_mainline_drivers() {
    let json = r#"{"defaultDemand": 0, "demand": {"A": 2600, "R": 600}}"#;
    let (with, stopped_with) = motorway_run(&motorway_merge(), json, true, 6000);
    let (without, stopped_without) = motorway_run(&motorway_merge(), json, false, 6000);
    let (a, b) = (with.stats(), without.stats());
    assert_eq!(
        (a.stranded, b.stranded),
        (0, 0),
        "mergers wait instead of giving up"
    );
    assert!(
        stopped_with < stopped_without,
        "cooperation lets mergers in while moving: {stopped_with} vs {stopped_without}"
    );
    assert!(a.arrived * 10 >= b.arrived * 9, "{a:?} vs {b:?}");
    // Mergers use the acceleration lane: they change lanes along it, not all at its start.
    let accel = with.network().link_index("accel").unwrap();
    let merges: Vec<f64> = with
        .lane_change_log()
        .iter()
        .filter(|e| e.link == accel && e.from_index == 0 && e.mandatory)
        .map(|e| e.pos)
        .collect();
    assert!(merges.len() > 50, "{}", merges.len());
    assert!(merges.iter().all(|&p| p <= 300.0));
}

#[test]
fn lane_drops_zip_and_weaving_traffic_reaches_its_exits() {
    let (drop, _) = motorway_run(&lane_drop(), r#"{"defaultDemand": 3600}"#, true, 6000);
    let st = drop.stats();
    assert_eq!(st.stranded, 0, "{st:?}");
    assert!(st.arrived > 400, "{st:?}");
    // Vehicles leave the dropped lane (early by strategic choice or at the end by zipping).
    let net = drop.network();
    let (approach, wide) = (
        net.link_index("approach").unwrap(),
        net.link_index("wide").unwrap(),
    );
    let leaving = |link: u32| {
        drop.lane_change_log()
            .iter()
            .filter(|e| e.link == link && e.from_index == 0)
            .count()
    };
    assert!(
        leaving(approach) + leaving(wide) > 50,
        "{} {}",
        leaving(approach),
        leaving(wide)
    );
    let json = r#"{"defaultDemand": 0, "demand": {"A": 2000, "R": 600}, "destinationWeights": {"X": 0.4}}"#;
    let (weave, _) = motorway_run(&weaving(), json, true, 6000);
    let st = weave.stats();
    assert_eq!(st.stranded, 0, "{st:?}");
    // Strategic lane choice: few drivers miss their exit or their way back to the mainline.
    assert!(st.arrived > 400 && st.rerouted < st.arrived / 6, "{st:?}");
}

// ---------------------------------------------------------------- #57 lane cells

use crate::metrics::cells::LaneCells;

#[test]
fn lane_cells_count_a_single_vehicle_exactly() {
    let b = corridor(1, 300.0, 15.0);
    let mut s = sim(&b, quiet());
    assert_eq!(
        LaneCells::decode(&s.lane_cells_latest()).unwrap().buckets.len(),
        0
    );
    s.place_vehicle("up", 0, 0.0, 15.0, "down", car()).unwrap();
    s.run(300);
    assert_eq!(s.lane_cell_buckets(), 1);
    let d = LaneCells::decode(&s.lane_cells_latest()).unwrap();
    assert_eq!((d.first_bucket, d.buckets.len(), d.cell_count), (0, 1, 60));
    assert_eq!(d.bucket_duration, 30.0);
    assert_eq!(d.start_time_of_day, 25_200.0);
    let b0 = &d.buckets[0];
    // 30 s at 15 m/s from the start of "up": cells 0..=29 of "up" and 0..=13 of "down" crossed.
    assert!(b0.flow[..30].iter().all(|&f| f == 1), "{:?}", &b0.flow[..30]);
    assert!(b0.flow[30..43].iter().all(|&f| f == 1), "{:?}", &b0.flow[30..45]);
    assert_eq!(b0.flow[50], 0);
    // 10 m at 15 m/s = 2/3 s in a cell: 0.667 vehicle-s / (30 s × 10 m) = 2.22 veh/km.
    assert!((b0.density[5] - 2.222).abs() < 0.4, "{}", b0.density[5]);
    assert!((b0.mean_speed[5] - 15.0).abs() < 1e-3 && (b0.speed_ratio[5] - 1.0).abs() < 1e-3);
    assert!(b0.mean_speed[55].is_nan());
    assert_eq!(b0.stops.iter().map(|&s| u32::from(s)).sum::<u32>(), 0);
    assert!(b0.delay.iter().all(|&d| d.abs() < 1e-3));
    s.run(900);
    assert_eq!(s.lane_cell_buckets(), 4);
    let all = LaneCells::decode(&s.lane_cells_since(0)).unwrap();
    assert_eq!(all.buckets.len(), 4);
    let tail = LaneCells::decode(&s.lane_cells_since(2)).unwrap();
    assert_eq!((tail.first_bucket, tail.buckets.len()), (2, 2));
    assert_eq!(format!("{:?}", tail.buckets[1]), format!("{:?}", all.buckets[3]));
    // Every cell boundary is crossed exactly once over the whole trip.
    let total: Vec<u32> = (0..60)
        .map(|c| all.buckets.iter().map(|b| u32::from(b.flow[c])).sum())
        .collect();
    assert!(total.iter().all(|&f| f == 1), "{total:?}");
}

#[test]
fn lane_cells_capture_queues_stops_and_retention() {
    let b = corridor(1, 300.0, 15.0);
    let config =
        SimConfig::from_json(r#"{"defaultDemand": 900, "metrics": {"maxBuckets": 2, "bucketDuration": 20}}"#)
            .unwrap();
    let mut s = sim(&b, config);
    s.place_vehicle("up", 0, 200.0, 0.0, "down", crawler()).unwrap();
    s.run(1800);
    assert_eq!(s.lane_cell_buckets(), 9);
    let d = LaneCells::decode(&s.lane_cells_since(0)).unwrap();
    assert_eq!(
        (d.first_bucket, d.buckets.len()),
        (7, 2),
        "only the newest buckets are kept"
    );
    let b = &d.buckets[1];
    let queued = (0..60).filter(|&c| b.queue_share[c] > 5_000).count();
    assert!(queued > 5, "{:?}", &b.queue_share[..30]);
    let stops: u32 = d
        .buckets
        .iter()
        .flat_map(|b| b.stops.iter())
        .map(|&s| u32::from(s))
        .sum();
    let delay: f32 = b.delay.iter().sum();
    assert!(delay > 100.0, "{delay}");
    let early = LaneCells::decode(&s.lane_cells_since(0)).unwrap();
    assert!(stops > 0 || early.buckets.iter().any(|b| b.stops.iter().any(|&s| s > 0)));
    // Disabled metrics produce nothing.
    let mut off = sim(
        &corridor(1, 300.0, 15.0),
        SimConfig::from_json(r#"{"metrics": {"enabled": false}}"#).unwrap(),
    );
    off.run(400);
    assert!(off.metrics().is_none() && off.lane_cells_latest().is_empty());
    assert_eq!(off.lane_cell_buckets(), 0);
    assert!(off.summary().links.is_empty() && off.junction_metrics().is_empty());
    assert_eq!(off.events_json(), r#"{"tailbacks":[],"waves":[]}"#);
}

// ---------------------------------------------------------------- #58 junction metrics, summary

#[test]
fn junction_metrics_report_queues_delays_and_levels_of_service() {
    let mut s = busy_fixture(3);
    s.run(6000);
    let junctions = s.junction_metrics();
    assert_eq!(
        junctions.len(),
        1,
        "only n0 has connectors (bridges are plain links)"
    );
    let n0 = &junctions[0];
    assert_eq!(
        (n0.id.as_str(), n0.control.as_str(), n0.signalised),
        ("n0", "signal", true)
    );
    assert!(n0.throughput > 200 && n0.flow > 1000.0, "{n0:?}");
    assert!(n0.queue_max > 20.0 && n0.mean_delay.unwrap() > 5.0, "{n0:?}");
    assert!(n0.los.is_some());
    assert_eq!(n0.approaches.len(), 4);
    assert!(n0.approaches.iter().all(|a| a.queue_max >= a.queue_mean));
    let total: u64 = n0.movements.iter().map(|m| m.count).sum();
    assert_eq!(total, n0.throughput);
    let left = n0.movements.iter().find(|m| m.connector == "c3").unwrap();
    assert_eq!(
        (left.turn.as_str(), left.from_link.as_str(), left.to_link.as_str()),
        ("left", "l1", "l8")
    );
    let json = s.junctions_json();
    assert!(json.starts_with(r#"[{"id":"n0","control":"signal""#), "{json}");
}

#[test]
fn summary_links_match_the_demand_in_steady_state() {
    let b = corridor(2, 500.0, 15.0);
    let mut s = sim(&b, with_demand(900.0));
    s.run(1500);
    s.reset_metrics();
    s.run(6000);
    let summary = s.summary();
    assert_eq!(summary.format_version, 1);
    assert!((summary.duration - 600.0).abs() < 1e-6);
    let up = summary.links.iter().find(|l| l.id == "up").unwrap();
    assert!((up.flow - 900.0).abs() < 150.0, "{up:?}");
    assert!((up.mean_speed.unwrap() - 15.0).abs() < 1.0, "{up:?}");
    // Fundamental relation q = k · v (per link, all lanes).
    let q_from_kv = up.density * up.mean_speed.unwrap() * 3.6;
    assert!(
        (q_from_kv - up.flow).abs() < 0.1 * up.flow,
        "{q_from_kv} vs {}",
        up.flow
    );
    assert!(up.delay.unwrap() < 2.0 && up.queue_max < 1.0, "{up:?}");
    assert!((up.travel_time - up.free_flow_time).abs() < 3.0);
    let n = &summary.network;
    assert!(
        n.vehicle_km > 0.0 && n.vehicle_hours > 0.0 && n.mean_speed > 13.0,
        "{n:?}"
    );
    let json = s.summary_json();
    assert!(
        json.contains(r#""links":[{"id":"up","length":500.0,"lanes":2,"meanSpeed":"#),
        "{json}"
    );
    assert!(
        json.contains(r#""events":{"tailbacks":0,"stopAndGoWaves":0}"#),
        "{json}"
    );
}

// ---------------------------------------------------------------- #62 phenomena

#[test]
fn tailbacks_grow_upstream_and_spill_back() {
    let b = corridor(1, 400.0, 15.0);
    let mut s = sim(&b, with_demand(900.0));
    s.place_vehicle("down", 0, 100.0, 0.0, "down", crawler()).unwrap();
    s.run(3000);
    let events: serde_json::Value = serde_json::from_str(&s.events_json()).unwrap();
    let tailbacks = events["tailbacks"].as_array().unwrap();
    let down = tailbacks
        .iter()
        .find(|t| t["link"] == "down")
        .expect("tailback on down");
    assert!(down["maxLength"].as_f64().unwrap() > 200.0, "{down}");
    assert_eq!(down["spillback"], true);
    let samples = down["samples"].as_array().unwrap();
    let first = samples[0][1].as_f64().unwrap();
    let max = down["maxLength"].as_f64().unwrap();
    assert!(max > 2.0 * first, "the tailback grows: {first} → {max}");
    assert!(
        tailbacks.iter().any(|t| t["link"] == "up"),
        "spills back into the upstream link"
    );
    assert!(s.summary().events.tailbacks >= 2);
}

#[test]
fn stop_and_go_waves_travel_upstream_and_signal_queues_are_not_waves() {
    // A dense platoon at 20 m/s on a long road (equilibrium spacing ≈ 38 m).
    let b = corridor(1, 2000.0, 25.0);
    let mut s = sim(&b, quiet());
    let mut ids = Vec::new();
    for k in 0..40 {
        let pos = 1900.0 - 38.0 * f64::from(k);
        ids.push(s.place_vehicle("down", 0, pos, 20.0, "down", car()).unwrap());
    }
    s.run(20);
    // The fourth driver brakes to a standstill for a moment, then drives on.
    let at = |s: &Simulation, id| s.vehicles.iter().position(|v| v.id == id).unwrap();
    let i = at(&s, ids[3]);
    let max_speed = s.vehicles[i].params.max_speed;
    s.vehicles[i].params.max_speed = 0.0;
    s.run(100);
    let i = at(&s, ids[3]);
    s.vehicles[i].params.max_speed = max_speed;
    s.run(1200);
    let events: serde_json::Value = serde_json::from_str(&s.events_json()).unwrap();
    let waves = events["waves"].as_array().unwrap();
    assert!(!waves.is_empty(), "{events}");
    let w = &waves[0];
    let speed = w["speed"].as_f64().unwrap() * 3.6;
    assert!((-30.0..=-5.0).contains(&speed), "{w}");
    assert!(w["to"].as_f64().unwrap() < w["from"].as_f64().unwrap(), "{w}");
    assert!(s.summary().events.stop_and_go_waves >= 1);
    // Queues discharging at a signal are anchored at the stop line: no waves. (The heuristic is
    // not perfect: stop-and-go inside long signal queues behind permissive left turners is
    // occasionally reported, about twice per 10 minutes of this busy fixture on average.)
    let mut f = busy_fixture(1);
    f.run(6000);
    let waves = f.metrics().unwrap().phenomena.waves.clone();
    assert_eq!(f.summary().events.stop_and_go_waves, 0, "{waves:?}");
}

/// Throughput benchmark (run with `cargo test --release -- --ignored --nocapture perf`).
#[test]
#[ignore]
fn perf_grid() {
    let env = |key: &str, default: f64| {
        std::env::var(key)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let net = grid(env("PERF_GRID", 12.0) as usize, 2).network();
    println!(
        "grid: {} links, {} lanes, {} connectors",
        net.links.len(),
        net.lane_count(),
        net.connectors.len()
    );
    let mut config = with_demand(env("PERF_VPH", 900.0));
    config.metrics.enabled = env("PERF_METRICS", 1.0) > 0.0;
    config.perception.enabled = env("PERF_PERCEPTION", 1.0) > 0.0;
    let mut s = Simulation::new(net, config, 1).unwrap();
    s.run(3000);
    let start = std::time::Instant::now();
    let mut vehicle_steps = 0usize;
    for _ in 0..3000 {
        s.step();
        vehicle_steps += s.vehicle_count();
    }
    let secs = start.elapsed().as_secs_f64();
    let mean = vehicle_steps as f64 / 3000.0;
    println!(
        "{mean:.0} vehicles on average, {:.2} us per vehicle-step, {:.1}x real time, {}",
        secs * 1e6 / vehicle_steps as f64,
        300.0 / secs,
        s.stats_json()
    );
}
