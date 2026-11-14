# sim-core

Deterministic microscopic traffic simulation core (Rust → WebAssembly), see
[ADR-0006](../docs/adr/0006-rust-wasm-simulation-core.md) and [ADR-0007](../docs/adr/0007-microscopic-traffic-model.md).

```bash
cargo test                       # native unit tests
cargo clippy --all-targets -- -D warnings
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir ../frontend/src/generated/sim-core \
  target/wasm32-unknown-unknown/release/trafficsim_sim_core.wasm
```

`wasm-bindgen-cli` must match the pinned `wasm-bindgen` version in `Cargo.toml`
(`cargo install wasm-bindgen-cli --version 0.2.130 --locked`). The frontend runs these steps with
`npm run build:wasm`.
