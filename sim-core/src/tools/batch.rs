//! Headless batch runner (#84): runs a network package + configuration for several seeds and
//! writes the aggregated JSON results (and optionally the lane-cell buckets per seed).
//!
//! `cargo run --release --bin batch -- --package net.json --config config.json --seed-count 5
//!  --duration 3600 --warmup 300 --out results.json --cells-dir cells/ --threads 4`

use std::fs;
use std::process::ExitCode;

use trafficsim_sim_core::batch::{self, SeedResult};
use trafficsim_sim_core::config::SimConfig;
use trafficsim_sim_core::network::Network;

fn run(args: &[String]) -> Result<(), String> {
    let a = batch::parse_args(args)?;
    let read = |path: &str| fs::read_to_string(path).map_err(|e| format!("{path}: {e}"));
    let net = Network::from_json(&read(&a.package)?).map_err(|e| e.0)?;
    let config = match &a.config {
        Some(path) => SimConfig::from_json(&read(path)?)?,
        None => SimConfig::default(),
    };
    let cells = a.cells_dir.is_some();
    let config = batch::batch_config(config, a.duration, a.warmup, cells);
    let mut results: Vec<Result<SeedResult, String>> = Vec::with_capacity(a.seeds.len());
    for chunk in a.seeds.chunks(a.threads) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|&seed| {
                    let (net, config) = (&net, &config);
                    scope.spawn(move || batch::run_seed(net, config, seed, a.duration, a.warmup, cells))
                })
                .collect();
            for h in handles {
                results.push(h.join().unwrap_or_else(|_| Err("a run panicked".into())));
            }
        });
    }
    let results: Vec<SeedResult> = results.into_iter().collect::<Result<_, _>>()?;
    if let Some(dir) = &a.cells_dir {
        fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))?;
        for r in &results {
            let path = format!("{dir}/cells-seed-{}.bin", r.seed);
            fs::write(&path, r.cells.as_deref().unwrap_or_default()).map_err(|e| format!("{path}: {e}"))?;
        }
    }
    let doc = batch::aggregate(&results, a.duration, a.warmup).to_string();
    match &a.out {
        Some(path) => fs::write(path, doc).map_err(|e| format!("{path}: {e}")),
        None => {
            println!("{doc}");
            Ok(())
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
