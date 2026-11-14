//! Benchmark harness (#78): throughput of the grid, motorway and city scenarios with and without
//! metrics, optionally checked against performance budgets.
//!
//! `cargo run --release --bin bench -- [--scenario all|grid|motorway|city] [--scale 1]
//!  [--seconds 300] [--repeat 1] [--check benches/budgets.json]`
//!
//! Prints one JSON report per scenario and variant; exits with 1 if a budget is violated.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::time::Instant;

use trafficsim_sim_core::Simulation;
use trafficsim_sim_core::bench::{self, Budget, Report};

fn measure(name: &str, sim: &mut Simulation, metrics: bool, seconds: f64) -> Report {
    let steps = (seconds / sim.time_step()).round() as u64;
    let (mut vehicle_steps, mut max) = (0u64, 0u64);
    let start = Instant::now();
    for _ in 0..steps {
        sim.step();
        let n = sim.vehicle_count() as u64;
        vehicle_steps += n;
        max = max.max(n);
    }
    let wall = start.elapsed().as_secs_f64();
    Report::new(name, metrics, steps, sim.time_step(), vehicle_steps, max, wall)
}

fn run(args: &[String]) -> Result<bool, String> {
    let (mut which, mut scale, mut seconds, mut repeat, mut budgets) = ("all".to_string(), 1, 300.0, 1, None);
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let value = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
        let number = || value.parse::<f64>().map_err(|_| format!("{flag}: not a number"));
        match flag.as_str() {
            "--scenario" => which = value.clone(),
            "--scale" => scale = number()? as usize,
            "--seconds" => seconds = number()?,
            "--repeat" => repeat = (number()? as usize).max(1),
            "--check" => budgets = Some(value.clone()),
            other => return Err(format!("unknown argument '{other}'")),
        }
    }
    let names: Vec<&str> = if which == "all" {
        bench::SCENARIOS.to_vec()
    } else {
        vec![which.as_str()]
    };
    let mut reports = Vec::new();
    for name in names {
        let s = bench::scenario(name, scale).ok_or_else(|| format!("unknown scenario '{name}'"))?;
        let mut warm = Simulation::new(s.network, s.config, 1)?;
        warm.run((s.warmup / warm.time_step()).round() as usize);
        // Same state for both variants; the faster of `repeat` runs reduces timing noise.
        let mut best: [Option<Report>; 2] = [None, None];
        for _ in 0..repeat {
            for metrics in [false, true] {
                let mut sim = warm.clone();
                if !metrics {
                    sim.disable_metrics();
                }
                let r = measure(name, &mut sim, metrics, seconds);
                let slot = &mut best[usize::from(metrics)];
                if slot.as_ref().is_none_or(|b| r.wall_seconds < b.wall_seconds) {
                    *slot = Some(r);
                }
            }
        }
        for r in best.into_iter().flatten() {
            println!("{}", serde_json::to_string(&r).unwrap_or_default());
            reports.push(r);
        }
    }
    let Some(path) = budgets else {
        return Ok(true);
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?;
    let budgets: BTreeMap<String, Budget> =
        serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let violations = bench::check(&reports, &budgets);
    for v in &violations {
        eprintln!("budget violated: {v}");
    }
    Ok(violations.is_empty())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
