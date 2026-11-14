# ADR-0011: Coordinate reference systems

- Status: Accepted
- Date: 2026-11-14

## Context

OSM uses WGS84 latitude/longitude. Simulation and rendering need metres with good float precision;
`Float32` in WebGL loses precision with large world coordinates.

## Decision

- **Storage:** WGS84, SRID 4326 in PostGIS.
- **Backend computations:** geodesic lengths, or projection to the matching UTM zone for metric operations.
- **Network package / simulation / rendering:** a **local East-North-Up tangent plane** in metres around
  the area origin (the package carries the origin). Valid for areas up to roughly 50 km across.
- **Scene axes:** x = east, y = up, z = −north (Three.js is y-up, right-handed).

## Consequences

- One conversion module per stack, tested against known reference points.
- Very large regions would need tiling into several origins (future concern).

## Alternatives considered

- Web Mercator metres everywhere: scale distortion (1/cos φ) would falsify speeds and distances.
