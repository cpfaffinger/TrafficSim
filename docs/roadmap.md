# Roadmap

Each phase is a GitHub **milestone** with one `[Epic]` issue whose sub-issues hold the work.
Phases build on each other; within a phase, issues are ordered roughly by dependency.
Progress is tracked live on the [milestones page](https://github.com/cpfaffinger/TrafficSim/milestones).

| Phase | Milestone | Epic | Status | Exit criteria |
|-------|-----------|------|--------|---------------|
| 0 | [Phase 0 — Foundation & walking skeleton](https://github.com/cpfaffinger/TrafficSim/milestone/1) | [#1](https://github.com/cpfaffinger/TrafficSim/issues/1) | ✅ done | Repo, docs/ADRs, backend/sim-core/frontend skeletons, Docker Compose, lean CI, staging with pull-based CD. Exit: a commit on main is tested and live on stagecompose00 within minutes. |
| 1 | [Phase 1 — Provider integration layer](https://github.com/cpfaffinger/TrafficSim/milestone/2) | [#11](https://github.com/cpfaffinger/TrafficSim/issues/11) | ✅ done | All external services behind ports + anti-corruption layers + shared fetch pipeline: registry, caching, Overpass, Photon, Nominatim, Google (disabled), Geofabrik, persistence foundation. |
| 2 | [Phase 2 — Road network model & OSM compiler](https://github.com/cpfaffinger/TrafficSim/milestone/3) | [#21](https://github.com/cpfaffinger/TrafficSim/issues/21) | ✅ done | Lane-accurate domain model and the OSM→lane-graph compiler, persisted as immutable baselines and delivered as a versioned network package. |
| 3 | [Phase 3 — 3D viewer](https://github.com/cpfaffinger/TrafficSim/milestone/4) | [#32](https://github.com/cpfaffinger/TrafficSim/issues/32) | ✅ done | Search a place, select an area, import it and explore the lane-accurate road network in 3D with inspector and attribution. |
| 4 | [Phase 4 — Simulation core v1](https://github.com/cpfaffinger/TrafficSim/milestone/5) | [#39](https://github.com/cpfaffinger/TrafficSim/issues/39) | ✅ done | Vehicles drive on the imported lane graph: IDM, routing, signals, priorities, MOBIL lane changes, rendered live from the worker. |
| 5 | [Phase 5 — Demand & vehicle diversity](https://github.com/cpfaffinger/TrafficSim/milestone/6) | [#49](https://github.com/cpfaffinger/TrafficSim/issues/49) | ✅ done | Realistic demand (commuters, trucks, time-of-day) and heterogeneous vehicles and drivers (reaction times, attentiveness). |
| 6 | [Phase 6 — Metrics & heatmaps](https://github.com/cpfaffinger/TrafficSim/milestone/7) | [#56](https://github.com/cpfaffinger/TrafficSim/issues/56) | ✅ done | Aggregated lane-cell and junction metrics rendered as heatmaps over time; results persisted. |
| 7 | [Phase 7 — Network editor](https://github.com/cpfaffinger/TrafficSim/milestone/8) | [#63](https://github.com/cpfaffinger/TrafficSim/issues/63) | ✅ done | City-builder style editing: lanes, turn lanes, speed limits, restrictions, signal plans, new roads — as changesets with undo/redo. |
| 8 | [Phase 8 — Scenarios & comparison](https://github.com/cpfaffinger/TrafficSim/milestone/9) | [#71](https://github.com/cpfaffinger/TrafficSim/issues/71) | ✅ done | Scenarios (baseline + changeset + demand + seed), batch runs, A/B heatmap comparison, reports and exports. |
| 9 | [Phase 9 — Scale & performance](https://github.com/cpfaffinger/TrafficSim/milestone/10) | [#77](https://github.com/cpfaffinger/TrafficSim/issues/77) | ✅ done | Motorway and city scale: performance budgets, SharedArrayBuffer, LOD, actuated signals, WebGPU, native batch runner. |
| 10 | [Phase 10 — Road signs & follow-ups](https://github.com/cpfaffinger/TrafficSim/milestone/11) | [#99](https://github.com/cpfaffinger/TrafficSim/issues/99) | ✅ done | Traffic signs end to end (OSM sign tags, signed priority roads, 3D sign models) and follow-ups found while building phases 4–8. Exit: signs are read from all common OSM taggings, rendered in 3D, and the known editor/sim limitations are resolved. |

## Phase 0 — Foundation & walking skeleton

A deployable walking skeleton through all layers: ASP.NET Core API + PostGIS + Rust/WASM core in a worker + Three.js view, built by one Dockerfile, tested in CI and continuously deployed to staging.

Epic: [#1](https://github.com/cpfaffinger/TrafficSim/issues/1)

- [x] [#2](https://github.com/cpfaffinger/TrafficSim/issues/2) Project documentation: concept, constraints, ADRs, license
- [x] [#3](https://github.com/cpfaffinger/TrafficSim/issues/3) Backend skeleton: .NET 10 modular monolith with health endpoints
- [x] [#4](https://github.com/cpfaffinger/TrafficSim/issues/4) Geocoding vertical slice: Photon ACL + fallback service + /api/v1/geocode
- [x] [#5](https://github.com/cpfaffinger/TrafficSim/issues/5) Sim core skeleton: Rust crate with IDM, PCG32 and ring-road demo
- [x] [#6](https://github.com/cpfaffinger/TrafficSim/issues/6) Frontend skeleton: Vite + React + Three.js + WASM worker
- [x] [#7](https://github.com/cpfaffinger/TrafficSim/issues/7) Docker: multi-stage Dockerfile + compose.yaml with PostGIS and bind mounts
- [x] [#8](https://github.com/cpfaffinger/TrafficSim/issues/8) Lean CI workflow on GitHub Actions
- [x] [#9](https://github.com/cpfaffinger/TrafficSim/issues/9) Staging: nginx vhost, systemd unit and pull-based continuous deployment
- [x] [#10](https://github.com/cpfaffinger/TrafficSim/issues/10) Contributor & agent guide (CONTRIBUTING.md, CLAUDE.md)

## Phase 1 — Provider integration layer

Complete the provider integration layer of ADR-0004 so that every later phase consumes canonical data only, with caching, rate limiting, fallbacks and attribution.

Epic: [#11](https://github.com/cpfaffinger/TrafficSim/issues/11)

- [x] [#12](https://github.com/cpfaffinger/TrafficSim/issues/12) Provider registry & configuration model
- [x] [#13](https://github.com/cpfaffinger/TrafficSim/issues/13) Fetch pipeline: per-provider rate limiting, metrics, structured logging
- [x] [#14](https://github.com/cpfaffinger/TrafficSim/issues/14) Persistent response cache with per-provider TTL
- [x] [#15](https://github.com/cpfaffinger/TrafficSim/issues/15) Overpass ACL: road network extraction for a bounding box
- [x] [#16](https://github.com/cpfaffinger/TrafficSim/issues/16) Nominatim ACL for reverse geocoding (fallback)
- [x] [#17](https://github.com/cpfaffinger/TrafficSim/issues/17) Photon: reverse geocoding + self-hosted Photon compose profile
- [x] [#18](https://github.com/cpfaffinger/TrafficSim/issues/18) Google Maps adapter (disabled by default, geocoding only)
- [x] [#19](https://github.com/cpfaffinger/TrafficSim/issues/19) Geofabrik PBF road network source for large areas
- [x] [#20](https://github.com/cpfaffinger/TrafficSim/issues/20) Persistence foundation: EF Core + PostGIS, migrations, Testcontainers

## Phase 2 — Road network model & OSM compiler

Turn OSM ways and tags into a lane graph (lanes 0..n per direction, connectors, junction controls, signals) — test-first, rule by rule — and deliver it to clients (ADR-0009).

Epic: [#21](https://github.com/cpfaffinger/TrafficSim/issues/21)

- [x] [#22](https://github.com/cpfaffinger/TrafficSim/issues/22) Domain network model: Node, Link, Lane, LaneConnector, Junction
- [x] [#23](https://github.com/cpfaffinger/TrafficSim/issues/23) Lane count interpretation: lanes, lanes:forward/backward, oneway, defaults
- [x] [#24](https://github.com/cpfaffinger/TrafficSim/issues/24) turn:lanes parsing and lane connector generation
- [x] [#25](https://github.com/cpfaffinger/TrafficSim/issues/25) Speed limits: maxspeed parsing, units, implicit zones
- [x] [#26](https://github.com/cpfaffinger/TrafficSim/issues/26) Junction control: signals, stop, give way, priority roads, roundabouts
- [x] [#27](https://github.com/cpfaffinger/TrafficSim/issues/27) Vehicle restrictions: access, hgv, bus lanes, psv
- [x] [#28](https://github.com/cpfaffinger/TrafficSim/issues/28) Junction geometry: intersection areas and connector curves
- [x] [#29](https://github.com/cpfaffinger/TrafficSim/issues/29) Network import use case: compile, persist baseline, API
- [x] [#30](https://github.com/cpfaffinger/TrafficSim/issues/30) Network package format v1: spec, endpoint, cross-stack contract tests
- [x] [#31](https://github.com/cpfaffinger/TrafficSim/issues/31) Local tangent plane conversion in .NET, TS and Rust
- [x] [#92](https://github.com/cpfaffinger/TrafficSim/issues/92) Roundabouts: ring topology, implicit one-way, entry yield, mini-roundabouts
- [x] [#93](https://github.com/cpfaffinger/TrafficSim/issues/93) Grade separation: bridges, tunnels, layers (over- and underpasses)
- [x] [#94](https://github.com/cpfaffinger/TrafficSim/issues/94) Lane markings: lane boundaries, solid lines, change:lanes, overtaking

## Phase 3 — 3D viewer

A Three.js viewer for imported networks with city-builder style camera, lane meshes, basemap ground, picking and inspector (ADR-0008).

Epic: [#32](https://github.com/cpfaffinger/TrafficSim/issues/32)

- [x] [#33](https://github.com/cpfaffinger/TrafficSim/issues/33) Camera & scene: RTS-style controls, lighting, ground
- [x] [#34](https://github.com/cpfaffinger/TrafficSim/issues/34) Place search & area selection with import progress
- [x] [#35](https://github.com/cpfaffinger/TrafficSim/issues/35) Road & lane mesh generation from the network package
- [x] [#36](https://github.com/cpfaffinger/TrafficSim/issues/36) Basemap ground from OpenFreeMap vector tiles
- [x] [#37](https://github.com/cpfaffinger/TrafficSim/issues/37) Picking & inspector panel
- [x] [#38](https://github.com/cpfaffinger/TrafficSim/issues/38) Attribution & legal UI
- [x] [#95](https://github.com/cpfaffinger/TrafficSim/issues/95) Road markings in 3D: lane lines, solid lines, stop lines, turn arrows
- [x] [#96](https://github.com/cpfaffinger/TrafficSim/issues/96) Bridges, tunnels and interchanges in 3D

## Phase 4 — Simulation core v1

Microscopic simulation on real networks per ADR-0007, deterministic and test-first, connected to the 3D view.

Epic: [#39](https://github.com/cpfaffinger/TrafficSim/issues/39)

- [x] [#40](https://github.com/cpfaffinger/TrafficSim/issues/40) Runtime lane graph in Rust from the network package
- [x] [#41](https://github.com/cpfaffinger/TrafficSim/issues/41) IDM car following across lane and connector boundaries
- [x] [#42](https://github.com/cpfaffinger/TrafficSim/issues/42) Vehicle sources, sinks and lifecycle
- [x] [#43](https://github.com/cpfaffinger/TrafficSim/issues/43) Routing: shortest travel time on the lane graph
- [x] [#44](https://github.com/cpfaffinger/TrafficSim/issues/44) Fixed-time traffic signal controllers
- [x] [#45](https://github.com/cpfaffinger/TrafficSim/issues/45) Unsignalised junctions: priority and gap acceptance
- [x] [#46](https://github.com/cpfaffinger/TrafficSim/issues/46) MOBIL lane changes incl. mandatory route changes
- [x] [#47](https://github.com/cpfaffinger/TrafficSim/issues/47) Worker bridge, instanced vehicle rendering and playback controls
- [x] [#48](https://github.com/cpfaffinger/TrafficSim/issues/48) Determinism and golden-run regression suite
- [x] [#97](https://github.com/cpfaffinger/TrafficSim/issues/97) Sim rules for lane markings, roundabouts and grade separation

## Phase 5 — Demand & vehicle diversity

Every vehicle has a type and a driver with individual parameters; demand follows OD matrices and time-of-day curves.

Epic: [#49](https://github.com/cpfaffinger/TrafficSim/issues/49)

- [x] [#50](https://github.com/cpfaffinger/TrafficSim/issues/50) Vehicle type catalogue as data
- [x] [#51](https://github.com/cpfaffinger/TrafficSim/issues/51) Driver profiles with parameter distributions
- [x] [#52](https://github.com/cpfaffinger/TrafficSim/issues/52) Reaction time and distraction model
- [x] [#53](https://github.com/cpfaffinger/TrafficSim/issues/53) Demand model: zones, OD matrix, time-of-day curves
- [x] [#54](https://github.com/cpfaffinger/TrafficSim/issues/54) Demand editor UI
- [x] [#55](https://github.com/cpfaffinger/TrafficSim/issues/55) Commuter re-routing on experienced travel times
- [x] [#111](https://github.com/cpfaffinger/TrafficSim/issues/111) Road-class demand profiles: default volumes and time-of-day curves per road type
- [x] [#112](https://github.com/cpfaffinger/TrafficSim/issues/112) Residential trip generation: access roads of residential areas as sources and sinks
- [x] [#113](https://github.com/cpfaffinger/TrafficSim/issues/113) Default demand generated at import and editable per scenario

## Phase 6 — Metrics & heatmaps

Make congestion visible: tailbacks, platoons, stop-and-go waves as lane-accurate heatmaps with a timeline.

Epic: [#56](https://github.com/cpfaffinger/TrafficSim/issues/56)

- [x] [#57](https://github.com/cpfaffinger/TrafficSim/issues/57) Lane-cell aggregation in the sim core
- [x] [#58](https://github.com/cpfaffinger/TrafficSim/issues/58) Junction metrics: queue length, wait time, level of service
- [x] [#59](https://github.com/cpfaffinger/TrafficSim/issues/59) Heatmap rendering: lane ribbons and density overlay
- [x] [#60](https://github.com/cpfaffinger/TrafficSim/issues/60) Timeline and replay of aggregated buckets
- [x] [#61](https://github.com/cpfaffinger/TrafficSim/issues/61) Persist run results (API + PostGIS)
- [x] [#62](https://github.com/cpfaffinger/TrafficSim/issues/62) Phenomena detection: tailbacks and stop-and-go waves

## Phase 7 — Network editor

Edit the real network like in a traffic-manager mod and re-run simulations on the result (ADR-0010).

Epic: [#63](https://github.com/cpfaffinger/TrafficSim/issues/63)

- [x] [#64](https://github.com/cpfaffinger/TrafficSim/issues/64) Changeset domain model: apply, validate, rebase
- [x] [#65](https://github.com/cpfaffinger/TrafficSim/issues/65) Lane tools: add/remove lanes, direction, width
- [x] [#66](https://github.com/cpfaffinger/TrafficSim/issues/66) Lane connector & turn lane editor
- [x] [#67](https://github.com/cpfaffinger/TrafficSim/issues/67) Speed limit & vehicle restriction tools
- [x] [#68](https://github.com/cpfaffinger/TrafficSim/issues/68) Signal plan editor
- [x] [#69](https://github.com/cpfaffinger/TrafficSim/issues/69) Add/remove roads and junctions
- [x] [#70](https://github.com/cpfaffinger/TrafficSim/issues/70) Undo/redo and changeset persistence
- [x] [#98](https://github.com/cpfaffinger/TrafficSim/issues/98) Editor tools: lane markings, roundabouts, bridges and tunnels

## Phase 8 — Scenarios & comparison

Answer "what if?" questions: compare variants quantitatively and visually.

Epic: [#71](https://github.com/cpfaffinger/TrafficSim/issues/71)

- [x] [#72](https://github.com/cpfaffinger/TrafficSim/issues/72) Scenario management (CRUD)
- [x] [#73](https://github.com/cpfaffinger/TrafficSim/issues/73) Batch runs with multiple seeds
- [x] [#74](https://github.com/cpfaffinger/TrafficSim/issues/74) A/B heatmap diff view
- [x] [#75](https://github.com/cpfaffinger/TrafficSim/issues/75) KPI report and exports (CSV, GeoJSON with ODbL notice)
- [x] [#76](https://github.com/cpfaffinger/TrafficSim/issues/76) Read-only shareable scenario links
- [x] [#115](https://github.com/cpfaffinger/TrafficSim/issues/115) Automatic scenario generation at import from OSM land use, buildings and POIs

## Phase 9 — Scale & performance

Reach and exceed the quality targets (10k+ vehicles, 60 fps) and support motorway-scale scenarios.

Epic: [#77](https://github.com/cpfaffinger/TrafficSim/issues/77)

- [x] [#78](https://github.com/cpfaffinger/TrafficSim/issues/78) Benchmark harness and performance budgets
- [x] [#79](https://github.com/cpfaffinger/TrafficSim/issues/79) SharedArrayBuffer vehicle state sharing
- [x] [#80](https://github.com/cpfaffinger/TrafficSim/issues/80) Rendering LOD and culling
- [x] [#81](https://github.com/cpfaffinger/TrafficSim/issues/81) Motorway scenarios: ramps, merges, weaving
- [x] [#82](https://github.com/cpfaffinger/TrafficSim/issues/82) Actuated traffic signals
- [x] [#83](https://github.com/cpfaffinger/TrafficSim/issues/83) WebGPU renderer evaluation
- [x] [#84](https://github.com/cpfaffinger/TrafficSim/issues/84) Headless native batch runner (server-side)

## Phase 10 — Road signs & follow-ups

Traffic signs end to end (OSM sign tags, signed priority roads, 3D sign models) and follow-ups found while building phases 4–8. Exit: signs are read from all common OSM taggings, rendered in 3D, and the known editor/sim limitations are resolved.

Epic: [#99](https://github.com/cpfaffinger/TrafficSim/issues/99)

- [x] [#100](https://github.com/cpfaffinger/TrafficSim/issues/100) Signed priority roads: priority_road=designated and priority sign tags
- [x] [#101](https://github.com/cpfaffinger/TrafficSim/issues/101) traffic_sign=* tags for stop, give way and priority (DE/AT/CH codes and human-readable values)
- [x] [#102](https://github.com/cpfaffinger/TrafficSim/issues/102) Signs on mid-block nodes: capture to the downstream junction or report
- [x] [#103](https://github.com/cpfaffinger/TrafficSim/issues/103) 3D traffic sign models: stop, give way, priority road, signal masts
- [x] [#104](https://github.com/cpfaffinger/TrafficSim/issues/104) Package: signs per approach for rendering and inspection
- [x] [#105](https://github.com/cpfaffinger/TrafficSim/issues/105) Editor: attach new roads to any segment of a link
- [x] [#106](https://github.com/cpfaffinger/TrafficSim/issues/106) Editor: removing inferred signals when control is set to automatic or none
- [x] [#107](https://github.com/cpfaffinger/TrafficSim/issues/107) Editor: warn before discarding unsaved edits when loading another network
- [x] [#108](https://github.com/cpfaffinger/TrafficSim/issues/108) Sim: continuous lateral lane-change motion
- [x] [#109](https://github.com/cpfaffinger/TrafficSim/issues/109) Sim: conflict areas instead of single conflict points
- [x] [#110](https://github.com/cpfaffinger/TrafficSim/issues/110) Polygon import areas (non-rectangular selections)
- [x] [#114](https://github.com/cpfaffinger/TrafficSim/issues/114) Import management and drawing UX: names, delete, basemap in preview, auto-closing polygon

## Backlog (unscheduled)

- [ ] [#85](https://github.com/cpfaffinger/TrafficSim/issues/85) Public transport vehicles and stops
- [x] [#86](https://github.com/cpfaffinger/TrafficSim/issues/86) Pedestrians and crossings ([ADR-0020](adr/0020-pedestrian-crossings.md))
- [ ] [#87](https://github.com/cpfaffinger/TrafficSim/issues/87) Elevation and gradients
