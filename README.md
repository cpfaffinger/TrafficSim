# TrafficSim

Browser-based 3D **microscopic traffic simulator** on real OpenStreetMap road networks.
Import an area, edit lanes, junctions and signal plans, simulate every vehicle individually
(cars, trucks, buses, commuters, attentive and distracted drivers) and inspect the result as
congestion, queue and speed **heatmaps**.

> Status: phases 0–3 done (providers, OSM compiler, 3D viewer); simulation on real networks,
> editor and scenarios in progress. See the [roadmap](docs/roadmap.md) and the
> [milestones](https://github.com/cpfaffinger/TrafficSim/milestones).
> Staging: <https://stagecompose00.pulseone.dev>

## Features

- **Search and import** any area (Photon/Nominatim search, Overpass for small areas, Geofabrik
  extracts for large ones) and compile it into a lane-accurate network: lanes per direction,
  turn lanes, speed limits incl. country zones, bus lanes and HGV bans, signals, stop/give-way,
  priority roads, right-before-left, roundabouts and mini-roundabouts, bridges and tunnels
  (no false junctions under overpasses), solid/dashed lane markings ([ADR-0016](docs/adr/0016-roundabouts-grade-separation-lane-markings.md)).
- **3D viewer** with city-builder camera, OpenFreeMap basemap with buildings, lane markings, turn
  arrows, bridge decks and tunnels, inspector for every lane, movement and junction.
- **Edits as changesets** on the imported OSM data — lanes, turn lanes, speed limits, restrictions,
  markings, new roads/bridges, roundabout conversion, lane connections, turn bans, signal plans
  ([ADR-0010](docs/adr/0010-changesets-over-immutable-baseline.md)) — saved as **scenarios** with
  variants, read-only share links, run results and GeoJSON/CSV exports.
- **Rectangles or hand-drawn polygons** as import areas, named imports that can be renamed and
  deleted.
- **Scenarios generated at import** from OSM buildings, land use and POIs (dwellings, jobs, shops,
  schools, venues, parking): zones, a gravity OD matrix and morning/midday/evening/Saturday/night/
  stress scenarios, plus event and freight scenarios where the data supports them. Road-class
  profiles (motorway ≫ primary ≫ residential) and residential access-road profiles fill in the rest.
- **Demand editor** per scenario: OD matrix, boundary entries, time-of-day curves, vehicle and
  driver mixes, zones on the map.
- **Microscopic simulation in the browser** (Rust → WebAssembly in a worker): IDM car following,
  MOBIL lane changes with continuous lateral motion, signals incl. actuated control, priority and
  gap acceptance, conflict areas, rerouting, heterogeneous vehicles and drivers, deterministic per
  seed.
- **Lane-accurate heatmaps** (speed ratio, density, queues, delay, flow, stops) with a timeline and
  replay of 30 s buckets.
- **Stored runs**: save the browser run or run several seeds on the server with the native sim
  core, KPIs as mean ± sd, **A/B comparison** of runs as a diff heatmap (same lane layout) or as
  per-link deltas matched by OSM way.

## API (v1)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/geocode?q=`, `GET /api/v1/geocode/reverse?lat=&lon=` | place search |
| `GET /api/v1/providers`, `GET /api/v1/meta` | provider registry, version, attributions |
| `POST /api/v1/networks/import` `{bbox \| polygon, name}` → job; `GET /api/v1/networks/import/{jobId}` | import an area (generates scenarios) |
| `PATCH /api/v1/networks/{id}` `{name}`, `DELETE /api/v1/networks/{id}` | rename / delete an import with its scenarios and runs |
| `GET /api/v1/networks`, `GET /api/v1/networks/{id}`, `GET /api/v1/networks/{id}/package` | baselines and their [network package](docs/architecture/network-package.md) |
| `POST /api/v1/networks/{id}/preview` `{changeset}` | compile a changeset without saving |
| `/api/v1/scenarios[/{id}[/clone\|/package\|/runs]]`, `/api/v1/shared/{token}` | scenarios, variants, share links, runs |
| `GET /api/v1/runs/{id}`, `GET /api/v1/runs/{id}/buckets` | a stored run and its `lane-cells-v1` heatmap history |
| `POST /api/v1/scenarios/{id}/batch` `{seeds, durationSeconds, warmupSeconds}` → job; `GET /api/v1/batches/{jobId}`; `GET /api/v1/batch-runner` | multi-seed runs on the server |
| `/api/v1/scenarios/{id}/export/network.geojson`, `/api/v1/runs/{id}/export/*` | exports (ODbL) |

OpenAPI: `/api/openapi/v1.json`.

## Documentation

| Document | Content |
|----------|---------|
| [Concept](docs/concept.md) | vision, domain model, simulation model, architecture, data sources |
| [Constraints](docs/constraints.md) | binding project rules |
| [Roadmap](docs/roadmap.md) | phases ↔ GitHub milestones |
| [ADRs](docs/adr/README.md) | architecture decision records |
| [Contributing](CONTRIBUTING.md) | workflow, conventions, CI/CD |

## Stack

| Layer | Technology |
|-------|------------|
| Backend | .NET 10, ASP.NET Core minimal APIs (modular monolith) |
| Database | PostgreSQL 17 + PostGIS 3.5 |
| Simulation core | Rust → WebAssembly in a Web Worker |
| Frontend | TypeScript, Three.js (WebGL2), React UI shell, Vite |
| Data | OpenStreetMap (Overpass, Geofabrik), Photon, Nominatim, OpenFreeMap |
| Runtime | Docker Compose, single HTTP port, bind-mounted `./data` |

## Map data

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the ODbL.

## License

Code: [MIT](LICENSE).
