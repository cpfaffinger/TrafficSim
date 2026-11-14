# ADR-0005: OpenStreetMap is the authoritative road network source

- Status: Accepted
- Date: 2026-11-14

## Context

The simulation needs lane-level road geometry and attributes. Google Maps Platform terms prohibit
extracting or caching map content to build a separate dataset, and Google does not expose lane data.
OSM provides rich lane tagging (`lanes`, `turn:lanes`, `maxspeed`, signals) under the ODbL.

## Decision

- **OSM is the only road-network source.** Small areas come from Overpass community instances;
  larger areas from Geofabrik `.osm.pbf` extracts placed in `./data/osm`.
- **Photon** is the default geocoder (search box); **Nominatim** is a fallback for reverse geocoding.
- **OpenFreeMap** vector tiles provide the basemap ground layer.
- **Google Maps** may only be used through its own adapters for geocoding or as a visual basemap where
  its terms allow it — disabled by default, never stored as network data.

## Consequences

- Data quality depends on OSM coverage; the compiler fills gaps with documented defaults and marks them as assumed.
- We display "© OpenStreetMap contributors" and respect share-alike for exported networks.

## Alternatives considered

- Google Roads/Maps as geometry source: violates the terms, no lane data.
- Commercial HERE/TomTom data: paid, out of scope (could become another `IRoadNetworkSource`).
