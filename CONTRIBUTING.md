# Contributing

## Workflow: small commits, fast feedback

TrafficSim uses **trunk-based development**:

1. Pick an issue from the current [milestone](https://github.com/cpfaffinger/TrafficSim/milestones)
   (each phase has an `[Epic]` issue with its sub-issues).
2. Work in small, self-contained commits directly on `main` (or a short-lived branch + PR for
   larger or risky changes). Reference issues: `Refs #12`, `Closes #12`.
3. Push early. CI runs only the affected parts (path filters) and usually finishes in minutes.
4. Green commits on `main` are deployed automatically to
   <https://stagecompose00.pulseone.dev> within about a minute after CI (pull-based CD, see
   [`deploy/staging`](deploy/staging/README.md)).

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat(sim-core): …`, `fix(backend): …`, `docs: …`, `chore(ci): …`, `test(frontend): …`.

## Local setup

| Tool | Version | Used for |
|------|---------|----------|
| .NET SDK | 10.0 | backend (`backend/`) |
| Rust (rustup) + `wasm32-unknown-unknown` target | stable | simulation core (`sim-core/`) |
| `wasm-bindgen-cli` | 0.2.130 (exactly) | WASM bindings |
| Node.js | 24 | frontend (`frontend/`) |
| Docker + Compose | current | full stack |

```bash
# backend
cd backend && dotnet test --solution TrafficSim.slnx

# simulation core
cd sim-core && cargo test && cargo clippy --all-targets -- -D warnings

# frontend (needs the WASM build once)
cd frontend && npm ci && npm run build:wasm && npm run dev   # http://localhost:5173, proxies /api to :5080
npm test

# full stack
cp .env.example .env   # set POSTGRES_PASSWORD
docker compose up --build   # http://localhost:8080
```

## Rules

- Read [constraints](docs/constraints.md) and the relevant [ADRs](docs/adr/README.md) first.
- **Tests first** for domain logic, compiler rules, model equations and provider mappings
  ([ADR-0013](docs/adr/0013-testing-strategy.md)). Coverage gates: backend 85 %, sim-core 85 %,
  frontend logic 70 % (lines).
- Tests never call real external services; use fixtures.
- External services only via provider ports + anti-corruption layers ([ADR-0004](docs/adr/0004-provider-ports-and-anti-corruption-layers.md)).
- Architectural changes need an ADR (copy [`docs/adr/template.md`](docs/adr/template.md)).
- Everything in English.
