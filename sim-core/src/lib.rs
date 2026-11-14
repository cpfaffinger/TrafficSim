//! TrafficSim simulation core (ADR-0006, ADR-0007).
//!
//! The crate is deliberately free of I/O, wall-clock time and global state: inputs in,
//! state and metrics out. It compiles natively (for `cargo test` and future batch runners)
//! and to WebAssembly (for the browser worker, see [`wasm`]).

pub mod batch;
pub mod bench;
pub mod config;
pub mod demand;
pub mod detmath;
pub mod driver;
pub mod idm;
pub mod metrics;
pub mod network;
pub mod package;
pub mod ring;
pub mod rng;
pub mod routing;
pub mod signals;
pub mod sim;
pub mod synth;
pub mod vehicle;
pub mod wasm;

pub use idm::IdmParams;
pub use network::{Network, NetworkError};
pub use ring::{RingRoad, RingRoadConfig};
pub use rng::Pcg32;
pub use routing::Router;
pub use sim::{SNAPSHOT_STRIDE, Simulation, Stats};
pub use vehicle::{VehicleClass, VehicleParams};
