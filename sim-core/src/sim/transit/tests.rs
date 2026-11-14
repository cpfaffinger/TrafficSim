use super::*;
use crate::config::SimConfig;
use crate::network::Network;
use crate::synth::{NetBuilder, TRANSIT_FIXTURE, corridor};
use crate::transit::{TransitConfig, TransitLineDto, TransitStopDto};

/// Corridor up (A → M, 300 m) → down (M → B, 300 m) with one line over both links.
fn line_builder(lanes: u32, stops: &[(&str, f64, bool)], headway: f64) -> NetBuilder {
    let mut b = corridor(lanes, 300.0, 13.89);
    b.package.transit_lines.push(TransitLineDto {
        id: "t0".into(),
        line_ref: Some("1".into()),
        name: None,
        headway: Some(headway),
        links: vec!["up".into(), "down".into()],
        stops: stops
            .iter()
            .enumerate()
            .map(|(i, &(link, pos, bay))| TransitStopDto {
                id: format!("t0s{i}"),
                name: None,
                link: link.into(),
                pos,
                bay,
            })
            .collect(),
    });
    b
}

fn config(dwell: f64, random: f64) -> SimConfig {
    SimConfig {
        default_demand: Some(0.0),
        transit: TransitConfig {
            dwell_time: dwell,
            dwell_time_random: random,
            ..TransitConfig::default()
        },
        ..SimConfig::default()
    }
}

fn sim_on(net: Network, config: SimConfig, seed: u64) -> Simulation {
    Simulation::new(net, config, seed).unwrap()
}

fn buses(s: &Simulation) -> Vec<&Vehicle> {
    s.vehicles()
        .iter()
        .filter(|v| v.params.class == VehicleClass::Bus)
        .collect()
}

/// Steps until `f` holds (at most `max_s` simulated seconds).
fn run_until(s: &mut Simulation, max_s: f64, mut f: impl FnMut(&Simulation) -> bool) -> bool {
    let steps = (max_s / s.time_step()) as usize;
    for _ in 0..steps {
        if f(s) {
            return true;
        }
        s.step();
    }
    f(s)
}

fn dwelling_bus(s: &Simulation) -> Option<&Vehicle> {
    s.vehicles().iter().find(|v| v.flags & flags::DWELLING != 0)
}

fn lane_index(s: &Simulation, v: &Vehicle) -> u32 {
    s.network().lanes[v.seg as usize].index
}

#[test]
fn dispatches_buses_at_the_headway_with_a_seeded_phase() {
    let net = line_builder(1, &[], 120.0).network();
    let mut s = sim_on(net.clone(), config(20.0, 0.0), 7);
    let mut departures = Vec::new();
    let mut seen = 0;
    for _ in 0..6000 {
        s.step();
        let n = s.transit_metrics()[0].buses;
        if n > seen {
            departures.push(s.time());
            seen = n;
        }
    }
    assert_eq!(departures.len(), 5, "{departures:?}");
    for w in departures.windows(2) {
        assert!((w[1] - w[0] - 120.0).abs() < 0.15, "{departures:?}");
    }
    let first = |seed| {
        let mut s = sim_on(net.clone(), config(20.0, 0.0), seed);
        run_until(&mut s, 130.0, |s| !buses(s).is_empty());
        s.time()
    };
    assert_eq!(first(7), departures[0]);
    assert_ne!(first(7), first(8), "the phase comes from the seed");
    let m = &s.transit_metrics()[0];
    assert_eq!(
        (m.id.as_str(), m.label.as_deref(), m.headway),
        ("t0", Some("1"), 120.0)
    );
    assert!(m.completed >= 3 && m.mean_travel_time.is_some());
}

#[test]
fn bus_stops_at_the_stop_position_and_dwells_for_the_configured_time() {
    let net = line_builder(1, &[("up", 150.0, false), ("down", 120.0, false)], 600.0).network();
    let mut s = sim_on(net, config(20.0, 0.0), 3);
    assert!(run_until(&mut s, 700.0, |s| dwelling_bus(s).is_some()));
    let start = s.time();
    let bus = dwelling_bus(&s).unwrap();
    assert_eq!(link_id(&s, bus), "up");
    assert!((148.5..=150.5).contains(&bus.pos), "front at {}", bus.pos);
    let id = bus.id;
    assert!(run_until(&mut s, 30.0, |s| {
        s.vehicles()
            .iter()
            .find(|v| v.id == id)
            .is_some_and(|v| v.flags & flags::DWELLING == 0)
    }));
    assert!(
        (s.time() - start - 20.0).abs() < 0.15,
        "dwelled {}",
        s.time() - start
    );
    // The second stop on the next link.
    assert!(run_until(&mut s, 60.0, |s| dwelling_bus(s).is_some()));
    let bus = dwelling_bus(&s).unwrap();
    assert_eq!(link_id(&s, bus), "down");
    assert!((118.5..=120.5).contains(&bus.pos), "front at {}", bus.pos);
    run_until(&mut s, 100.0, |s| buses(s).is_empty());
    let m = &s.transit_metrics()[0];
    assert_eq!(
        (m.stops, m.stops_served, m.stops_missed, m.completed),
        (2, 2, 0, 1)
    );
    assert!((m.mean_dwell.unwrap() - 20.0).abs() < 1e-9);
}

fn link_id(s: &Simulation, v: &Vehicle) -> String {
    s.network().links[s.network().segment_link(v.seg) as usize]
        .id
        .clone()
}

#[test]
fn dwell_time_has_a_seeded_random_part() {
    let run = |seed| {
        let net = line_builder(1, &[("up", 100.0, false), ("down", 100.0, false)], 90.0).network();
        let mut s = sim_on(net, config(10.0, 8.0), seed);
        s.run(9000);
        (s.transit_metrics()[0].mean_dwell.unwrap(), s.state_checksum())
    };
    let (dwell, checksum) = run(5);
    assert!((10.0..18.0).contains(&dwell) && dwell != 10.0, "{dwell}");
    assert_eq!(run(5), (dwell, checksum));
    assert_ne!(run(6).0, dwell);
}

/// Runs until the first bus dwells at the stop on `up`, then places a car 90 m behind it.
fn car_behind_dwelling_bus(lanes: u32, bay: bool) -> (Simulation, u32, u32) {
    let net = line_builder(lanes, &[("up", 200.0, bay)], 600.0).network();
    let mut s = sim_on(net, config(25.0, 0.0), 11);
    assert!(run_until(&mut s, 700.0, |s| dwelling_bus(s).is_some()));
    let bus = dwelling_bus(&s).unwrap();
    let (bus_id, pos) = (bus.id, bus.pos);
    let car = s
        .place_vehicle(
            "up",
            0,
            pos - 90.0,
            10.0,
            "down",
            VehicleParams::for_class(VehicleClass::Car),
        )
        .unwrap();
    (s, bus_id, car)
}

fn vehicle(s: &Simulation, id: u32) -> Option<&Vehicle> {
    s.vehicles().iter().find(|v| v.id == id)
}

#[test]
fn a_bus_at_a_kerb_stop_blocks_a_single_lane() {
    let (mut s, bus, car) = car_behind_dwelling_bus(1, false);
    s.run(200);
    let (b, c) = (vehicle(&s, bus).unwrap(), vehicle(&s, car).unwrap());
    assert_ne!(b.flags & flags::DWELLING, 0);
    assert_eq!(c.seg, b.seg);
    assert!(
        c.pos < b.pos - b.params.length && c.speed < 0.1,
        "car at {} behind {}",
        c.pos,
        b.pos
    );
    // Once the bus has left, the car follows.
    assert!(run_until(&mut s, 120.0, |s| vehicle(s, car).is_none()));
}

#[test]
fn followers_overtake_a_dwelling_bus_on_a_multi_lane_link() {
    let (mut s, bus, car) = car_behind_dwelling_bus(2, false);
    assert_eq!(lane_index(&s, vehicle(&s, bus).unwrap()), 0);
    s.set_event_logging(true);
    s.run(200);
    let b = vehicle(&s, bus).unwrap();
    assert_ne!(b.flags & flags::DWELLING, 0, "still dwelling");
    let passed = match vehicle(&s, car) {
        None => true,
        Some(c) => link_id(&s, c) == "down" || (c.seg != b.seg && c.pos > b.pos),
    };
    assert!(passed, "the car overtook");
    assert!(
        s.lane_change_log()
            .iter()
            .any(|e| e.vehicle == car && e.to_index == 1)
    );
}

#[test]
fn a_bus_in_a_bay_does_not_block_its_lane_and_pulls_out_when_clear() {
    let (mut s, bus, car) = car_behind_dwelling_bus(1, true);
    s.run(150);
    let b = vehicle(&s, bus).unwrap();
    assert_ne!(b.flags & flags::DWELLING, 0);
    assert!(b.lat_offset <= -2.9, "drawn in the bay: {}", b.lat_offset);
    let passed = vehicle(&s, car).is_none_or(|c| link_id(&s, c) == "down" || c.pos > b.pos);
    assert!(passed, "the car drove past the bay");
    assert!(run_until(&mut s, 60.0, |s| vehicle(s, bus)
        .is_some_and(|b| b.flags & flags::DWELLING == 0)));
    assert!(run_until(&mut s, 120.0, |s| vehicle(s, bus).is_none()));
    let m = &s.transit_metrics()[0];
    assert_eq!((m.stops_served, m.stops_missed), (1, 0));
}

#[test]
fn a_bus_changes_to_the_kerb_lane_before_its_stop() {
    let net = line_builder(2, &[("up", 220.0, false)], 60.0).network();
    let mut s = sim_on(net, config(10.0, 0.0), 2);
    // A crawler blocks the start of the kerb lane: the bus enters on lane 1.
    let crawler = VehicleParams {
        max_speed: 0.0,
        ..VehicleParams::for_class(VehicleClass::Car)
    };
    s.place_vehicle("up", 0, 15.0, 0.0, "down", crawler).unwrap();
    assert!(run_until(&mut s, 70.0, |s| !buses(s).is_empty()));
    assert_eq!(lane_index(&s, buses(&s)[0]), 1, "entered left of the crawler");
    assert!(run_until(&mut s, 120.0, |s| dwelling_bus(s).is_some()));
    let bus = dwelling_bus(&s).unwrap();
    assert_eq!((lane_index(&s, bus), link_id(&s, bus)), (0, "up".to_string()));
}

#[test]
fn transit_runs_are_deterministic_and_disabled_transit_is_bit_identical() {
    let demand = |enabled: bool| SimConfig {
        default_demand: Some(600.0),
        transit: TransitConfig {
            enabled,
            ..TransitConfig::default()
        },
        ..SimConfig::default()
    };
    let with_line = line_builder(2, &[("up", 150.0, false), ("down", 100.0, true)], 60.0).network();
    let run = |net: &Network, config: SimConfig| {
        let mut s = sim_on(net.clone(), config, 9);
        s.run(6000);
        (s.state_checksum(), s.stats().spawned)
    };
    let a = run(&with_line, demand(true));
    assert_eq!(a, run(&with_line, demand(true)));
    let plain = corridor(2, 300.0, 13.89).network();
    assert_eq!(run(&with_line, demand(false)), run(&plain, demand(true)));
    assert_ne!(a, run(&plain, demand(true)));
}

#[test]
fn summary_lists_transit_lines_only_when_there_are_any() {
    let net = Network::from_json(TRANSIT_FIXTURE).unwrap();
    let mut s = sim_on(net, config(15.0, 5.0), 1);
    s.run(3000);
    let summary = s.summary_json();
    assert!(
        summary.contains(r#""transit":[{"id":"t0","label":"13A","headway":300.0"#),
        "{summary}"
    );
    assert!(s.transit_json().starts_with(r#"[{"id":"t0""#));
    let mut plain = sim_on(corridor(1, 300.0, 13.89).network(), config(15.0, 5.0), 1);
    plain.run(10);
    assert!(!plain.summary_json().contains("transit"));
    assert_eq!(plain.transit_json(), "[]");
}

#[test]
fn headway_overrides_factor_and_validation() {
    let net = line_builder(1, &[], 300.0).network();
    let with = |json: &str| Simulation::new(net.clone(), SimConfig::from_json(json).unwrap(), 1);
    let headway = |json: &str| with(json).unwrap().transit_metrics().first().map(|m| m.headway);
    assert_eq!(headway("{}"), Some(300.0));
    assert_eq!(headway(r#"{"transit": {"headwayFactor": 0.5}}"#), Some(150.0));
    assert_eq!(headway(r#"{"transit": {"headways": {"t0": 90}}}"#), Some(90.0));
    assert_eq!(headway(r#"{"transit": {"headways": {"t0": 0}}}"#), None);
    assert_eq!(headway(r#"{"transit": {"enabled": false}}"#), None);
    let mut no_osm = line_builder(1, &[], 300.0);
    no_osm.package.transit_lines[0].headway = None;
    let s = Simulation::new(
        no_osm.network(),
        SimConfig::from_json(r#"{"transit": {"defaultHeadway": 480}}"#).unwrap(),
        1,
    )
    .unwrap();
    assert_eq!(s.transit_metrics()[0].headway, 480.0);
    assert!(
        with(r#"{"transit": {"headways": {"t9": 90}}}"#)
            .unwrap_err()
            .contains("unknown line 't9'")
    );
    assert!(
        with(r#"{"transit": {"vehicleType": "tram"}}"#)
            .unwrap_err()
            .contains("vehicleType")
    );
    for bad in [
        r#"{"transit": {"dwellTime": -1}}"#,
        r#"{"transit": {"headwayFactor": 0}}"#,
        r#"{"transit": {"defaultHeadway": 0}}"#,
        r#"{"transit": {"headways": {"t0": -5}}}"#,
    ] {
        assert!(
            SimConfig::from_json(bad).unwrap_err().contains("transit"),
            "{bad}"
        );
    }
}
