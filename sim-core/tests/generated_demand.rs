//! Contract test (#115): every demand the backend generates for the golden fixture network is a valid
//! sim-core configuration and produces traffic. The fixture is written by the .NET
//! `ScenarioGeneratorTests` (backend/tests/TrafficSim.Application.Tests).

use std::collections::BTreeMap;
use trafficsim_sim_core::sim::Simulation;

const PACKAGE: &str = include_str!("../../docs/architecture/fixtures/network-package-v1.json");
const DEMANDS: &str = include_str!("../../docs/architecture/fixtures/generated-demand-v1.json");

#[test]
fn every_generated_scenario_runs_in_the_sim_core() {
    let demands: BTreeMap<String, serde_json::Value> = serde_json::from_str(DEMANDS).expect("valid JSON");
    assert!(demands.len() >= 6, "expected the standard scenario set");
    for (key, demand) in &demands {
        let mut sim = Simulation::from_json(PACKAGE, &demand.to_string(), 7)
            .unwrap_or_else(|e| panic!("scenario '{key}' is not a valid sim config: {e}"));
        for _ in 0..6000 {
            sim.step();
        }
        let stats = sim.stats();
        assert!(stats.spawned > 0, "scenario '{key}' generated no vehicles");
    }
}
