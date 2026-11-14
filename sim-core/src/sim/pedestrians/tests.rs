use super::*;
use crate::config::PerceptionConfig;
use crate::package::{self, CrossingLink, NodeControl, Priority};
use crate::sim::Vehicle;
use crate::synth::{NetBuilder, crossroads, fixture_network};
use crate::vehicle::{VehicleClass, VehicleParams};

fn car() -> VehicleParams {
    VehicleParams::for_class(VehicleClass::Car)
}

/// No boundary demand, instantaneous perception (exact kinematics), no pedestrian demand.
fn config() -> SimConfig {
    let mut c = SimConfig {
        default_demand: Some(0.0),
        perception: PerceptionConfig {
            enabled: false,
            ..PerceptionConfig::default()
        },
        ..SimConfig::default()
    };
    c.pedestrians.demand_factor = 0.0;
    c
}

fn crossing(
    id: &str,
    kind: package::CrossingKind,
    width: f64,
    links: &[(&str, f64, [f64; 2])],
) -> package::Crossing {
    package::Crossing {
        id: id.into(),
        kind,
        signal_group: None,
        signal_mode: None,
        width,
        depth: if kind == package::CrossingKind::Signal {
            4.0
        } else {
            3.0
        },
        demand: 300.0,
        geometry: vec![[0.0, 0.0, 0.0], [0.0, width, 0.0]],
        links: links
            .iter()
            .map(|&(l, p, s)| CrossingLink {
                link: l.into(),
                position: p,
                span: s,
            })
            .collect(),
    }
}

/// Two-way road A ⇄ B (400 m, one lane per direction) with crossing `x0` in the middle; the first
/// kerb is the right kerb of `ab`.
fn road(kind: package::CrossingKind) -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("B", 400.0, 0.0, NodeControl::Boundary)
        .link("ab", "A", "B", 1, 13.9)
        .link("ba", "B", "A", 1, 13.9);
    b.package.crossings = Some(vec![crossing(
        "x0",
        kind,
        6.5,
        &[("ab", 200.0, [0.0, 3.25]), ("ba", 200.0, [3.25, 6.5])],
    )]);
    b
}

fn sim(b: &NetBuilder, config: SimConfig) -> Simulation {
    Simulation::new(b.network(), config, 7).unwrap()
}

/// Pedestrians of the snapshot: (crossing, position from the first kerb in m, state).
fn pedestrians(s: &Simulation, width: f64) -> Vec<(u32, f64, u32)> {
    s.pedestrian_snapshot()
        .chunks(PEDESTRIAN_STRIDE)
        .map(|p| (p[0] as u32, f64::from(p[1]) * width, p[3] as u32))
        .collect()
}

fn vehicle(s: &Simulation, id: u32) -> Option<&Vehicle> {
    s.vehicles().iter().find(|v| v.id == id)
}

fn link_of(s: &Simulation, v: &Vehicle) -> String {
    s.network().links[s.network().segment_link(v.seg) as usize]
        .id
        .clone()
}

fn served(s: &Simulation) -> u64 {
    s.pedestrian_summary().unwrap().served
}

/// No vehicle front inside the crossing `[centre - 1.5, centre + 1.5]` of `link` (or with its rear
/// still in it) while a walking pedestrian is within the link's span.
fn assert_no_conflict(s: &Simulation, link: &str, centre: f64, span: (f64, f64)) {
    let on_span = pedestrians(s, 6.5)
        .iter()
        .any(|&(_, pos, state)| state == 1 && pos > span.0 - 0.2 && pos < span.1 + 0.2);
    if !on_span {
        return;
    }
    for v in s.vehicles() {
        if s.network().is_lane(v.seg) && link_of(s, v) == link {
            let (front, rear) = (v.pos, v.pos - v.params.length);
            assert!(
                front < centre - 1.5 || rear > centre + 1.5,
                "vehicle {} at {front:.2} on the crossing with a pedestrian on it (t={})",
                v.id,
                s.time()
            );
        }
    }
}

#[test]
fn zebra_vehicle_stops_for_a_pedestrian_when_it_can_stop_comfortably() {
    let mut s = sim(&road(package::CrossingKind::Zebra), config());
    let id = s.place_vehicle("ab", 0, 180.0, 5.0, "ab", car()).unwrap();
    s.add_pedestrian("x0", 0, 0.7).unwrap();
    let mut min_speed = f64::INFINITY;
    let mut min_acc = 0.0_f64;
    for _ in 0..400 {
        s.step();
        assert_no_conflict(&s, "ab", 200.0, (0.0, 3.25));
        if let Some(v) = vehicle(&s, id) {
            min_speed = min_speed.min(v.speed);
            min_acc = min_acc.min(v.acc);
        }
    }
    assert_eq!(served(&s), 1);
    assert!(min_speed < 0.5, "the vehicle stopped ({min_speed})");
    assert!(
        min_acc > -2.0 * 2.0 - 1e-9,
        "no harder than the emergency limit ({min_acc})"
    );
    let kpi = s.pedestrian_summary().unwrap();
    assert_eq!(kpi.vehicle_stops, 1);
    assert!(kpi.vehicle_delay_hours > 0.0);
    assert!(
        vehicle(&s, id).is_none_or(|v| v.pos > 205.0),
        "the vehicle went on"
    );
}

#[test]
fn zebra_pedestrian_waits_for_a_vehicle_that_cannot_stop() {
    let mut s = sim(&road(package::CrossingKind::Zebra), config());
    let id = s.place_vehicle("ab", 0, 185.0, 13.0, "ab", car()).unwrap();
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    let mut min_acc = 0.0_f64;
    let mut waited = false;
    let mut start = None;
    for _ in 0..300 {
        s.step();
        assert_no_conflict(&s, "ab", 200.0, (0.0, 3.25));
        if let Some(v) = vehicle(&s, id) {
            min_acc = min_acc.min(v.acc);
            if v.pos < 198.5 {
                waited |= pedestrians(&s, 6.5)[0].2 == 0;
            }
        }
        if start.is_none() && pedestrians(&s, 6.5).first().is_some_and(|p| p.2 == 1) {
            start = Some(s.time());
        }
    }
    assert!(waited, "the pedestrian waited while the vehicle approached");
    assert!(min_acc > -0.5, "the vehicle did not brake ({min_acc})");
    assert!(start.unwrap() > 1.0, "stepped out after the vehicle passed");
    assert_eq!(served(&s), 1);
    assert!(s.pedestrian_summary().unwrap().mean_delay.unwrap() > 1.0);
}

#[test]
fn uncontrolled_pedestrians_accept_gaps_only() {
    // Next vehicle 3.7 s away: shorter than 3.25 m / 1.3 m/s + 2 s → wait.
    let mut s = sim(&road(package::CrossingKind::Uncontrolled), config());
    let id = s.place_vehicle("ab", 0, 150.0, 13.0, "ab", car()).unwrap();
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    let mut start = None;
    for _ in 0..300 {
        s.step();
        assert_no_conflict(&s, "ab", 200.0, (0.0, 3.25));
        if let Some(v) = vehicle(&s, id) {
            assert!(v.acc > -0.5 && v.ped_hold.is_infinite(), "vehicle not disturbed");
        }
        if start.is_none() && pedestrians(&s, 6.5)[0].2 != 0 {
            start = Some(s.time());
        }
    }
    assert!(start.unwrap() > 3.5, "started after the vehicle ({start:?})");
    assert_eq!(served(&s), 1);

    // 11 s away: a sufficient gap, the pedestrian goes at once and the vehicle keeps its speed.
    let mut s = sim(&road(package::CrossingKind::Uncontrolled), config());
    let id = s.place_vehicle("ab", 0, 50.0, 13.0, "ab", car()).unwrap();
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    s.step();
    assert_eq!(pedestrians(&s, 6.5)[0].2, 1);
    for _ in 0..200 {
        s.step();
        if let Some(v) = vehicle(&s, id) {
            assert!(v.speed > 12.0, "no stop needed ({})", v.speed);
        }
    }
    assert_eq!(served(&s), 1);
}

#[test]
fn uncontrolled_pedestrians_wait_in_the_middle_for_the_other_direction() {
    let mut s = sim(&road(package::CrossingKind::Unmarked), config());
    let id = s.place_vehicle("ba", 0, 150.0, 13.0, "ba", car()).unwrap();
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    let mut paused_at = None;
    for _ in 0..300 {
        s.step();
        assert_no_conflict(&s, "ba", 200.0, (3.25, 6.5));
        if let Some(v) = vehicle(&s, id) {
            assert!(v.acc > -0.5, "the vehicle on the other half was not disturbed");
        }
        if let Some(&(_, pos, 2)) = pedestrians(&s, 6.5).first() {
            paused_at = Some(pos);
        }
    }
    assert!(
        (paused_at.unwrap() - 3.25).abs() < 1e-6,
        "waited on the centre line"
    );
    assert_eq!(served(&s), 1);
}

/// Mid-block push-button signal M on a two-way road: links aM/Mb and bM/Ma, group g0 (fixed-time
/// plan: green 0–60 s of 90 s) and the request crossing x0 at M.
fn push_button() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.trim = 0.0;
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("M", 200.0, 0.0, NodeControl::Signal)
        .node("B", 400.0, 0.0, NodeControl::Boundary)
        .link("aM", "A", "M", 1, 13.9)
        .link("Mb", "M", "B", 1, 13.9)
        .link("bM", "B", "M", 1, 13.9)
        .link("Ma", "M", "A", 1, 13.9)
        .connect("east", "aM", 0, "Mb", 0, Priority::Signal)
        .connect("west", "bM", 0, "Ma", 0, Priority::Signal)
        .signal("M", 90.0, &[("g0", 0.0, 60.0, 3.0)]);
    b.connector_mut("east").signal_group = Some("g0".into());
    b.connector_mut("west").signal_group = Some("g0".into());
    let mut x = crossing(
        "x0",
        package::CrossingKind::Signal,
        6.5,
        &[("aM", 200.0, [0.0, 3.25]), ("bM", 200.0, [3.25, 6.5])],
    );
    x.signal_group = Some("g0".into());
    x.signal_mode = Some(package::CrossingSignalMode::Request);
    b.package.crossings = Some(vec![x]);
    b
}

#[test]
fn push_button_signal_serves_a_pedestrian_phase_after_the_minimum_vehicle_green() {
    let mut s = sim(&push_button(), config());
    s.run(700);
    assert_eq!(
        s.signal_states(),
        vec![2],
        "rests in green without requests (fixed plan: red)"
    );
    s.add_pedestrian("x0", 1, 1.3).unwrap();
    let t0 = s.time();
    let mut changes = Vec::new();
    let mut last = 2;
    let mut walk_start = None;
    while changes.len() < 3 {
        s.step();
        let state = s.signal_states()[0];
        if state != last {
            changes.push((state, s.time() - t0));
            last = state;
        }
        if walk_start.is_none() && pedestrians(&s, 6.5).first().is_some_and(|p| p.2 == 1) {
            walk_start = Some(s.time() - t0);
        }
    }
    let close = |a: f64, b: f64| (a - b).abs() < 0.25;
    assert_eq!(changes.len(), 3, "{changes:?}");
    assert!(changes[0].0 == 1 && close(changes[0].1, 0.1), "{changes:?}");
    assert!(changes[1].0 == 0 && close(changes[1].1, 3.1), "{changes:?}");
    // all-red 2 s, walk 7 s, clearance 6.5 m / (1.3 × 0.85) m/s
    let green = 3.1 + 2.0 + 7.0 + 6.5 / (1.3 * 0.85);
    assert!(changes[2].0 == 2 && close(changes[2].1, green), "{changes:?}");
    assert!(close(walk_start.unwrap(), 5.1), "walk at {walk_start:?}");
    assert_eq!(served(&s), 1);
    assert_eq!(s.pedestrian_summary().unwrap().signal_phases, 1);

    // The next request waits for the minimum vehicle green.
    let green_at = s.time();
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    while s.signal_states()[0] == 2 {
        s.step();
    }
    let green_for = s.time() - green_at;
    assert!((green_for - 20.0).abs() < 0.25, "{green_for}");
}

#[test]
fn vehicles_stop_before_the_crosswalk_at_red_and_go_on_after_the_phase() {
    let mut s = sim(&push_button(), config());
    s.run(300);
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    let id = s.place_vehicle("aM", 0, 120.0, 12.0, "Mb", car()).unwrap();
    let mut stop_pos = None;
    for _ in 0..600 {
        s.step();
        assert_no_conflict(&s, "aM", 200.0, (0.0, 3.25));
        if let Some(v) = vehicle(&s, id)
            && v.speed < 0.05
            && stop_pos.is_none()
            && link_of(&s, v) == "aM"
        {
            stop_pos = Some(v.pos);
        }
    }
    let stop = stop_pos.expect("the vehicle stopped at red");
    assert!(
        stop < 200.0 - 2.0 - 1.0,
        "before the crosswalk, not on it ({stop})"
    );
    assert!(vehicle(&s, id).is_none(), "and left after the pedestrian phase");
    assert_eq!(served(&s), 1);
}

/// Signalised crossroads: east-west g0 (green 0–40 s), north-south g1 (45–85 s), crosswalk x0
/// across the north leg (first kerb on `Nout`), parallel to g0.
fn signal_crossroads() -> NetBuilder {
    let mut b = crossroads(NodeControl::Signal, Priority::Signal, Priority::Signal);
    b.signal("C", 90.0, &[("g0", 0.0, 40.0, 3.0), ("g1", 45.0, 85.0, 3.0)]);
    for c in &mut b.package.connectors {
        c.signal_group = Some(
            if c.from_link == "Win" || c.from_link == "Ein" {
                "g0"
            } else {
                "g1"
            }
            .into(),
        );
    }
    let n_in = b.package.links.iter().find(|l| l.id == "Nin").unwrap().length;
    let mut x = crossing(
        "x0",
        package::CrossingKind::Signal,
        6.5,
        &[("Nout", 2.0, [0.0, 3.25]), ("Nin", n_in - 2.0, [3.25, 6.5])],
    );
    x.signal_group = Some("g0".into());
    x.signal_mode = Some(package::CrossingSignalMode::Parallel);
    b.package.crossings = Some(vec![x]);
    b
}

#[test]
fn turning_vehicles_yield_to_pedestrians_walking_with_their_green() {
    let mut s = sim(&signal_crossroads(), config());
    let id = s.place_vehicle("Ein", 0, 236.0, 4.0, "Nout", car()).unwrap();
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    s.step();
    assert_eq!(pedestrians(&s, 6.5)[0].2, 1, "walks on the parallel green");
    let mut yielded = false;
    for _ in 0..400 {
        s.step();
        assert_no_conflict(&s, "Nout", 2.0, (0.0, 3.25));
        if let Some(v) = vehicle(&s, id) {
            yielded |= v.ped_hold.is_finite();
        }
    }
    assert!(yielded, "the right turner held for the pedestrian");
    assert_eq!(served(&s), 1);
    assert!(vehicle(&s, id).is_none_or(|v| link_of(&s, v) == "Nout"));
}

#[test]
fn pedestrians_do_not_start_on_the_conflicting_green() {
    let mut s = sim(&signal_crossroads(), config());
    s.run(500); // t = 50 s: g0 red, g1 green
    s.add_pedestrian("x0", 0, 1.3).unwrap();
    let mut start = None;
    for _ in 0..600 {
        s.step();
        if start.is_none() && pedestrians(&s, 6.5).first().is_some_and(|p| p.2 == 1) {
            start = Some(s.time());
        }
    }
    let start = start.unwrap();
    assert!(
        (start - 90.0).abs() < 0.25,
        "waited for the next g0 green ({start})"
    );
}

fn busy_road(seed: u64, peds: f64) -> Simulation {
    let mut c = config();
    c.default_demand = Some(500.0);
    c.pedestrians.demand_factor = 3.0 * peds; // 900 pedestrians per hour
    Simulation::new(road(package::CrossingKind::Zebra).network(), c, seed).unwrap()
}

#[test]
fn pedestrians_are_deterministic_and_affect_vehicles() {
    let mut a = busy_road(42, 1.0);
    let mut b = busy_road(42, 1.0);
    for _ in 0..20 {
        a.run(150);
        b.run(150);
        assert_eq!(a.state_checksum(), b.state_checksum());
        assert_eq!(a.pedestrian_snapshot(), b.pedestrian_snapshot());
    }
    let kpi = a.pedestrian_summary().unwrap();
    assert!(kpi.served > 20, "{kpi:?}");
    assert!(kpi.vehicle_stops > 0 && kpi.mean_delay.unwrap() >= 0.0, "{kpi:?}");
    assert_eq!(kpi.crossings[0].kind, "zebra");
    let mut c = busy_road(43, 1.0);
    c.run(3000);
    assert_ne!(a.state_checksum(), c.state_checksum());
    let mut none = busy_road(42, 0.0);
    none.run(3000);
    assert!(none.stats().arrived > a.stats().arrived.saturating_sub(5));
    assert_eq!(none.pedestrian_summary().unwrap().served, 0);
}

#[test]
fn arrivals_follow_the_demand_with_overrides_and_curves() {
    let mut c = config();
    c.pedestrians.demand_factor = 2.0;
    c.pedestrians.crossings.insert("x0".into(), 1800.0);
    let mut s = Simulation::new(road(package::CrossingKind::Zebra).network(), c.clone(), 3).unwrap();
    s.run(6000);
    let arrived = s.pedestrian_summary().unwrap().arrived as f64;
    assert!((arrived - 600.0).abs() < 90.0, "3600 ped/h for 10 min: {arrived}");
    c.pedestrians.curve = Some("night".into());
    c.curves.insert(
        "night".into(),
        crate::demand::TimeProfile {
            interval: 3600.0,
            factors: vec![0.0; 24],
        },
    );
    let mut s = Simulation::new(road(package::CrossingKind::Zebra).network(), c.clone(), 3).unwrap();
    s.run(6000);
    assert_eq!(s.pedestrian_summary().unwrap().arrived, 0);
    // Overrides for crossings the (edited) network no longer has are ignored.
    c.pedestrians.crossings.insert("x9".into(), 1.0);
    assert!(Simulation::new(road(package::CrossingKind::Zebra).network(), c, 3).is_ok());
}

#[test]
fn packages_without_crossings_or_disabled_pedestrians_run_unchanged() {
    let run = |net: Network, enabled: bool| {
        let mut c = SimConfig {
            default_demand: Some(700.0),
            ..SimConfig::default()
        };
        c.pedestrians.enabled = enabled;
        let mut s = Simulation::new(net, c, 42).unwrap();
        s.run(2000);
        (s.state_checksum(), s.summary_json(), s.stats_json())
    };
    let (a, summary, stats) = run(fixture_network(), true);
    assert_eq!(a, run(fixture_network(), false).0);
    assert!(!summary.contains("pedestrians") && !stats.contains("pedestrians"));

    let mut plain = road(package::CrossingKind::Zebra);
    plain.package.crossings = None;
    let with = road(package::CrossingKind::Zebra);
    assert_eq!(run(with.network(), false).0, run(plain.network(), true).0);
    let (_, summary, stats) = run(with.network(), true);
    assert!(summary.contains("\"pedestrians\"") && stats.contains("\"pedestrians\""));
    let mut off = Simulation::new(
        with.network(),
        {
            let mut c = config();
            c.pedestrians.enabled = false;
            c
        },
        1,
    )
    .unwrap();
    assert!(off.add_pedestrian("x0", 0, 1.3).unwrap_err().contains("disabled"));
    assert!(off.pedestrian_snapshot().is_empty() && off.pedestrian_summary().is_none());
    off.reset_metrics();
}

#[test]
fn snapshot_reports_waiting_and_walking_pedestrians() {
    let mut s = sim(&road(package::CrossingKind::Zebra), config());
    s.add_pedestrian("x0", 1, 1.3).unwrap();
    s.add_pedestrian("x0", 1, 1.3).unwrap();
    assert!(s.add_pedestrian("nope", 0, 1.3).is_err());
    let snap = s.pedestrian_snapshot();
    assert_eq!(snap.len(), 2 * PEDESTRIAN_STRIDE);
    assert_eq!(&snap[..5], &[0.0, 1.0, -1.0, 0.0, 0.0]);
    assert_eq!(snap[9], 1.0, "second waiting slot");
    s.run(20);
    let snap = s.pedestrian_snapshot();
    assert_eq!(snap[3], 1.0, "walking");
    assert!(snap[1] < 1.0 && snap[1] > 0.5 && snap[2] == -1.0);
    let stats = s.stats().pedestrians.unwrap();
    assert_eq!((stats.crossing, stats.waiting), (2, 0));
    s.reset_metrics();
    assert_eq!(s.pedestrian_summary().unwrap().arrived, 0);
}
