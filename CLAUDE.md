# TrafficSim — guide for AI coding agents

Read first: [docs/concept.md](docs/concept.md), [docs/constraints.md](docs/constraints.md),
[docs/adr/README.md](docs/adr/README.md), [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

| Path | What |
|------|------|
| `backend/` | .NET 10 modular monolith: `Domain` (pure) ← `Application` (ports, use cases) ← `Providers` (ACLs) / `Infrastructure` (PostGIS) ← `Api` (composition root) |
| `sim-core/` | Rust crate, compiled natively for tests and to WASM for the browser worker |
| `frontend/` | Vite + React UI shell, Three.js scene (`src/scene`, imperative), sim worker (`src/sim`) |
| `deploy/staging/` | systemd units, nginx vhost, pull-based CD scripts for srv-dev1 |
| `docs/` | concept, constraints, roadmap, ADRs |

## Commands

- Backend: `cd backend && dotnet test --solution TrafficSim.slnx` (xUnit v3 on Microsoft.Testing.Platform)
- Sim core: `cd sim-core && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- Frontend: `cd frontend && npm run build:wasm && npm run lint && npm run typecheck && npm test`

## Conventions

- English everywhere. Conventional Commits. Small commits pushed to `main`, referencing issues
  (`Closes #n`); every green commit auto-deploys to staging.
- TDD for logic; no real network calls in tests; fixtures under `tests/**/Fixtures`.
- Provider DTOs stay `internal` inside their adapter; map to canonical domain types.
- The sim core has no I/O, no wall clock, no global RNG; determinism per seed is tested.
- `wasm-bindgen` is pinned to `=0.2.130` in `Cargo.toml`, `Dockerfile` and `ci.yml` — bump together.
- Warnings are errors in .NET (`TreatWarningsAsErrors`) and Rust (`clippy -D warnings`).
