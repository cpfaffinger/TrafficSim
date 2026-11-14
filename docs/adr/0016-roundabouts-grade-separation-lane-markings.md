# ADR-0016: Roundabouts, grade separation and lane markings in the network model

- Status: Accepted
- Date: 2026-11-14

## Context

Real networks contain roundabouts, interchanges with bridges and tunnels (over- and underpasses),
and lane markings that forbid lane changes (solid lines, "Sperrlinien"). A simulator that ignores
them produces wrong junctions (crossing roads on different levels become intersections), wrong
priorities (roundabout entries do not yield) and wrong lane changes (vehicles cross solid lines).
OSM models all three explicitly, but in different ways.

## Decision

**Roundabouts**

- `junction=roundabout|circular` ways form a **ring**: implicitly one-way, each node where a road
  enters or leaves becomes a junction with control `roundabout`. Entries **yield to circulating
  traffic**; the ring itself has priority. `junction=circular` follows explicit `give_way`/`stop`
  tags and falls back to roundabout rules.
- `highway=mini_roundabout` nodes become a single junction with control `roundabout` (traversable,
  no ring geometry); `direction=clockwise` is honoured.
- Multi-lane and turbo roundabouts use `lanes` and `turn:lanes` on ring segments and entries, plus the
  lane-change rules below (solid lines between spiral lanes).

**Grade separation (bridges, tunnels, over- and underpasses)**

- **Topology follows OSM nodes only.** Two ways intersect only where they share a node. Ways that
  cross geometrically without a shared node never form a junction and have **no conflict zone**.
  The compiler asserts this with a dedicated test (motorway over a city street).
- Each link carries `layer` (integer, default 0), `structure` (`none|bridge|tunnel|covered`) and a
  derived **vertical level**. Without elevation data (backlog #87), the renderer places links at
  `layer × 6 m` and interpolates ramps along links whose endpoints sit on different levels; bridges
  get decks and piers, tunnels are drawn transparent or hidden with portals.
- Conflict detection in junctions only pairs connectors on the same level.
  `railway=level_crossing` nodes become a junction control `level_crossing` (treated as `stop` for
  now).

**Lane markings and lane-change restrictions**

- Between adjacent lanes of a link the model stores a **lane boundary** with a `marking`
  (`dashed`, `solid`, `double_solid`, `solid_dashed`, `dashed_solid`) and derived permissions
  `allowLeft`/`allowRight` for vehicles in the lanes on either side.
- Sources, in order: `change:lanes[:forward|:backward]` (`yes|no|not_left|not_right` per lane),
  `change[:forward|:backward]`, `overtaking[:forward|:backward]=no` (solid centre line on two-way
  roads), `divider=*`. Defaults: dashed between same-direction lanes, dashed centre line, and a
  **solid approach zone** before signalised junctions (configurable, default 30 m, flagged as assumed).
- The network package carries boundaries; the sim core's MOBIL model only proposes lane changes
  the boundary allows; mandatory route lane changes must happen before the solid approach zone.
- The renderer draws markings from the same boundaries (plus edge lines, stop lines and turn arrows
  from `turn:lanes`), so what users see is what vehicles obey.

**Right-of-way signs** (Phase 10)

- Stop/give-way signs come from `highway=stop|give_way` or `traffic_sign=*` (DE/AT/CH/FR/IT/NL/GB codes
  and `stop`/`give_way` values). They apply to the next junction in their direction, following the
  road across plain joints up to 60 m; unattributable signs are counted (`stats.ignoredSigns`).
- Signed priority roads (`priority_road=designated|yes_unposted`, `traffic_sign=DE:306` …) outrank
  road-class priority and disable right-before-left at their junctions.
- The editor suppresses signals inferred from approach nodes with the TrafficSim-specific node tag
  `trafficsim:signals=no` (never written back to OSM).

## Consequences

- The network package gains `layer`, `structure`, `boundaries[]` and the junction controls
  `roundabout` and `level_crossing` (format v1, documented in
  `docs/architecture/network-package.md`).
- The editor (Phase 7) edits boundary markings, structures and roundabout conversions as changeset
  operations.
- Without elevation data, vertical placement is schematic; real gradients stay in backlog #87.

## Alternatives considered

- Detecting intersections geometrically: wrong for every bridge and tunnel; OSM's shared-node rule
  is the established convention.
- Storing lane-change permissions per lane instead of per boundary: asymmetric markings
  (`solid_dashed`) cannot be represented consistently from both sides.
