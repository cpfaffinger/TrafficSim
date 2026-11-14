# Roadmap

Each phase is a GitHub **milestone** with one `[Epic]` issue whose sub-issues hold the work.
Phases build on each other; within a phase, issues are ordered roughly by dependency.
Progress is tracked live on the [milestones page](https://github.com/cpfaffinger/TrafficSim/milestones).

| Phase | Milestone | Epic | Exit criteria |
|-------|-----------|------|---------------|
| 0 | [Phase 0 — Foundation & walking skeleton](https://github.com/cpfaffinger/TrafficSim/milestone/1) | [#1](https://github.com/cpfaffinger/TrafficSim/issues/1) | Repo, docs/ADRs, backend/sim-core/frontend skeletons, Docker Compose, lean CI, staging with pull-based CD. Exit: a commit on main is tested and live on stagecompose00 within minutes. |
| 1 | [Phase 1 — Provider integration layer](https://github.com/cpfaffinger/TrafficSim/milestone/2) | [#11](https://github.com/cpfaffinger/TrafficSim/issues/11) | All external services behind ports + anti-corruption layers + shared fetch pipeline: registry, caching, Overpass, Photon, Nominatim, Google (disabled), Geofabrik, persistence foundation. |
| 2 | [Phase 2 — Road network model & OSM compiler](https://github.com/cpfaffinger/TrafficSim/milestone/3) | [#21](https://github.com/cpfaffinger/TrafficSim/issues/21) | Lane-accurate domain model and the OSM→lane-graph compiler, persisted as immutable baselines and delivered as a versioned network package. |
| 3 | [Phase 3 — 3D viewer](https://github.com/cpfaffinger/TrafficSim/milestone/4) | [#32](https://github.com/cpfaffinger/TrafficSim/issues/32) | Search a place, select an area, import it and explore the lane-accurate road network in 3D with inspector and attribution. |
| 4 | [Phase 4 — Simulation core v1](https://github.com/cpfaffinger/TrafficSim/milestone/5) | [#39](https://github.com/cpfaffinger/TrafficSim/issues/39) | Vehicles drive on the imported lane graph: IDM, routing, signals, priorities, MOBIL lane changes, rendered live from the worker. |
| 5 | [Phase 5 — Demand & vehicle diversity](https://github.com/cpfaffinger/TrafficSim/milestone/6) | [#49](https://github.com/cpfaffinger/TrafficSim/issues/49) | Realistic demand (commuters, trucks, time-of-day) and heterogeneous vehicles and drivers (reaction times, attentiveness). |
| 6 | [Phase 6 — Metrics & heatmaps](https://github.com/cpfaffinger/TrafficSim/milestone/7) | [#56](https://github.com/cpfaffinger/TrafficSim/issues/56) | Aggregated lane-cell and junction metrics rendered as heatmaps over time; results persisted. |
| 7 | [Phase 7 — Network editor](https://github.com/cpfaffinger/TrafficSim/milestone/8) | [#63](https://github.com/cpfaffinger/TrafficSim/issues/63) | City-builder style editing: lanes, turn lanes, speed limits, restrictions, signal plans, new roads — as changesets with undo/redo. |
| 8 | [Phase 8 — Scenarios & comparison](https://github.com/cpfaffinger/TrafficSim/milestone/9) | [#71](https://github.com/cpfaffinger/TrafficSim/issues/71) | Scenarios (baseline + changeset + demand + seed), batch runs, A/B heatmap comparison, reports and exports. |
| 9 | [Phase 9 — Scale & performance](https://github.com/cpfaffinger/TrafficSim/milestone/10) | [#77](https://github.com/cpfaffinger/TrafficSim/issues/77) | Motorway and city scale: performance budgets, SharedArrayBuffer, LOD, actuated signals, WebGPU, native batch runner. |

## Phase 0 — Foundation & walking skeleton

A deployable walking skeleton through all layers: ASP.NET Core API + PostGIS + Rust/WASM core in a worker + Three.js view, built by one Dockerfile, tested in CI and continuously deployed to staging.

Epic: [#1](https://github.com/cpfaffinger/TrafficSim/issues/1)

- [#2](https://github.com/cpfaffinger/TrafficSim/issues/2) Project documentation: concept, constraints, ADRs, license
- [#3](https://github.com/cpfaffinger/TrafficSim/issues/3) Backend skeleton: .NET 10 modular monolith with health endpoints
- [#4](https://github.com/cpfaffinger/TrafficSim/issues/4) Geocoding vertical slice: Photon ACL + fallback service + /api/v1/geocode
- [#5](https://github.com/cpfaffinger/TrafficSim/issues/5) Sim core skeleton: Rust crate with IDM, PCG32 and ring-road demo
- [#6](https://github.com/cpfaffinger/TrafficSim/issues/6) Frontend skeleton: Vite + React + Three.js + WASM worker
- [#7](https://github.com/cpfaffinger/TrafficSim/issues/7) Docker: multi-stage Dockerfile + compose.yaml with PostGIS and bind mounts
- [#8](https://github.com/cpfaffinger/TrafficSim/issues/8) Lean CI workflow on GitHub Actions
- [#9](https://github.com/cpfaffinger/TrafficSim/issues/9) Staging: nginx vhost, systemd unit and pull-based continuous deployment
- [#10](https://github.com/cpfaffinger/TrafficSim/issues/10) Contributor & agent guide (CONTRIBUTING.md, CLAUDE.md)

## Phase 1 — Provider integration layer

Complete the provider integration layer of ADR-0004 so that every later phase consumes canonical data only, with caching, rate limiting, fallbacks and attribution.

Epic: [#11](https://github.com/cpfaffinger/TrafficSim/issues/11)

- [#12](https://github.com/cpfaffinger/TrafficSim/issues/12) Provider registry & configuration model
- [#13](https://github.com/cpfaffinger/TrafficSim/issues/13) Fetch pipeline: per-provider rate limiting, metrics, structured logging
- [#14](https://github.com/cpfaffinger/TrafficSim/issues/14) Persistent response cache with per-provider TTL
- [#15](https://github.com/cpfaffinger/TrafficSim/issues/15) Overpass ACL: road network extraction for a bounding box
- [#16](https://github.com/cpfaffinger/TrafficSim/issues/16) Nominatim ACL for reverse geocoding (fallback)
- [#17](https://github.com/cpfaffinger/TrafficSim/issues/17) Photon: reverse geocoding + self-hosted Photon compose profile
- [#18](https://github.com/cpfaffinger/TrafficSim/issues/18) Google Maps adapter (disabled by default, geocoding only)
- [#19](https://github.com/cpfaffinger/TrafficSim/issues/19) Geofabrik PBF road network source for large areas
- [#20](https://github.com/cpfaffinger/TrafficSim/issues/20) Persistence foundation: EF Core + PostGIS, migrations, Testcontainers

## Phase 2 — Road network model & OSM compiler

Turn OSM ways and tags into a lane graph (lanes 0..n per direction, connectors, junction controls, signals) — test-first, rule by rule — and deliver it to clients (ADR-0009).

Epic: [#21](https://github.com/cpfaffinger/TrafficSim/issues/21)

- [#22](https://github.com/cpfaffinger/TrafficSim/issues/22) Domain network model: Node, Link, Lane, LaneConnector, Junction
- [#23](https://github.com/cpfaffinger/TrafficSim/issues/23) Lane count interpretation: lanes, lanes:forward/backward, oneway, defaults
- [#24](https://github.com/cpfaffinger/TrafficSim/issues/24) turn:lanes parsing and lane connector generation
- [#25](https://github.com/cpfaffinger/TrafficSim/issues/25) Speed limits: maxspeed parsing, units, implicit zones
- [#26](https://github.com/cpfaffinger/TrafficSim/issues/26) Junction control: signals, stop, give way, priority roads, roundabouts
- [#27](https://github.com/cpfaffinger/TrafficSim/issues/27) Vehicle restrictions: access, hgv, bus lanes, psv
- [#28](https://github.com/cpfaffinger/TrafficSim/issues/28) Junction geometry: intersection areas and connector curves
- [#29](https://github.com/cpfaffinger/TrafficSim/issues/29) Network import use case: compile, persist baseline, API
- [#30](https://github.com/cpfaffinger/TrafficSim/issues/30) Network package format v1: spec, endpoint, cross-stack contract tests
- [#31](https://github.com/cpfaffinger/TrafficSim/issues/31) Local tangent plane conversion in .NET, TS and Rust

## Phase 3 — 3D viewer

A Three.js viewer for imported networks with city-builder style camera, lane meshes, basemap ground, picking and inspector (ADR-0008).

Epic: [#32](https://github.com/cpfaffinger/TrafficSim/issues/32)

- [#33](https://github.com/cpfaffinger/TrafficSim/issues/33) Camera & scene: RTS-style controls, lighting, ground
- [#34](https://github.com/cpfaffinger/TrafficSim/issues/34) Place search & area selection with import progress
- [#35](https://github.com/cpfaffinger/TrafficSim/issues/35) Road & lane mesh generation from the network package
- [#36](https://github.com/cpfaffinger/TrafficSim/issues/36) Basemap ground from OpenFreeMap vector tiles
- [#37](https://github.com/cpfaffinger/TrafficSim/issues/37) Picking & inspector panel
- [#38](https://github.com/cpfaffinger/TrafficSim/issues/38) Attribution & legal UI

## Phase 4 — Simulation core v1

Microscopic simulation on real networks per ADR-0007, deterministic and test-first, connected to the 3D view.

Epic: [#39](https://github.com/cpfaffinger/TrafficSim/issues/39)

- [#40](https://github.com/cpfaffinger/TrafficSim/issues/40) Runtime lane graph in Rust from the network package
- [#41](https://github.com/cpfaffinger/TrafficSim/issues/41) IDM car following across lane and connector boundaries
- [#42](https://github.com/cpfaffinger/TrafficSim/issues/42) Vehicle sources, sinks and lifecycle
- [#43](https://github.com/cpfaffinger/TrafficSim/issues/43) Routing: shortest travel time on the lane graph
- [#44](https://github.com/cpfaffinger/TrafficSim/issues/44) Fixed-time traffic signal controllers
- [#45](https://github.com/cpfaffinger/TrafficSim/issues/45) Unsignalised junctions: priority and gap acceptance
- [#46](https://github.com/cpfaffinger/TrafficSim/issues/46) MOBIL lane changes incl. mandatory route changes
- [#47](https://github.com/cpfaffinger/TrafficSim/issues/47) Worker bridge, instanced vehicle rendering and playback controls
- [#48](https://github.com/cpfaffinger/TrafficSim/issues/48) Determinism and golden-run regression suite

## Phase 5 — Demand & vehicle diversity

Every vehicle has a type and a driver with individual parameters; demand follows OD matrices and time-of-day curves.

Epic: [#49](https://github.com/cpfaffinger/TrafficSim/issues/49)

- [#50](https://github.com/cpfaffinger/TrafficSim/issues/50) Vehicle type catalogue as data
- [#51](https://github.com/cpfaffinger/TrafficSim/issues/51) Driver profiles with parameter distributions
- [#52](https://github.com/cpfaffinger/TrafficSim/issues/52) Reaction time and distraction model
- [#53](https://github.com/cpfaffinger/TrafficSim/issues/53) Demand model: zones, OD matrix, time-of-day curves
- [#54](https://github.com/cpfaffinger/TrafficSim/issues/54) Demand editor UI
- [#55](https://github.com/cpfaffinger/TrafficSim/issues/55) Commuter re-routing on experienced travel times

## Phase 6 — Metrics & heatmaps

Make congestion visible: tailbacks, platoons, stop-and-go waves as lane-accurate heatmaps with a timeline.

Epic: [#56](https://github.com/cpfaffinger/TrafficSim/issues/56)

- [#57](https://github.com/cpfaffinger/TrafficSim/issues/57) Lane-cell aggregation in the sim core
- [#58](https://github.com/cpfaffinger/TrafficSim/issues/58) Junction metrics: queue length, wait time, level of service
- [#59](https://github.com/cpfaffinger/TrafficSim/issues/59) Heatmap rendering: lane ribbons and density overlay
- [#60](https://github.com/cpfaffinger/TrafficSim/issues/60) Timeline and replay of aggregated buckets
- [#61](https://github.com/cpfaffinger/TrafficSim/issues/61) Persist run results (API + PostGIS)
- [#62](https://github.com/cpfaffinger/TrafficSim/issues/62) Phenomena detection: tailbacks and stop-and-go waves

## Phase 7 — Network editor

Edit the real network like in a traffic-manager mod and re-run simulations on the result (ADR-0010).

Epic: [#63](https://github.com/cpfaffinger/TrafficSim/issues/63)

- [#64](https://github.com/cpfaffinger/TrafficSim/issues/64) Changeset domain model: apply, validate, rebase
- [#65](https://github.com/cpfaffinger/TrafficSim/issues/65) Lane tools: add/remove lanes, direction, width
- [#66](https://github.com/cpfaffinger/TrafficSim/issues/66) Lane connector & turn lane editor
- [#67](https://github.com/cpfaffinger/TrafficSim/issues/67) Speed limit & vehicle restriction tools
- [#68](https://github.com/cpfaffinger/TrafficSim/issues/68) Signal plan editor
- [#69](https://github.com/cpfaffinger/TrafficSim/issues/69) Add/remove roads and junctions
- [#70](https://github.com/cpfaffinger/TrafficSim/issues/70) Undo/redo and changeset persistence

## Phase 8 — Scenarios & comparison

Answer "what if?" questions: compare variants quantitatively and visually.

Epic: [#71](https://github.com/cpfaffinger/TrafficSim/issues/71)

- [#72](https://github.com/cpfaffinger/TrafficSim/issues/72) Scenario management (CRUD)
- [#73](https://github.com/cpfaffinger/TrafficSim/issues/73) Batch runs with multiple seeds
- [#74](https://github.com/cpfaffinger/TrafficSim/issues/74) A/B heatmap diff view
- [#75](https://github.com/cpfaffinger/TrafficSim/issues/75) KPI report and exports (CSV, GeoJSON with ODbL notice)
- [#76](https://github.com/cpfaffinger/TrafficSim/issues/76) Read-only shareable scenario links

## Phase 9 — Scale & performance

Reach and exceed the quality targets (10k+ vehicles, 60 fps) and support motorway-scale scenarios.

Epic: [#77](https://github.com/cpfaffinger/TrafficSim/issues/77)

- [#78](https://github.com/cpfaffinger/TrafficSim/issues/78) Benchmark harness and performance budgets
- [#79](https://github.com/cpfaffinger/TrafficSim/issues/79) SharedArrayBuffer vehicle state sharing
- [#80](https://github.com/cpfaffinger/TrafficSim/issues/80) Rendering LOD and culling
- [#81](https://github.com/cpfaffinger/TrafficSim/issues/81) Motorway scenarios: ramps, merges, weaving
- [#82](https://github.com/cpfaffinger/TrafficSim/issues/82) Actuated traffic signals
- [#83](https://github.com/cpfaffinger/TrafficSim/issues/83) WebGPU renderer evaluation
- [#84](https://github.com/cpfaffinger/TrafficSim/issues/84) Headless native batch runner (server-side)

## Backlog (unscheduled)

- [#85](https://github.com/cpfaffinger/TrafficSim/issues/85) Public transport vehicles and stops
- [#86](https://github.com/cpfaffinger/TrafficSim/issues/86) Pedestrians and crossings
- [#87](https://github.com/cpfaffinger/TrafficSim/issues/87) Elevation and gradients
