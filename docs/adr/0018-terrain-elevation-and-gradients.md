# ADR-0018: Terrain elevation and gradients

- Status: Accepted
- Date: 2026-11-14

## Context

Until now the network was flat: `z` only carried the schematic grade-separation offset of
[ADR-0016](0016-roundabouts-grade-separation-lane-markings.md). Real roads climb and descend, and
gradients matter for traffic: a loaded articulated truck crawls up a 6 % grade at well below
40 km/h, while a car barely notices it. Issue #87 asks for an `IElevationProvider` port
([ADR-0004](0004-provider-ports-and-anti-corruption-layers.md)), gradient-aware vehicle dynamics and
visible 3D terrain. Constraints: free services only, no API keys (C-04, C-05), no heavy native
dependencies, imports must never fail because of an optional data source.

Candidate sources (all free and key-less):

| Source | Access | Resolution | Effort / limits |
|--------|--------|------------|-----------------|
| Copernicus DEM GLO-30 (AWS Open Data, `copernicus-dem-30m`) | Cloud-optimised GeoTIFF per 1°×1° cell | 30 m, global, very good quality | Float32 GeoTIFF with internal tiling and deflate compression plus a floating-point predictor: needs a TIFF/COG reader with HTTP range requests, IFD parsing and predictor decoding; licence requires the DLR/Airbus/Copernicus notice. |
| AWS Terrain Tiles, Terrarium encoding (AWS Open Data, `elevation-tiles-prod`) | Web-Mercator PNG tiles `terrarium/{z}/{x}/{y}.png` over HTTPS/CDN, zoom 0–15 | ~30 m and better where national data exists (blend of SRTM, GMTED2010, ETOPO1, USGS 3DEP, EU-DEM, national LiDAR …) | 8-bit RGB PNG, height = `R·256 + G + B/256 − 32768` m: a ~150-line managed PNG decoder over `ZLibStream`; same tile math as the basemap. |
| OpenTopoData public API | JSON, points per request | Datasets of choice (SRTM, EU-DEM …) | Public instance: at most 100 points per request, 1 request/s and 1000 requests/day — far too little for a terrain grid of tens of thousands of samples. |

## Decision

1. **Default source: AWS Terrain Tiles (Terrarium PNG).** The adapter `TrafficSim.Providers/TerrainTiles`
   fetches the tiles covering the requested points through the shared fetch pipeline (User-Agent,
   resilience, rate limit, 30-day response cache), decodes them with a small internal PNG decoder
   (8-bit RGB/RGBA, all five scanline filters) and samples heights bilinearly. The zoom level adapts
   to the area: the highest zoom ≤ `Zoom` (default 13, ≈ 13–19 m pixels at mid latitudes) that needs
   at most `MaxTiles` tiles (default 64). Copernicus GLO-30 stays a candidate for a second adapter
   behind the same port if better quality is ever needed; OpenTopoData is unsuitable for grids.
2. **Port.** `IElevationProvider.SampleAsync(points)` returns heights above sea level for WGS84
   points (null where the source has no data). It is a plain point sampler, so other sources can
   be plugged in without knowing the local plane. Configuration: `Providers:TerrainTiles:Enabled|BaseUrl|Zoom|MaxTiles|...`;
   disabling it gives flat terrain.
3. **Terrain grid.** At import the application samples a regular grid in the local ENU plane over
   the area (cell size ≥ 30 m, at most 256 cells per side), stores heights **relative to the ground
   height at the origin** (so `z` stays small and the origin is at `z = 0`), and passes it to the
   compiler. The package carries it as the optional top-level key `terrain`; changeset recompiles
   reuse the baseline's grid, so edits never refetch elevation.
4. **Never fail an import.** Provider errors, timeouts or a grid without any data give flat terrain
   (`terrain: null`, the previous behaviour) and a logged warning.
5. **Compiler rule (`ElevationRule`).** `z = ground + grade-separation offset`. Nodes get the
   terrain height under them plus their schematic level (ADR-0016). Along ordinary links the ground
   is sampled every 10 m and smoothed with a ±20 m moving average (DEM noise would otherwise
   produce spurious grades), with the ends pinned to the nodes' ground so links stay continuous.
   **Bridges, tunnels and covered ways (and any link with `layer ≠ 0`) interpolate the ground
   linearly between their end nodes** instead of sampling under them: a bridge deck stays smooth
   above a valley, a tunnel runs straight under a hill. The schematic layer ramps of ADR-0016 are
   added on top unchanged. Without terrain the rule reproduces the previous geometry exactly.
6. **Sim core: grade-aware longitudinal dynamics.** The grade (rise over run) is derived from lane
   and connector geometry per polyline piece and clamped to ±12 %. Every vehicle type has a
   `specificPower` (usable power at the wheels per mass, W/kg: car 50, van 35, motorcycle 80,
   rigid truck 10, bus 10, articulated truck 7). Uphill, the acceleration the vehicle can deliver
   is `max(a, P/m / max(v, 5 m/s) − g·c_r) − g·sin θ` (`c_r` = 0.008): the IDM acceleration is
   capped at that value, so braking is unaffected, cars keep their power reserve and heavy
   vehicles lose speed until power and gravity balance (articulated truck ≈ 37 km/h, rigid truck
   ≈ 50 km/h on 6 %). Downhill, positive accelerations are boosted by half the gravity component
   (at most ×1.5); the IDM still holds the desired speed, so nobody speeds downhill. On flat
   segments nothing changes (bit-identical results).
7. **Renderer.** The frontend draws the package `terrain` as a shaded height-field mesh under the
   network (toggle "Terrain") and drapes the basemap vertices onto it.
8. **Attribution.** Packages built with terrain list the Terrain Tiles attribution (Mapzen/Tilezen
   on AWS Open Data with its sources SRTM, GMTED2010, ETOPO1, USGS 3DEP, EU-DEM © Copernicus and
   others; see the Tilezen `joerd` attribution document) in `attribution`, shown in the UI with the
   OSM notice.

## Consequences

- Real-world imports show hills and valleys; trucks slow down on climbs, which affects capacity
  and queues realistically. Grade-separation-only networks keep their behaviour apart from short
  schematic ramps (clamped grades on bridge links).
- One more external request burst per import (cached for 30 days); its failure is harmless.
- `terrain` makes packages larger (≤ 66 k heights, rounded to 0.1 m, gzip-compressed).
- The basemap drape is per vertex; large polygons may cut slightly into the terrain on strong
  relief. Vertical datum is the source's (EGM96 geoid / national datums); only relative heights
  are used.

## Alternatives considered

- **Copernicus GLO-30 COGs:** best single global dataset, but a correct GeoTIFF/COG reader (tiling,
  range requests, deflate, floating-point predictor) is considerably more code than a PNG decoder
  for little gain at our ~30 m grid; kept as a future adapter.
- **OpenTopoData public API:** too restrictive (100 points/request, 1000 requests/day).
- **Sampling terrain under bridges and tunnels:** produces decks that follow the valley floor and
  tunnels that climb over hills.
- **Gravity as a plain additive term `−g·sin θ` for every vehicle:** slows cars on every climb as
  much as trucks; real cars compensate with their power reserve.
