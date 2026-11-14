# ADR-0020: Pedestrian crossings as crossing demand

- Status: Accepted
- Date: 2026-11-14

## Context

Pedestrians shape urban traffic where they cross the road: drivers stop at zebra crossings, turning
vehicles wait for pedestrians walking parallel to their green, push-button signals interrupt a
corridor's green wave. TrafficSim's goal (concept §1) is the effect on **vehicle** traffic. A full
pedestrian model — agents with origins and destinations routed over a sidewalk network — would need
footway topology that OSM maps very unevenly (separately mapped sidewalks vs. `sidewalk=*` tags on the
road), a second routing graph and a social-force or cellular model for walking, all for an effect that
is concentrated at a few hundred metres of kerb (#86).

## Decision

**Pedestrians are modelled as crossing demand, not as agents on a footway network.** Each crossing has
a pedestrian arrival rate; pedestrians appear at one kerb, wait, cross at walking speed and disappear.
Only the interaction with vehicles on the crossed carriageway is simulated.

**Crossing kinds from OSM** (compiler, `CrossingRule`):

| OSM | Kind |
|-----|------|
| `crossing=traffic_signals`, `crossing:signals=yes`, or `highway=traffic_signals` with a `crossing=*` tag | `signal` |
| `crossing=zebra`, `crossing_ref=zebra`, `crossing:markings=zebra*`, or `crossing=uncontrolled\|marked` with `crossing_ref=zebra` | `zebra` |
| `crossing=uncontrolled\|marked` (other markings) | `uncontrolled` |
| `crossing=unmarked\|informal` | `unmarked` |
| `crossing=no` | no crossing |

Sources, in order: `highway=crossing` (or a crossing-tagged `highway=traffic_signals`) **nodes on
drivable ways**; as a fallback, a node shared by a drivable way and a `footway=crossing` way, classified
from the footway's tags. At **signalised junctions** every leg without a mapped crossing nearby gets an
**implicit crosswalk** (`signal`, `implicit: true`) — signalised junctions in cities almost always have
them, and OSM rarely maps all of them.

**Network package:** optional `crossings[]` (format v1, absent or empty in older packages): kerb-to-kerb
geometry, carriageway `width` (walking distance), `depth` along the road, kind, and per crossed
directional link the position from its start and the lateral span the link's lanes occupy across the
crossing. Signalised crossings reference a signal group with a mode:

- `parallel` (junction crosswalks): pedestrians walk during the green of the group whose approaches run
  parallel to them, i.e. across the leg they cross; vehicles turning into that leg yield to them
  (permissive conflict).
- `request` (mid-block push-button signals): pedestrian arrivals request a pedestrian phase — after a
  minimum vehicle green the group turns amber and red (all-red, walk, clearance), then returns to green.

**Pedestrian demand** (pedestrians per hour, both directions) is estimated at import: a base value per
road class and kind in the package (`demand`), refined by the scenario generator from the activity
density (shops, schools, jobs, dwellings, leisure) within 250 m of the crossing and a per-scenario
factor (`pedestrians.crossings` / `pedestrians.demandFactor` in the scenario config). Every value is an
assumption — OSM has no pedestrian counts — and stays editable.

**Simulation** (sim core, `sim/pedestrians.rs`): Poisson arrivals from a per-crossing seeded stream;
pedestrians walk at `walkSpeed` (±spread) and start together when the kerb they wait at opens (groups).
The crossing is split into the lateral spans of the crossed links; before entering a span a pedestrian
checks it:

- **zebra:** no vehicle on the crossing and every approaching vehicle can still stop comfortably;
  vehicles stop for pedestrians on the crossing and for pedestrians waiting to step onto it when they
  can stop comfortably;
- **uncontrolled / unmarked:** gap acceptance — the next vehicle reaches the crossing no earlier than
  the span's crossing time plus `gapMargin`; pedestrians may wait in the middle;
- **signal:** walk aspect for the first span, nothing on the crossing; vehicles yield to pedestrians on
  the crossing (turning vehicles) and stop before the crosswalk, not on it, when they hold at the line.

Vehicles see a blocked crossing as a standing obstacle before it (like a red stop line) when they can
still stop; KPIs report pedestrians served, mean pedestrian delay and the vehicle stops and delay
caused by crossings. Snapshots expose waiting and walking pedestrians as (crossing, progress).
Packages without crossings, or `pedestrians.enabled = false`, run bit-identically to before.

## Consequences

- Zebra crossings, pedestrian signals and permissive turns show their capacity effect on vehicles with
  little data and little runtime cost (work only on crossings with pedestrians).
- No pedestrian routes, sidewalks, jaywalking, pedestrian queues spilling over kerbs, cyclists on
  crossings or pedestrian–pedestrian interaction; pedestrian delay is a crossing delay only.
- Mid-block push-button signals replace their fixed-time plan by a request-driven one while pedestrians
  are enabled; junction signal plans are unchanged (pedestrian greens follow the vehicle greens).
- Implicit crosswalks are assumptions (flagged `implicit`) and can over-estimate pedestrian conflicts
  at signalised junctions without crosswalks (e.g. trunk roads); the demand factor can switch them off
  per crossing (`pedestrians.crossings: {"x3": 0}`).

## Alternatives considered

- **Pedestrian agents on a footway graph** (SUMO-style striping or social force): realistic walking
  but needs consistent sidewalk data and a second network; far beyond the vehicle-focused goal.
- **Static capacity reduction** (HCM pedestrian adjustment factors on saturation flow): cheap, but no
  emergent interaction, nothing to see, and no effect at zebra crossings or mid-block signals.
- **Crossings only from `footway=crossing` ways:** misses the many crossings mapped only as nodes on the
  road; kept as a fallback.
