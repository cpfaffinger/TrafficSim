//! TrafficSim simulation core (ADR-0006, ADR-0007).
//!
//! The crate is deliberately free of I/O, wall-clock time and global state: inputs in,
//! state and metrics out. It compiles natively (for `cargo test` and future batch runners)
//! and to WebAssembly (for the browser worker, see [`wasm`]).

pub mod idm;
pub mod ring;
pub mod rng;
pub mod wasm;

pub use idm::IdmParams;
pub use ring::{RingRoad, RingRoadConfig};
pub use rng::Pcg32;
