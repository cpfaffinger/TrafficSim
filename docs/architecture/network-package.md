# Network package format

> Status: **draft** — specified in Phase 2 (see issue #30, [ADR-0009](../adr/0009-server-side-lane-graph-compilation.md)).

The network package is the contract between the backend (compiler), the frontend (rendering)
and the simulation core. Planned top-level structure of `formatVersion: 1`:

```jsonc
{
  "formatVersion": 1,
  "baselineId": "…",
  "origin": { "lat": 48.2082, "lon": 16.3738 },       // local tangent plane origin (ADR-0011)
  "attribution": ["© OpenStreetMap contributors (ODbL)"],
  "nodes":    [{ "id": "n1", "x": 0.0, "y": 0.0, "control": "signal" }],
  "links":    [{ "id": "l1", "from": "n1", "to": "n2", "roadClass": "primary", "lanes": ["l1:0", "l1:1"] }],
  "lanes":    [{ "id": "l1:0", "link": "l1", "index": 0, "width": 3.25, "speedLimit": 13.89,
                 "allowed": ["car", "truck", "bus"], "turns": ["left", "through"],
                 "polyline": [[0, 0], [120.5, 3.2]], "assumed": ["width"] }],
  "connectors": [{ "id": "c1", "fromLane": "l1:0", "toLane": "l7:0", "turn": "left",
                   "polyline": [[120.5, 3.2], [130.0, 12.0]], "conflicts": ["c4"] }],
  "signals":  [{ "junction": "n2", "cycle": 90, "offset": 0, "groups": [] }]
}
```

Coordinates are metres in the local East-North plane. Fixtures for cross-stack contract tests will
live in `docs/architecture/fixtures/` and be consumed by .NET, TypeScript and Rust tests.
