# Network package format v1

> Status: **v1, binding** — the contract between the backend compiler (.NET), the frontend
> renderer (TypeScript) and the simulation core (Rust). See [ADR-0009](../adr/0009-server-side-lane-graph-compilation.md),
> [ADR-0011](../adr/0011-coordinate-reference-systems.md), [ADR-0016](../adr/0016-roundabouts-grade-separation-lane-markings.md).
> The golden fixture [`fixtures/network-package-v1.json`](fixtures/network-package-v1.json) is
> parsed by contract tests on all three stacks.

## Conventions

- JSON, UTF-8, `camelCase` keys, enum values in `snake_case` strings. Served gzip-compressed.
- **Coordinates** are metres in the local East-North-Up plane around `origin` (ADR-0011):
  `[x, y, z]` = `[east, north, up]`. `z` is the schematic elevation from grade separation
  (6 m per positive `layer`, −8 m per negative layer), not terrain.
- **Right-hand traffic.** Lane `index` 0 is the **rightmost** (kerb-side) lane in driving direction;
  higher indices are further left. (OSM's `*:lanes` tags list lanes left to right; the compiler reverses them.)
- Units: metres, seconds, metres per second. Angles are not stored.
- Unknown keys must be ignored by readers (forward compatibility within v1). A breaking change
  increments `formatVersion`.
- IDs are opaque strings, unique within the package.

## Top level

| Key | Type | Description |
|-----|------|-------------|
| `formatVersion` | `1` | Format version. |
| `baselineId` | string \| null | Baseline this package was produced from (null for previews). |
| `origin` | `{ lat, lon }` | Tangent-plane origin (WGS84). |
| `bbox` | `[west, south, east, north]` | Imported area (WGS84); the bounds of `area` for polygon imports. |
| `area` | `[lon, lat][]` \| absent | Import polygon ring for non-rectangular imports (#110); ways are clipped at its edge. Optional. |
| `osmTimestamp` | string \| null | ISO-8601 OSM data timestamp, if known. |
| `attribution` | string[] | Texts that must be displayed (ODbL, providers). |
| `nodes` | Node[] | Junctions, link ends and network boundary points. |
| `links` | Link[] | Directed road segments between two nodes. |
| `connectors` | Connector[] | Lane-to-lane movements through nodes. |
| `signals` | SignalController[] | Fixed-time signal plans. |
| `crossings` | Crossing[] \| absent | Pedestrian crossings (ADR-0020, #86). Optional; absent or empty in older packages. |
| `stats` | object | Informational counts (`nodes`, `links`, `lanes`, `connectors`, `signals`, `ignoredSigns` = stop/give-way signs that could not be attached to a junction). |

## Node

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | e.g. `"n12"`. |
| `osmId` | number \| null | OSM node id. |
| `x`, `y`, `z` | number | Position. |
| `control` | enum | `none` (plain link joint), `priority`, `right_before_left`, `all_way_stop`, `signal`, `roundabout`, `level_crossing`, `boundary` (network edge: vehicles enter/leave here). |

## Link

A link is **directed**. A two-way OSM way produces two links (one per direction) sharing the way's
geometry; a one-way way produces one.

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | e.g. `"l7"`. |
| `osmWayId` | number \| null | Source way. |
| `from`, `to` | string | Node ids. |
| `roadClass` | enum | `motorway`, `motorway_link`, `trunk`, `trunk_link`, `primary`, `primary_link`, `secondary`, `secondary_link`, `tertiary`, `tertiary_link`, `unclassified`, `residential`, `living_street`, `service`, `road`, `busway`. |
| `name` | string \| null | Street name or `ref`. |
| `layer` | integer | OSM `layer` (default 0; bridges default 1, tunnels −1). |
| `structure` | enum | `none`, `bridge`, `tunnel`, `covered`. |
| `roundabout` | boolean | Part of a roundabout ring. |
| `oppositeLink` | string \| null | The link of the other direction of the same way segment. |
| `throughTraffic` | boolean | False for `access=destination/private` (routing avoids it as transit). |
| `length` | number | Length of `geometry` in metres (after trimming at junctions). |
| `speedLimit` | number | m/s; lanes may override. |
| `geometry` | `[x,y,z][]` | Reference line in driving direction (way centreline, trimmed at junctions). |
| `lanes` | Lane[] | Ordered by `index` (0 = rightmost). At least one. |
| `boundaries` | Boundary[] | One per pair of adjacent lanes (`lanes.length - 1` entries). |
| `leftEdge` | enum | Marking left of the leftmost lane: `centre_dashed`, `centre_solid`, `double_solid` (two-way roads), `edge` (one-way). |
| `noLaneChangeZone` | number | Metres before the link end in which lane changes are forbidden (solid approach, default 30 before signals). |
| `assumed` | string[] | Attributes filled from defaults, e.g. `lanes`, `speedLimit`, `width`. |
| `endSign` | enum | Sign governing the approach at `to`: `none`, `stop`, `give_way`, `priority_road` (explicit OSM signs, signed priority roads, roundabout entries, all-way stops). Optional, default `none`. |
| `osmNodes` | `{id, x, y}[]` | OSM nodes along the link in travel direction (untrimmed positions; `id` null for clip points at the area border). Lets editors address any segment. Optional. |
| `osmForward` | boolean | True when the link runs in the OSM way's node order; false for the reverse direction of a two-way way (selects `:forward`/`:backward` tags in edits). Optional, default true. |
| `osmAfterFrom`, `osmBeforeTo` | number \| null | OSM nodes next to `from`/`to` along the way. Together with the node `osmId` they identify a movement for edits (ADR-0010): movement key = (junction `osmId`, incoming `osmBeforeTo`, outgoing `osmAfterFrom`). Optional. |

### Lane

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | `"<linkId>:<index>"`. |
| `index` | integer | 0 = rightmost. |
| `width` | number | Metres. |
| `speedLimit` | number | m/s. |
| `allowed` | enum[] | Vehicle classes: `car`, `van`, `truck`, `bus`, `motorcycle`. Empty = closed lane. |
| `turns` | enum[] | Turn markings: `left`, `slight_left`, `sharp_left`, `through`, `right`, `slight_right`, `sharp_right`, `reverse`, `merge_to_left`, `merge_to_right`. Empty = unmarked. |
| `geometry` | `[x,y,z][]` | Lane centreline in driving direction. |
| `length` | number | Metres. |

### Boundary

| Key | Type | Description |
|-----|------|-------------|
| `rightLane`, `leftLane` | integer | Adjacent lane indices (`leftLane = rightLane + 1`). |
| `marking` | enum | `dashed`, `solid`, `double_solid`, `solid_dashed` (solid on the left side, dashed on the right: only the right lane may cross), `dashed_solid` (only the left lane may cross). |
| `allowLeft` | boolean | Vehicles in `rightLane` may change left. |
| `allowRight` | boolean | Vehicles in `leftLane` may change right. |

`marking` is derived from the two permissions; renderers draw `marking`, the simulation obeys the
permissions.

## Connector

A movement from the end of one lane to the start of another through a node.

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | e.g. `"c31"`. |
| `node` | string | Node the movement passes. |
| `fromLink`, `fromLane` | string, integer | Incoming lane. |
| `toLink`, `toLane` | string, integer | Outgoing lane. |
| `turn` | enum | `through`, `left`, `right`, `slight_left`, `slight_right`, `sharp_left`, `sharp_right`, `reverse`. |
| `priority` | enum | `major` (has right of way), `minor` (yields), `stop` (stops, then yields), `signal` (controlled by `signalGroup`), `right_before_left`, `roundabout_entry` (yields to the ring), `roundabout_ring` (ring traffic). |
| `signalGroup` | string \| null | Signal group id when `priority = signal`. |
| `geometry` | `[x,y,z][]` | Curve from the incoming lane end to the outgoing lane start. |
| `length` | number | Metres. |
| `conflicts` | string[] | Connectors of the **same node** whose paths cross or merge with this one. Connectors at different nodes never conflict (grade separation, ADR-0016). The sim core derives a conflict zone per pair from the connector geometries and lane widths (#109). |

## SignalController

| Key | Type | Description |
|-----|------|-------------|
| `node` | string | Controlled node. |
| `cycle` | number | Cycle time in seconds. |
| `offset` | number | Offset in seconds. |
| `groups` | SignalGroup[] | |

### SignalGroup

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | Referenced by connectors. |
| `green` | `[start, end][]` | Green intervals within the cycle (seconds, `start < end ≤ cycle`). |
| `amber` | number | Amber duration after each green interval. |

Outside green and amber a group is red. Permissive movements (e.g. left turns during the opposing
green) carry `priority = signal` and list the opposing through connectors in `conflicts`; the
simulation yields on conflicts even when green.

## Crossing

A pedestrian crossing over a carriageway ([ADR-0020](../adr/0020-pedestrian-crossings.md)). Pedestrians
appear at one kerb, wait and walk to the other; the simulation lets them interact with the vehicles on
the crossed links.

| Key | Type | Description |
|-----|------|-------------|
| `id` | string | e.g. `"x3"`. |
| `osmId` | number \| null | OSM node (`highway=crossing`, a crossing-tagged signal node, or a node shared with a `footway=crossing` way); null for implicit crosswalks. |
| `kind` | enum | `zebra` (pedestrian priority), `signal`, `uncontrolled` (marked, no priority), `unmarked`. |
| `node` | string \| null | Signal node the crossing belongs to (junction or mid-block signal). |
| `signalGroup` | string \| null | Signal group of a signalised crossing. |
| `signalMode` | enum \| null | `parallel`: pedestrians walk during the group's green, turning vehicles yield (junction crosswalks); `request`: pedestrians request a phase that turns the group red (mid-block push-button signals). Null when not signalised; a `signal` crossing without a group behaves like a zebra crossing. |
| `implicit` | boolean | Assumed crosswalk at a signalised junction leg or mid-block signal (not mapped in OSM). |
| `width` | number | Kerb-to-kerb walking distance (m). |
| `depth` | number | Extent along the road (m): 4 for signalised crossings, 3 otherwise. |
| `demand` | number | Estimated pedestrians per hour, both directions (base value per road class × kind; scenarios override it). |
| `geometry` | `[x,y,z][2]` | First kerb → second kerb. Positions along the crossing (`span`, snapshot progress) are measured from the first kerb. |
| `links` | CrossingLink[] | The directional links crossed (one for one-way roads, two for two-way roads). |

### CrossingLink

| Key | Type | Description |
|-----|------|-------------|
| `link` | string | Link id. |
| `position` | number | Distance of the crossing centre from the link start (m); may equal the link length when the crossing sits on the node at the link end. |
| `span` | `[from, to]` | Lateral extent of the link's lanes along the crossing (m from the first kerb). |

Base demand (pedestrians/h): trunk 80, primary/secondary 120, tertiary 90, unclassified/road/busway 50,
residential 40, living street 30, service 20, motorway 0; × 0.6 for `uncontrolled`, × 0.4 for
`unmarked`, × 0.75 for implicit crosswalks. Generated scenarios scale it by the activity within 250 m
(`sim-core/README.md`, `pedestrians` config).

The contract fixture [`fixtures/network-package-crossings-v1.json`](fixtures/network-package-crossings-v1.json)
(a compiled signalised crossroads with every crossing kind, written by the backend's
`CrossingFixtureTests`) is run by the sim core and parsed by the frontend.

## Example

```jsonc
{
  "formatVersion": 1,
  "baselineId": null,
  "origin": { "lat": 48.2082, "lon": 16.3738 },
  "bbox": [16.37, 48.205, 16.378, 48.211],
  "osmTimestamp": "2026-11-14T10:00:00Z",
  "attribution": ["© OpenStreetMap contributors (ODbL)"],
  "nodes": [{ "id": "n1", "osmId": 101, "x": 0, "y": 0, "z": 0, "control": "signal" }],
  "links": [{
    "id": "l1", "osmWayId": 201, "from": "n0", "to": "n1", "roadClass": "primary", "name": "Ring",
    "layer": 0, "structure": "none", "roundabout": false, "oppositeLink": "l2", "throughTraffic": true,
    "length": 120.5, "speedLimit": 13.89, "geometry": [[-120.5, 0, 0], [0, 0, 0]],
    "lanes": [
      { "id": "l1:0", "index": 0, "width": 3.25, "speedLimit": 13.89, "allowed": ["car", "van", "truck", "bus", "motorcycle"],
        "turns": ["through", "right"], "geometry": [[-120.5, -4.875, 0], [0, -4.875, 0]], "length": 120.5 },
      { "id": "l1:1", "index": 1, "width": 3.25, "speedLimit": 13.89, "allowed": ["car", "van", "truck", "bus", "motorcycle"],
        "turns": ["left"], "geometry": [[-120.5, -1.625, 0], [0, -1.625, 0]], "length": 120.5 }
    ],
    "boundaries": [{ "rightLane": 0, "leftLane": 1, "marking": "dashed", "allowLeft": true, "allowRight": true }],
    "leftEdge": "centre_dashed", "noLaneChangeZone": 30, "assumed": ["width"]
  }],
  "connectors": [{ "id": "c1", "node": "n1", "fromLink": "l1", "fromLane": 1, "toLink": "l9", "toLane": 0, "turn": "left",
                   "priority": "signal", "signalGroup": "n1:g0", "geometry": [[0, -1.6, 0], [8, 6, 0]], "length": 11.2,
                   "conflicts": ["c4"] }],
  "signals": [{ "node": "n1", "cycle": 90, "offset": 0,
                "groups": [{ "id": "n1:g0", "green": [[0, 40]], "amber": 3 }, { "id": "n1:g1", "green": [[45, 85]], "amber": 3 }] }],
  "stats": { "nodes": 1, "links": 1, "lanes": 2, "connectors": 1, "signals": 1 }
}
```
