# TrafficSim

Browser-based 3D **microscopic traffic simulator** on real OpenStreetMap road networks.
Import an area, edit lanes, junctions and signal plans, simulate every vehicle individually
(cars, trucks, buses, commuters, attentive and distracted drivers) and inspect the result as
congestion, queue and speed **heatmaps**.

> Status: phases 0–3 done (providers, OSM compiler, 3D viewer); simulation on real networks,
> editor and scenarios in progress. See the [roadmap](docs/roadmap.md) and the
> [milestones](https://github.com/cpfaffinger/TrafficSim/milestones).
> Staging: <https://stagecompose00.pulseone.dev>

## Features (so far)

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

## API (v1)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/geocode?q=`, `GET /api/v1/geocode/reverse?lat=&lon=` | place search |
| `GET /api/v1/providers`, `GET /api/v1/meta` | provider registry, version, attributions |
| `POST /api/v1/networks/import` `{bbox}` → job; `GET /api/v1/networks/import/{jobId}` | import an area |
| `GET /api/v1/networks`, `GET /api/v1/networks/{id}`, `GET /api/v1/networks/{id}/package` | baselines and their [network package](docs/architecture/network-package.md) |
| `POST /api/v1/networks/{id}/preview` `{changeset}` | compile a changeset without saving |
| `/api/v1/scenarios[/{id}[/clone\|/package\|/runs]]`, `/api/v1/shared/{token}` | scenarios, variants, share links, runs |
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
