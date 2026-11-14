# Project constraints

Constraints are non-negotiable unless changed through a new ADR. Each links to its rationale.

## Organisational

| ID | Constraint | Source |
|----|-----------|--------|
| C-01 | Public GitHub repository, MIT-licensed code. Map data stays under its own licence (ODbL). | [ADR-0014](adr/0014-licensing.md) |
| C-02 | Everything in **English**: code, comments, commit messages, docs, issues, UI texts. | Project decision |
| C-03 | Work is planned as GitHub **milestones (phases)** and **issues**; architecture decisions as **ADRs** in `docs/adr`. | [ADR-0001](adr/0001-record-architecture-decisions.md) |
| C-04 | Only **free services** in the default configuration. Paid providers must be pluggable via configuration, disabled by default, and never required to run the app. | [ADR-0004](adr/0004-provider-ports-and-anti-corruption-layers.md) |
| C-05 | No secrets in the repository. Configuration via environment variables / `.env` (gitignored); `.env.example` documents every key. | — |

## Technical

| ID | Constraint | Source |
|----|-----------|--------|
| C-10 | Runtime is **Docker Compose**. Persistent data uses **bind-mounted folders** under `./data`; named volumes only as an optional override. | [ADR-0012](adr/0012-docker-compose-deployment.md) |
| C-11 | Exactly **one exposed HTTP port** (the app container). Database and internal services are not published. | [ADR-0012](adr/0012-docker-compose-deployment.md) |
| C-12 | Database: **PostgreSQL + PostGIS**. Geometries stored as WGS84 (SRID 4326); metric computations in projected / local coordinates. | [ADR-0003](adr/0003-postgresql-postgis.md), [ADR-0011](adr/0011-coordinate-reference-systems.md) |
| C-13 | Backend: **.NET 10 (LTS) / ASP.NET Core**, modular monolith with layered dependencies (Api → Application → Domain; Providers & Infrastructure behind ports). | [ADR-0002](adr/0002-dotnet-modular-monolith-backend.md) |
| C-14 | Simulation core: **Rust compiled to WebAssembly**, executed in a **Web Worker**. No DOM access in the core. | [ADR-0006](adr/0006-rust-wasm-simulation-core.md) |
| C-15 | Rendering: **Three.js** on **WebGL2** (WebGPU optional later); UI shell in **React**. Rendering code is imperative, not React-driven per frame. | [ADR-0008](adr/0008-threejs-renderer-react-shell.md) |
| C-16 | Every external service is accessed **only** through a provider port + anti-corruption layer + the shared fetch pipeline. No provider DTO leaks past its adapter. *Exception:* vector basemap tiles are fetched by the browser directly from the basemap provider listed in the registry (`/api/v1/providers`, capability `basemap`); proxying public tiles would only add load. Attribution stays mandatory (C-17). | [ADR-0004](adr/0004-provider-ports-and-anti-corruption-layers.md) |
| C-17 | Respect provider usage policies: identifying User-Agent with contact, rate limits, caching, attribution displayed in the UI. | [concept §6](concept.md#6-external-data-sources-and-usage-policies) |
| C-18 | OSM is the **only** road-network source. Google Maps content must never be stored or used to build network geometry. | [ADR-0005](adr/0005-osm-authoritative-road-network.md) |
| C-19 | The simulation is **deterministic** for a given build, scenario and seed. | [ADR-0007](adr/0007-microscopic-traffic-model.md) |
| C-20 | Network edits are **changesets** over an immutable baseline; baselines are never mutated. | [ADR-0010](adr/0010-changesets-over-immutable-baseline.md) |
| C-21 | Supported browsers: current desktop Chrome, Edge, Firefox, Safari with WebGL2 and WebAssembly. | — |

## Quality

| ID | Constraint | Source |
|----|-----------|--------|
| C-30 | **Test-driven** for domain logic, the lane-graph compiler, provider ACLs and the sim core. | [ADR-0013](adr/0013-testing-strategy.md) |
| C-31 | Coverage targets (line): backend domain + application + providers ≥ 85 %, sim core ≥ 85 %, frontend logic (non-rendering) ≥ 70 %. Rendering/glue code is not chased to 100 %. | [ADR-0013](adr/0013-testing-strategy.md) |
| C-32 | CI must be green before merging to `main`: build, tests, lint, coverage thresholds, Docker image build. | [ADR-0013](adr/0013-testing-strategy.md) |
| C-33 | Tests never call real external services. Provider tests use recorded fixtures; live smoke tests are opt-in. | [ADR-0013](adr/0013-testing-strategy.md) |
| C-34 | **CI must not cause costs.** Only standard GitHub-hosted runners (free for public repos), no larger runners, no scheduled workflows, no OS/version matrices. Path filters + `concurrency: cancel-in-progress` + caching; deployments are manual (`workflow_dispatch`) or run from the developer machine. | [ADR-0015](adr/0015-lean-ci.md) |

## Operational

| ID | Constraint | Source |
|----|-----------|--------|
| C-40 | Staging runs on `srv-dev1` (4 CPU / 8 GB, shared with other stages) under `/opt/trafficsim`, managed by `trafficsim.service` (systemd), reverse-proxied by host nginx as `stagecompose00.pulseone.dev`. | [ADR-0012](adr/0012-docker-compose-deployment.md) |
| C-41 | Staging resource budget: app + DB ≤ 3 GB RAM in normal operation; heavy imports are bounded by area limits. | — |
| C-42 | The app binds to `127.0.0.1` on shared hosts; public exposure only through the reverse proxy. | [ADR-0012](adr/0012-docker-compose-deployment.md) |
