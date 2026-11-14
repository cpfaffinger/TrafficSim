//! Headless batch runs (#84): N seeds of one network package + configuration, aggregated into
//! one JSON document. Pure library code; the `batch` binary adds file I/O and threads.
//!
//! Output (`formatVersion` 1):
//!
//! ```json
//! {"formatVersion": 1, "seeds": [1, 2], "duration": 3600, "warmup": 300,
//!  "network": {"arrived": …, "meanSpeed": …, …},            // mean over seeds
//!  "links": [{"id": "l1", "meanSpeed": …, "flow": …, "density": …, "delay": …,
//!             "queueMax": …, …}],                          // mean over seeds, package order
//!  "runs": [{"seed": 1, "checksum": "…", "summary": {…}}]}  // full summary per seed
//! ```

use serde_json::{Map, Value, json};

use crate::config::SimConfig;
use crate::network::Network;
use crate::sim::{Simulation, Summary};

/// Command-line arguments of the batch runner.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchArgs {
    pub package: String,
    pub config: Option<String>,
    pub seeds: Vec<u64>,
    /// Measured duration after the warm-up (s).
    pub duration: f64,
    pub warmup: f64,
    pub out: Option<String>,
    pub cells_dir: Option<String>,
    pub threads: usize,
}

pub const USAGE: &str = "usage: batch --package <network.json> [--config <config.json>] \
[--seeds 1,2,3 | --seed-count N] [--duration 3600] [--warmup 300] [--out results.json] \
[--cells-dir DIR] [--threads N]";

/// Parses the arguments (without the program name).
pub fn parse_args(args: &[String]) -> Result<BatchArgs, String> {
    let mut a = BatchArgs {
        package: String::new(),
        config: None,
        seeds: vec![1],
        duration: 3600.0,
        warmup: 300.0,
        out: None,
        cells_dir: None,
        threads: 1,
    };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let mut value = || it.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        let number = |v: String| {
            v.parse::<f64>()
                .map_err(|_| format!("{flag}: '{v}' is not a number"))
        };
        match flag.as_str() {
            "--package" => a.package = value()?,
            "--config" => a.config = Some(value()?),
            "--seeds" => {
                a.seeds = value()?
                    .split(',')
                    .map(|s| s.trim().parse::<u64>().map_err(|_| format!("invalid seed '{s}'")))
                    .collect::<Result<_, _>>()?;
            }
            "--seed-count" => {
                let n = number(value()?)? as u64;
                a.seeds = (1..=n.max(1)).collect();
            }
            "--duration" => a.duration = number(value()?)?,
            "--warmup" => a.warmup = number(value()?)?,
            "--out" => a.out = Some(value()?),
            "--cells-dir" => a.cells_dir = Some(value()?),
            "--threads" => a.threads = (number(value()?)? as usize).max(1),
            "--help" | "-h" => return Err(USAGE.into()),
            other => return Err(format!("unknown argument '{other}'\n{USAGE}")),
        }
    }
    if a.package.is_empty() {
        return Err(format!("--package is required\n{USAGE}"));
    }
    if !(a.duration.is_finite() && a.duration > 0.0 && a.warmup.is_finite() && a.warmup >= 0.0) {
        return Err("--duration must be positive and --warmup non-negative".into());
    }
    if a.seeds.is_empty() {
        return Err("no seeds".into());
    }
    Ok(a)
}

/// Result of one seed.
#[derive(Debug, Clone)]
pub struct SeedResult {
    pub seed: u64,
    pub checksum: u64,
    pub summary: Summary,
    /// All lane-cell buckets of the run (`lane-cells-v1`), if requested.
    pub cells: Option<Vec<u8>>,
}

/// Configuration for a batch: metrics on, enough bucket history for the whole run if cells are
/// written.
pub fn batch_config(mut config: SimConfig, duration: f64, warmup: f64, cells: bool) -> SimConfig {
    config.metrics.enabled = true;
    if cells {
        let buckets = ((duration + warmup) / config.metrics.bucket_duration).ceil() as u32 + 1;
        config.metrics.max_buckets = config.metrics.max_buckets.max(buckets);
    }
    config
}

/// Runs one seed: warm-up, metrics reset, measured duration.
pub fn run_seed(
    net: &Network,
    config: &SimConfig,
    seed: u64,
    duration: f64,
    warmup: f64,
    cells: bool,
) -> Result<SeedResult, String> {
    let mut sim = Simulation::new(net.clone(), config.clone(), seed)?;
    let dt = sim.time_step();
    let steps = |s: f64| (s / dt).round() as usize;
    sim.run(steps(warmup));
    sim.reset_metrics();
    sim.run(steps(duration));
    Ok(SeedResult {
        seed,
        checksum: sim.state_checksum(),
        summary: sim.summary(),
        cells: cells.then(|| sim.lane_cells_since(0)),
    })
}

/// Field-wise mean of flat JSON objects: numbers are averaged over the objects where they are
/// numbers (null if none), other values are taken from the first object.
fn mean_objects(objects: &[&Value]) -> Value {
    let Some(first) = objects.first().and_then(|o| o.as_object()) else {
        return Value::Null;
    };
    let mut out = Map::new();
    for (key, v) in first {
        let numbers: Vec<f64> = objects.iter().filter_map(|o| o.get(key)?.as_f64()).collect();
        let value = if v.is_number() || (v.is_null() && !numbers.is_empty()) {
            if numbers.is_empty() {
                Value::Null
            } else {
                json!(numbers.iter().sum::<f64>() / numbers.len() as f64)
            }
        } else if v.is_null() {
            Value::Null
        } else {
            v.clone()
        };
        out.insert(key.clone(), value);
    }
    Value::Object(out)
}

/// Aggregates seed results into the batch JSON document.
pub fn aggregate(results: &[SeedResult], duration: f64, warmup: f64) -> Value {
    let summaries: Vec<Value> = results
        .iter()
        .map(|r| serde_json::to_value(&r.summary).unwrap_or(Value::Null))
        .collect();
    let networks: Vec<&Value> = summaries.iter().map(|s| &s["network"]).collect();
    let link_count = summaries
        .first()
        .and_then(|s| s["links"].as_array())
        .map_or(0, Vec::len);
    let links: Vec<Value> = (0..link_count)
        .map(|i| {
            let per_seed: Vec<&Value> = summaries.iter().map(|s| &s["links"][i]).collect();
            mean_objects(&per_seed)
        })
        .collect();
    let runs: Vec<Value> = results
        .iter()
        .zip(summaries.iter())
        .map(|(r, s)| json!({"seed": r.seed, "checksum": format!("{:016x}", r.checksum), "summary": s}))
        .collect();
    json!({
        "formatVersion": 1,
        "seeds": results.iter().map(|r| r.seed).collect::<Vec<_>>(),
        "duration": duration,
        "warmup": warmup,
        "network": mean_objects(&networks),
        "links": links,
        "runs": runs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synth::FIXTURE;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn parses_arguments() {
        let a = parse_args(&args(
            "--package net.json --config c.json --seeds 3,4 --duration 60 --warmup 10 --out o.json --cells-dir d --threads 2",
        ))
        .unwrap();
        assert_eq!(a.package, "net.json");
        assert_eq!(a.config.as_deref(), Some("c.json"));
        assert_eq!(a.seeds, [3, 4]);
        assert_eq!((a.duration, a.warmup, a.threads), (60.0, 10.0, 2));
        assert_eq!(
            (a.out.as_deref(), a.cells_dir.as_deref()),
            (Some("o.json"), Some("d"))
        );
        assert_eq!(
            parse_args(&args("--package p --seed-count 3")).unwrap().seeds,
            [1, 2, 3]
        );
        for (bad, needle) in [
            ("", "--package is required"),
            ("--package", "needs a value"),
            ("--package p --duration x", "not a number"),
            ("--package p --duration 0", "positive"),
            ("--package p --seeds a", "invalid seed"),
            ("--package p --bogus", "unknown argument"),
            ("--help", "usage"),
        ] {
            let e = parse_args(&args(bad)).unwrap_err();
            assert!(e.contains(needle), "{bad}: {e}");
        }
    }

    #[test]
    fn runs_seeds_and_aggregates_per_link_metrics() {
        let net = Network::from_json(FIXTURE).unwrap();
        let config = batch_config(
            SimConfig::from_json(r#"{"defaultDemand": 600}"#).unwrap(),
            120.0,
            30.0,
            true,
        );
        assert!(config.metrics.max_buckets >= 6);
        let results: Vec<SeedResult> = [1, 2]
            .iter()
            .map(|&seed| run_seed(&net, &config, seed, 120.0, 30.0, true).unwrap())
            .collect();
        assert_ne!(results[0].checksum, results[1].checksum);
        let again = run_seed(&net, &config, 1, 120.0, 30.0, false).unwrap();
        assert_eq!(again.checksum, results[0].checksum, "deterministic per seed");
        assert!(again.cells.is_none());
        let cells = crate::metrics::cells::LaneCells::decode(results[0].cells.as_ref().unwrap()).unwrap();
        assert_eq!(cells.buckets.len(), 5);
        let doc = aggregate(&results, 120.0, 30.0);
        assert_eq!(doc["formatVersion"], 1);
        assert_eq!(doc["seeds"], json!([1, 2]));
        let links = doc["links"].as_array().unwrap();
        assert_eq!(links.len(), net.links.len());
        let l1 = &links[0];
        assert_eq!(l1["id"], "l1");
        for key in ["meanSpeed", "flow", "density", "delay", "queueMax"] {
            assert!(l1[key].is_number(), "{key}: {l1}");
        }
        let flows: Vec<f64> = results.iter().map(|r| r.summary.links[0].flow).collect();
        assert!((l1["flow"].as_f64().unwrap() - (flows[0] + flows[1]) / 2.0).abs() < 1e-9);
        assert!(doc["network"]["arrived"].as_f64().unwrap() > 0.0);
        assert_eq!(doc["runs"].as_array().unwrap().len(), 2);
        assert!(
            run_seed(
                &net,
                &SimConfig {
                    time_step: 5.0,
                    ..config
                },
                1,
                1.0,
                0.0,
                false
            )
            .is_err()
        );
    }

    #[test]
    fn means_skip_nulls_and_keep_strings() {
        let a = json!({"id": "x", "v": 1.0, "n": null, "m": null});
        let b = json!({"id": "x", "v": 3.0, "n": 4.0, "m": null});
        let m = mean_objects(&[&a, &b]);
        assert_eq!(m, json!({"id": "x", "v": 2.0, "n": 4.0, "m": null}));
        assert_eq!(mean_objects(&[]), Value::Null);
    }
}
