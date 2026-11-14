# TrafficSim

Browser-based 3D **microscopic traffic simulator** on real OpenStreetMap road networks.
Import an area, edit lanes, junctions and signal plans, simulate every vehicle individually
(cars, trucks, buses, commuters, attentive and distracted drivers) and inspect the result as
congestion, queue and speed **heatmaps**.

> Status: **Phase 0 — Foundation**. See the [roadmap](docs/roadmap.md) and the
> [milestones](https://github.com/cpfaffinger/TrafficSim/milestones).
> Staging: <https://stagecompose00.pulseone.dev>

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
