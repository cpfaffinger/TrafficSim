use super::junction::Decision;
use super::*;
use crate::package::{NodeControl, Priority};
use crate::synth::{
    FIXTURE, NetBuilder, corridor, crossroads, fixture_network, grid, roundabout, t_junction,
};

fn quiet() -> SimConfig {
    SimConfig {
        default_demand: 0.0,
        ..SimConfig::default()
    }
}

fn with_demand(vph: f64) -> SimConfig {
    SimConfig {
        default_demand: vph,
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
    let mut by_seg: BTreeMap<u32, Vec<&Vehicle>> = BTreeMap::new();
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
        by_seg.entry(v.seg).or_default().push(v);
    }
    for vs in by_seg.values_mut() {
        vs.sort_by(|a, b| b.pos.total_cmp(&a.pos));
        for w in vs.windows(2) {
            let gap = w[0].pos - w[0].params.length - w[1].pos;
            assert!(
                gap > -1e-6,
                "overlap {gap} on segment {} t={}: {:?} / {:?} lc={:?}",
                w[0].seg,
                sim.time(),
                w[0],
                w[1],
                sim.lane_change_log().iter().rev().take(3).collect::<Vec<_>>()
            );
        }
    }
    for c in 0..net.connectors.len() as u32 {
        for &k in net.conflicts(c) {
            assert!(
                !(sim.blocks(c, k) && sim.blocks(k, c)),
                "conflicting connectors {} and {} both in use at t={}",
                net.connectors[c as usize].id,
                net.connectors[k as usize].id,
                sim.time()
            );
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
    assert_eq!(sim.config().default_demand, 300.0);
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
            default_demand: 3600.0,
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
            default_demand: 900.0,
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

// ---------------------------------------------------------------- #44 signals

fn refresh_signals(s: &mut Simulation) {
    s.net.signals.states_into(s.time, &mut s.signal_state);
}

#[test]
fn vehicles_stop_at_red_and_enter_only_on_green_or_amber() {
    let config = SimConfig {
        default_demand: 900.0,
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
    let oncoming = s.place_vehicle("l3", 0, 60.0, 13.0, "l4", car()).unwrap();
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
    let major = s.place_vehicle("we", 0, 200.0, 13.0, "je", car()).unwrap();
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
    let mut s = sim(
        &b,
        SimConfig {
            junction: crate::config::JunctionConfig {
                max_wait: 5.0,
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

// ---------------------------------------------------------------- #97 markings, roundabouts, bridges

#[test]
fn lane_changes_obey_boundaries_and_no_change_zones() {
    let config = SimConfig {
        default_demand: 900.0,
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
        default_demand: 800.0,
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
    let cases: [(&str, Simulation, usize, u64); 4] = [
        ("fixture", busy_fixture(42), 3000, 0xdb36_2e7d_eebf_d5bb),
        (
            "t-junction",
            sim(&t_junction(Priority::Minor), with_demand(600.0)),
            3000,
            0x046a_a0b9_be0d_e6b9,
        ),
        (
            "roundabout",
            sim(&roundabout(), with_demand(500.0)),
            3000,
            0x46e8_c79b_665c_4dc7,
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
            0x8b43_edff_bb74_64e3,
        ),
    ];
    let mut report = String::new();
    for (name, mut s, steps, expected) in cases {
        s.run(steps);
        let got = s.state_checksum();
        report.push_str(&format!("{name}: {got:#018x} {}\n", s.stats_json()));
        assert_eq!(got, expected, "golden run '{name}' changed:\n{report}");
    }
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
    let mut s = Simulation::new(net, with_demand(env("PERF_VPH", 900.0)), 1).unwrap();
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
