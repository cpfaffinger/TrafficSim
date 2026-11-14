//! Benchmark scenarios and performance budgets (#78).
//!
//! The library side is pure: scenario builders, the report arithmetic and the budget check.
//! Wall-clock timing happens in the `bench` binary (`cargo run --release --bin bench`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::config::SimConfig;
use crate::network::Network;
use crate::synth;

/// A benchmark scenario: network and configuration.
#[derive(Debug, Clone)]
pub struct Scenario {
    pub name: &'static str,
    pub network: Network,
    pub config: SimConfig,
    /// Simulated warm-up before timing (s).
    pub warmup: f64,
}

/// Names of the built-in scenarios.
pub const SCENARIOS: [&str; 3] = ["grid", "motorway", "city"];

/// Builds scenario `name` at `scale` (1 = default size).
pub fn scenario(name: &str, scale: usize) -> Option<Scenario> {
    let scale = scale.max(1);
    let demand = |vph: f64| SimConfig {
        default_demand: Some(vph),
        ..SimConfig::default()
    };
    Some(match name {
        // Priority junctions, two lanes per direction: dense urban traffic with lane changes.
        "grid" => Scenario {
            name: "grid",
            network: synth::grid(20 * scale, 2).network(),
            config: demand(900.0),
            warmup: 300.0,
        },
        // Weaving units with on- and off-ramps at motorway speed.
        "motorway" => Scenario {
            name: "motorway",
            network: synth::motorway_chain(40 * scale).network(),
            config: demand(1200.0),
            warmup: 600.0,
        },
        // Signalised grid with green waves and a mixed fleet and driver population.
        "city" => Scenario {
            name: "city",
            network: synth::signal_grid(16 * scale, 2).network(),
            config: SimConfig {
                vehicle_mix: [
                    ("car", 85.0),
                    ("van", 8.0),
                    ("truck", 4.0),
                    ("bus", 2.0),
                    ("motorcycle", 1.0),
                ]
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect(),
                driver_mix: [
                    ("average", 5.0),
                    ("attentive", 2.0),
                    ("aggressive", 2.0),
                    ("distracted", 1.0),
                ]
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect(),
                ..demand(700.0)
            },
            warmup: 300.0,
        },
        _ => return None,
    })
}

/// Measured throughput of one scenario.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub scenario: String,
    pub metrics: bool,
    pub steps: u64,
    pub mean_vehicles: f64,
    pub max_vehicles: u64,
    pub wall_seconds: f64,
    /// Microseconds per vehicle-step.
    pub us_per_vehicle_step: f64,
    /// Simulated seconds per wall-clock second.
    pub real_time_factor: f64,
    /// Vehicles that could be simulated at 1× real time at this cost (vehicles × factor).
    pub vehicles_at_real_time: f64,
}

impl Report {
    pub fn new(
        scenario: &str,
        metrics: bool,
        steps: u64,
        dt: f64,
        vehicle_steps: u64,
        max_vehicles: u64,
        wall_seconds: f64,
    ) -> Self {
        let wall = wall_seconds.max(1e-9);
        let mean = vehicle_steps as f64 / steps.max(1) as f64;
        let factor = steps as f64 * dt / wall;
        Self {
            scenario: scenario.into(),
            metrics,
            steps,
            mean_vehicles: mean,
            max_vehicles,
            wall_seconds,
            us_per_vehicle_step: wall * 1e6 / vehicle_steps.max(1) as f64,
            real_time_factor: factor,
            vehicles_at_real_time: mean * factor,
        }
    }
}

/// Performance budget of one scenario (`benches/budgets.json`).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    /// Mean vehicles the scenario must reach (otherwise the measurement is not meaningful).
    pub min_vehicles: f64,
    /// Lowest acceptable real-time factor at that load.
    pub min_real_time_factor: f64,
    /// Highest acceptable cost per vehicle-step (µs).
    pub max_us_per_vehicle_step: f64,
    /// Highest acceptable metrics overhead (relative, e.g. 0.1 = 10 %).
    #[serde(default = "default_overhead")]
    pub max_metrics_overhead: f64,
}

fn default_overhead() -> f64 {
    0.1
}

/// Budget violations of a set of reports (pairs of runs with and without metrics).
pub fn check(reports: &[Report], budgets: &BTreeMap<String, Budget>) -> Vec<String> {
    let mut violations = Vec::new();
    for r in reports.iter().filter(|r| r.metrics) {
        let Some(b) = budgets.get(&r.scenario) else {
            continue;
        };
        if r.mean_vehicles < b.min_vehicles {
            violations.push(format!(
                "{}: {:.0} vehicles on average, budget needs at least {:.0}",
                r.scenario, r.mean_vehicles, b.min_vehicles
            ));
        }
        if r.real_time_factor < b.min_real_time_factor {
            violations.push(format!(
                "{}: {:.2}x real time, budget {:.2}x",
                r.scenario, r.real_time_factor, b.min_real_time_factor
            ));
        }
        if r.us_per_vehicle_step > b.max_us_per_vehicle_step {
            violations.push(format!(
                "{}: {:.3} us per vehicle-step, budget {:.3}",
                r.scenario, r.us_per_vehicle_step, b.max_us_per_vehicle_step
            ));
        }
        if let Some(base) = reports.iter().find(|o| !o.metrics && o.scenario == r.scenario) {
            let overhead = r.us_per_vehicle_step / base.us_per_vehicle_step.max(1e-12) - 1.0;
            if overhead > b.max_metrics_overhead {
                violations.push(format!(
                    "{}: metrics overhead {:.1} %, budget {:.1} %",
                    r.scenario,
                    overhead * 100.0,
                    b.max_metrics_overhead * 100.0
                ));
            }
        }
    }
    violations
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::Simulation;

    #[test]
    fn scenarios_build_and_run() {
        for name in SCENARIOS {
            let s = scenario(name, 1).unwrap();
            assert_eq!(s.name, name);
            let mut sim = Simulation::new(s.network, s.config, 1).unwrap();
            sim.run(200);
            assert!(sim.vehicle_count() > 10, "{name}");
        }
        assert!(scenario("moon", 1).is_none());
        let city = scenario("city", 1).unwrap();
        assert!(city.network.signals.group_count() >= 2 * 16 * 16);
    }

    #[test]
    fn reports_and_budget_checks() {
        let r = Report::new("grid", true, 1000, 0.1, 10_000_000, 12_000, 5.0);
        assert_eq!(r.mean_vehicles, 10_000.0);
        assert!((r.real_time_factor - 20.0).abs() < 1e-9);
        assert!((r.us_per_vehicle_step - 0.5).abs() < 1e-9);
        assert_eq!(r.vehicles_at_real_time, 200_000.0);
        let base = Report::new("grid", false, 1000, 0.1, 10_000_000, 12_000, 4.0);
        let budgets: BTreeMap<String, Budget> = serde_json::from_str(
            r#"{"grid": {"minVehicles": 12000, "minRealTimeFactor": 30, "maxUsPerVehicleStep": 0.4}}"#,
        )
        .unwrap();
        let v = check(&[r.clone(), base], &budgets);
        assert_eq!(v.len(), 4, "{v:?}");
        assert!(v[3].contains("metrics overhead 25.0 %"));
        let relaxed: BTreeMap<String, Budget> = serde_json::from_str(
            r#"{"grid": {"minVehicles": 5000, "minRealTimeFactor": 1, "maxUsPerVehicleStep": 1, "maxMetricsOverhead": 0.5}}"#,
        )
        .unwrap();
        assert!(check(std::slice::from_ref(&r), &relaxed).is_empty());
        assert!(check(&[r], &BTreeMap::new()).is_empty());
    }
}
