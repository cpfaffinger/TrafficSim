# ADR-0019: Public transport lines and stops

- Status: Accepted
- Date: 2026-11-14

## Context

Buses shape urban traffic: they dwell at kerb stops, block a lane, bunch and need priority (#85).
To simulate them we need, per area, the **lines** (which roads, in which order, per direction),
their **stops** (where on which lane, kerb or bay) and a **frequency**. Two free sources exist:

| | GTFS feeds | OSM PTv2 route relations |
|---|---|---|
| Content | timetables (`stop_times`), stops with coordinates, `shapes` (optional), `frequencies` (rare) | `route=bus/trolleybus` relations: ordered member ways, `stop`/`platform` members, `ref`, `name`, `colour`, `interval` (on route or `route_master`) |
| Coverage / discovery | one feed per agency; no global index (Mobility Database / transit.land catalogues, partly needing API keys); national feeds (e.g. AT, DE, CH) are large zip files | worldwide, same data and pipeline as the roads (ADR-0005); quality varies, PTv2 is widespread in Europe |
| Licences | per feed (CC-BY, ODbL, custom terms, some forbid redistribution or need registration) | ODbL, attribution we already show (ADR-0014) |
| Geometry | stops and shapes are coordinates: must be map-matched onto our lane graph (error-prone at junctions, parallel roads) | ways are the roads we compile: lines map onto links exactly by OSM ids |
| Frequency | exact timetables per day type | `interval` (if mapped), otherwise unknown |
| Integration cost | new provider, download/caching of large archives, map matching, calendar handling | a few Overpass statements and a compiler rule |

## Decision

We will take **lines and stops from OSM**, fetched together with the roads by the existing road
network sources (Overpass, Geofabrik PBF), and compile them in a `TransitRule` onto the lane graph:

1. Bus and trolleybus route relations using any imported road, their member nodes in the area
   (stop positions, platforms) and their route masters are fetched as canonical `OsmRelation`s
   (ADR-0004: DTOs stay inside the adapters). Relations are stored with the raw OSM data so
   changesets recompile them (ways split by edits are followed in order).
2. The compiler orients the member ways into node paths (partial ways, reversed ways,
   roundabouts), looks every directed OSM segment up among the links (clip points at the area
   border included), bridges gaps inside the network by the shortest bus path of at most 400 m
   (never across the border) and keeps the **longest connected part**: a line enters at a boundary
   node or starts mid-network and leaves or ends likewise. Each route relation (one direction) is
   one line. Unroutable routes are dropped and counted (`stats.droppedTransitLines`); they never
   fail an import.
3. Stops are stop positions (else platforms within 30 m) projected onto the line's links in
   driving order; `bus_bay` on the stop, platform or way side marks bays.
4. The headway comes from `interval` (route, else route master), otherwise from the simulation
   config's default (20 min per line number and direction, shared by the line's route variants:
   OSM maps school, night and short variants as separate routes, and a regional hub such as Krems
   has over 200 route relations for 29 line numbers); every headway is **editable per scenario** (`transit` config keys), so missing
   or outdated OSM frequencies are a scenario input, not a data error.
5. The package carries optional `transitLines` (format version 1 stays; readers ignore the key).
6. In the sim core buses are dispatched per line on headways with a seeded phase, follow the line
   as a fixed route, change to the kerb lane before stops, dwell (base plus seeded random part)
   and block their lane unless the stop is a bay.

GTFS stays a possible later **optional provider behind a port** (e.g. `ITransitScheduleSource`)
that supplies timetables/headways for lines we already know from OSM, matched by `ref` and stop
names/positions — not a second geometry source.

## Consequences

- No new external service, no API keys, no new licence obligations; lines appear for every area
  where OSM has PTv2 routes, with the same import and the same attribution.
- Lines are exactly on our links (no map matching); edits to roads affect lines consistently.
- Frequencies are approximate (headway instead of timetable, no day types, no schedule
  adherence); users can tune them per scenario. Bus KPIs report headway regularity, not punctuality.
- Areas with poorly mapped routes yield fewer or shorter lines; the import reports dropped routes.
- Trams and other rail modes are out of scope (they need tracks, not lanes).

## Alternatives considered

- **GTFS as primary source**: exact timetables, but per-agency discovery, heterogeneous licences,
  large downloads and map matching onto the lane graph for every import — disproportionate effort
  for a plausibility-oriented simulator (concept §1.2).
- **Both sources merged at import**: best data, but doubles the complexity now; the port leaves
  this open.
- **User-drawn lines only**: no data dependency, but tedious and ignores the mapped routes.
