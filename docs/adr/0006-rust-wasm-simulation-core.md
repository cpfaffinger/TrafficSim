# ADR-0006: Simulation core in Rust/WebAssembly inside a Web Worker

- Status: Accepted
- Date: 2026-11-14

## Context

Every vehicle is simulated individually (target ≥ 10 000 vehicles at ≥ 10× real time). The core
must be fast, deterministic and well-testable, and it must not block rendering.

## Decision

- The simulation core is a Rust crate (`sim-core/`) compiled to `wasm32-unknown-unknown` and bound with
  `wasm-bindgen` (`--target web`). The `wasm-bindgen` version is pinned exactly in `Cargo.toml` and in the
  build tooling (CLI and library must match).
- It runs in a dedicated **Web Worker**. State is data-oriented (structure of arrays). The worker hands
  compact `Float32Array` snapshots of vehicle state to the renderer — via `postMessage` transfer first,
  `SharedArrayBuffer` later (the app already sends COOP/COEP headers).
- The crate also builds natively (`rlib`), so `cargo test` runs the full model without a browser and a
  headless server-side batch runner remains possible.
- The core has no DOM, no wall-clock time and no global RNG: inputs in, state and metrics out.

## Consequences

- A second toolchain (cargo + wasm-bindgen-cli) in CI and in the Docker build; developers touching
  the core need Rust installed (or use the Docker build).
- The JS↔WASM boundary stays coarse-grained (one `step(n)` call per frame, bulk buffers).

## Alternatives considered

- TypeScript with typed arrays: single toolchain, but less headroom and weaker determinism guarantees.
- C# via Blazor WebAssembly: large runtime, slower numeric code in the browser.
