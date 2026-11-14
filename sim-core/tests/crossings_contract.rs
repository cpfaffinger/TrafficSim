//! Contract test (ADR-0020, #86): a package compiled by the backend with every crossing kind (zebra,
//! uncontrolled, push-button signal, implicit junction crosswalks) runs with pedestrians. The
//! fixture is written by the .NET `CrossingFixtureTests` (backend/tests/TrafficSim.Application.Tests).

use trafficsim_sim_core::sim::{PEDESTRIAN_STRIDE, Simulation};

const PACKAGE: &str = include_str!("../../docs/architecture/fixtures/network-package-crossings-v1.json");

fn run(seed: u64, config: &str) -> Simulation {
    let mut sim = Simulation::from_json(PACKAGE, config, seed).expect("valid package and config");
    sim.run(6000);
    sim
}

#[test]
fn compiled_crossings_run_with_pedestrians() {
    let config = r#"{"defaultDemand": 400, "pedestrians": {"demandFactor": 3}}"#;
    let sim = run(7, config);
    let kpi = sim.pedestrian_summary().expect("pedestrians run");
    assert_eq!(kpi.crossings.len(), 7);
    for c in &kpi.crossings {
        assert!(
            c.served > 0,
            "crossing {} ({}) served nobody: {kpi:?}",
            c.id,
            c.kind
        );
    }
    assert!(kpi.vehicle_stops > 0 && kpi.signal_phases > 0, "{kpi:?}");
    assert!(sim.stats().arrived > 100);
    assert_eq!(sim.pedestrian_snapshot().len() % PEDESTRIAN_STRIDE, 0);
    assert_eq!(sim.state_checksum(), run(7, config).state_checksum());
}

#[test]
fn pedestrians_cost_vehicles_time() {
    let with = run(3, r#"{"defaultDemand": 400, "pedestrians": {"demandFactor": 3}}"#);
    let without = run(3, r#"{"defaultDemand": 400, "pedestrians": {"enabled": false}}"#);
    assert!(without.pedestrian_summary().is_none());
    let (a, b) = (with.summary().network, without.summary().network);
    assert!(
        a.delay_hours > b.delay_hours,
        "{} vs {}",
        a.delay_hours,
        b.delay_hours
    );
}
