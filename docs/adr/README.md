# Architecture Decision Records

We record significant decisions using a lightweight [MADR](https://adr.github.io/madr/)-style format
(see [ADR-0001](0001-record-architecture-decisions.md)). Copy [`template.md`](template.md), take the next
number, open a PR. Superseded ADRs stay in place with their status updated.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-dotnet-modular-monolith-backend.md) | .NET 10 modular monolith backend | Accepted |
| [0003](0003-postgresql-postgis.md) | PostgreSQL + PostGIS as spatial database | Accepted |
| [0004](0004-provider-ports-and-anti-corruption-layers.md) | Provider ports, anti-corruption layers and a shared fetch pipeline | Accepted |
| [0005](0005-osm-authoritative-road-network.md) | OpenStreetMap is the authoritative road network source | Accepted |
| [0006](0006-rust-wasm-simulation-core.md) | Simulation core in Rust/WebAssembly inside a Web Worker | Accepted |
| [0007](0007-microscopic-traffic-model.md) | Microscopic traffic model: IDM + MOBIL, fixed step, deterministic | Accepted |
| [0008](0008-threejs-renderer-react-shell.md) | Three.js renderer with a React UI shell | Accepted |
| [0009](0009-server-side-lane-graph-compilation.md) | Server-side lane graph compilation and versioned network package | Accepted |
| [0010](0010-changesets-over-immutable-baseline.md) | Network edits as changesets over an immutable baseline | Accepted |
| [0011](0011-coordinate-reference-systems.md) | Coordinate reference systems | Accepted |
| [0012](0012-docker-compose-deployment.md) | Docker Compose deployment, bind mounts, single HTTP port, systemd on staging | Accepted |
| [0013](0013-testing-strategy.md) | Test-driven development and coverage targets | Accepted |
| [0014](0014-licensing.md) | Licensing: MIT for code, ODbL attribution for data | Accepted |
| [0015](0015-lean-ci.md) | Lean, cost-free CI on GitHub Actions | Accepted |
| [0016](0016-roundabouts-grade-separation-lane-markings.md) | Roundabouts, grade separation and lane markings in the network model | Accepted |
| [0017](0017-webgpu-evaluation.md) | Stay on WebGL2, prepare for Three.js WebGPURenderer | Accepted |
| [0018](0018-terrain-elevation-and-gradients.md) | Terrain elevation and gradients | Accepted |
| [0019](0019-public-transport-lines-and-stops.md) | Public transport lines and stops from OSM route relations | Accepted |
| [0020](0020-pedestrian-crossings.md) | Pedestrian crossings as crossing demand | Accepted |
