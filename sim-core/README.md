# sim-core

Deterministic microscopic traffic simulation core (Rust → WebAssembly), see
[ADR-0006](../docs/adr/0006-rust-wasm-simulation-core.md), [ADR-0007](../docs/adr/0007-microscopic-traffic-model.md)
and [ADR-0016](../docs/adr/0016-roundabouts-grade-separation-lane-markings.md). It reads the
[network package v1](../docs/architecture/network-package.md).

```bash
cargo test                       # native unit, scenario and golden-run tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo llvm-cov --summary-only    # CI gate: 85 % lines
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir ../frontend/src/generated/sim-core \
  target/wasm32-unknown-unknown/release/trafficsim_sim_core.wasm
cargo run --release --bin bench -- --seconds 300 --repeat 3 --check benches/budgets.json
cargo run --release --bin batch -- --package net.json --config config.json --seed-count 5 --out results.json
```

`wasm-bindgen-cli` must match the pinned `wasm-bindgen` version in `Cargo.toml`
(`cargo install wasm-bindgen-cli --version 0.2.130 --locked`). The frontend runs these steps with
`npm run build:wasm`. The native tools live in `src/tools` (the repository ignores `bin/`); a
wasm32 build compiles them too, `cargo build --lib …` skips them.

## Modules

| Module | Purpose |
|--------|---------|
| `package` | serde types of the network package v1 (unknown keys ignored, unknown enum values tolerated) |
| `network` | validated runtime lane graph: lanes and connectors as *segments*, flat arrays, conflict zones |
| `routing` | Dijkstra on links (free-flow times, replaceable link travel times, classes, `throughTraffic`) |
| `signals` | fixed-time signal plans (green / amber / red per group) |
| `sim` | the simulation: sources, IDM + perception, junction control, actuated signals, MOBIL + merging, re-routing, metrics glue, snapshots |
| `config` | simulation configuration (JSON) |
| `vehicle` | vehicle classes, the vehicle type catalogue (#50), per-vehicle parameters (`VehicleParams`) |
| `driver` | driver profiles with parameter distributions (#51) and the fleet sampler |
| `demand` | time-of-day curves, road-class profiles, zones, OD entries, residential generation config (#53, #111, #112) |
| `metrics` | lane cells and `lane-cells-v1` (#57), link/junction totals (#58), tailbacks and waves (#62) |
| `bench`, `batch` | benchmark scenarios and budgets (#78), headless batch runs (#84); binaries in `src/tools` |
| `synth` | synthetic networks (golden fixture, corridor, junctions, grids, motorway merge / lane drop / weaving) |
| `detmath` | `ln` and `x^δ` from IEEE basic operations only (platform-independent state) |
| `idm`, `rng`, `ring` | IDM, PCG32, the ring-road demo (`RingRoadSim`, unchanged) |
| `wasm` | `RingRoadSim` and `NetworkSim` bindings |

## WebAssembly API: `NetworkSim`

```ts
const sim = new NetworkSim(packageJson, configJson /* "" or "{}" = defaults */, 42n /* seed: BigInt */);
sim.step(n);                    // advance n fixed steps (Δt = sim.timeStep, default 0.1 s)
sim.time;                       // simulated seconds
sim.timeOfDay;                  // startTimeOfDay + time, wrapping at 24 h (s)
sim.vehicleCount;
const buf = sim.snapshot();     // Float32Array, sim.snapshotStride (= 9) floats per vehicle
const peds = sim.pedestrianSnapshot(); // Float32Array, 5 floats per pedestrian (ADR-0020)
JSON.parse(sim.statsJson());    // see "Statistics"
sim.signalStates();             // Uint8Array, one per signal group: 0 red, 1 amber, 2 green
JSON.parse(sim.signalGroupIdsJson()); // group ids in the same order
sim.setDemand("n1", 900);       // base rate of an entry (boundary) node; throws if not an entry
sim.demand("n1");               // base rate or undefined
sim.setOdDemand(0, 400);        // base rate of OD entry 0; throws if it does not exist
sim.odDemand(0);                // current rate (base × curve factor) or undefined
JSON.parse(sim.demandJson());   // all arrival processes, see "Demand"
sim.setLinkTravelTime("l7", 42);// routing cost of a link for unfamiliar drivers generated from now on
sim.stateChecksum();            // 16 hex digits over the full state (determinism checks)
// Metrics (#57, #58, #62, #84)
sim.laneCellBuckets;            // finished lane-cell buckets (index of the next one)
sim.laneCellsLatest();          // Uint8Array lane-cells-v1 with the latest finished bucket
sim.laneCellsSince(k);          // … with the retained buckets k, k+1, …
sim.laneCellsHistory();         // … with all retained buckets (metrics.maxBuckets)
JSON.parse(sim.summaryJson());  // run KPIs + per-link metrics, see "Summary"
JSON.parse(sim.junctionsJson());// queues, delays and level of service per junction
JSON.parse(sim.eventsJson());   // tailbacks and stop-and-go waves
sim.resetMetrics();             // restart the totals (e.g. after a warm-up)
JSON.parse(sim.vehicleJson(42));       // one vehicle: type, dimensions, trip so far, route (null once it left, #125)
JSON.parse(sim.vehicleTypesJson());   // catalogue of this run
JSON.parse(sim.driverProfilesJson()); // driver profiles of this run
// Free functions: builtinVehicleTypesJson(), builtinDriverProfilesJson(), builtinRoadClassProfilesJson()
```

The constructor throws a JS `Error` with a readable message for invalid JSON, dangling references
(unknown nodes/links/lanes/conflicts/signal groups/zones), inconsistent topology or invalid
configuration.

### Snapshot layout (stride 9, `f32`)

| Offset | Field | Unit / encoding |
|--------|-------|-----------------|
| 0, 1, 2 | `x, y, z` | metres, ENU (same frame as the package); vehicle **centre** on the lane centreline plus the lateral lane-change offset (#108) |
| 3 | `heading` | radians, counter-clockwise from +x (east); includes the yaw of the lateral lane-change motion |
| 4 | `speed` | m/s |
| 5 | `length` | m (from the vehicle type) |
| 6 | `classId` | 0 car, 1 van, 2 truck (rigid and articulated), 3 bus, 4 motorcycle |
| 7 | `flags` | bit 0 braking (< −1 m/s²), bit 1 waiting (< 0.5 m/s), bit 2 lane change in progress, bit 3 inside a junction (on a connector), bit 4 holding at a stop line (red / stop sign / yielding) or before an occupied conflict zone, bit 5 bus dwelling at a stop (#85) |
| 8 | `vehicleId` | stable id, unique per run (exact up to 2²⁴) |

Vehicles appear in insertion order; the order changes when vehicles leave, so match by `vehicleId`
when interpolating between frames.

### Pedestrian snapshot (stride 5, `f32`, ADR-0020)

| Offset | Field | Unit / encoding |
|--------|-------|-----------------|
| 0 | `crossing` | index into the package's `crossings[]` |
| 1 | `progress` | 0 at the first kerb (`geometry[0]`), 1 at the second |
| 2 | `direction` | +1 walking from the first kerb to the second, −1 back |
| 3 | `state` | 0 waiting at the kerb, 1 walking, 2 waiting on the crossing (centre line) |
| 4 | `slot` | small integer to spread a group (queue position while waiting) |

Empty without crossings or with `pedestrians.enabled = false`.

## Configuration (`configJson`)

All keys are optional; unknown keys are ignored (nested objects that are data — vehicle types,
driver profiles, road-class profiles, zones, OD entries, residential — reject unknown keys to
catch typos).

```jsonc
{
  "timeStep": 0.1,                    // s, (0, 1]
  "maxVehicles": 100000,              // insertion pauses above this count

  // ---- Demand (#42, #53, #111, #112) – see "Demand" below
  "startTimeOfDay": "07:00",          // or seconds since midnight (default 07:00)
  "curves": { "myCurve": {"interval": 900, "factors": [/* 96 × 15-min factors */]} },
  "profiles": { "residential": {"volumePerLane": 80, "curve": "weekday"} },
  "entries": { "n1": 900, "n3": {"vph": 200, "curve": "morningPeak"} },
  "autoEntries": true,                // default: true without "od", false with it
  "demand": { "n1": 900 },            // legacy: plain rates per entry node (entries win)
  "defaultDemand": 300,               // legacy: uniform rate for unlisted entries (disables road-class profiles)
  "demandCurve": "weekday",           // forces one curve for all boundary demand
  "destinationWeights": { "n2": 2 },  // boundary traffic: relative weight per exit node (0 = never)
  "zones": [ {"id": "west", "nodes": ["n1"], "links": ["l7"]} ],   // or {"west": {...}}
  "od": [ {"from": "west", "to": "east", "vph": 400, "curve": "eveningPeak",
           "vehicleMix": {"car": 9, "van": 1}, "driverMix": {"commuter": 1}} ],
  "autoZones": false,                 // residential trip generation
  "residential": { "classes": ["residential", "living_street", "service"],
                   "outboundPerKm": 40, "inboundPerKm": 40,
                   "outboundCurve": "commuterOut", "inboundCurve": "commuterIn",
                   "destinationWeights": {"motorway": 8, "trunk": 6, "primary": 4 /* …, others 1 */},
                   "exitWeight": 4, "insertAlongLink": true, "driverMix": null },

  // ---- Vehicles and drivers (#50, #51, #52)
  "vehicleMix": { "car": 0.85, "articulatedTruck": 0.1, "motorcycle": 0.05 }, // type shares; default cars only
  "vehicleMixCurves": { "articulatedTruck": "freight" },  // type share × curve factor
  "vehicleTypes": { "car": {"length": 4.7}, "minibus": {"class": "bus", "length": 7.5} },
  "driverMix": { "average": 5, "attentive": 2, "aggressive": 2, "distracted": 1 }, // default: legacy drivers
  "driverProfiles": { "rookie": {"reactionTime": {"mean": 1.1, "sd": 0.2, "min": 0.7, "max": 1.8}} },
  "heterogeneity": 0.0,               // legacy drivers only: 0..0.5 relative spread of v0 factor, T and a
  "perception": { "enabled": true, "emergencyFactor": 2.0 },

  // ---- Junctions, signals, lane changes (#44, #45, #46, #81, #82, #109)
  "junction": {
    "criticalGapMinor": 4.0, "criticalGapStop": 4.5, "criticalGapRoundabout": 3.0,
    "criticalGapRightBeforeLeft": 3.0, "criticalGapPermissive": 4.0,  // s, see "Junctions"
    "followUpTime": 2.0,              // s, minimum between two entries of a yielding movement
    "maxWait": 45.0,                  // s, deadlock breaker (2 × maxWait: a vehicle stops waiting for chained junctions, #126)
    "clearanceTime": 1.0              // s, post-encroachment time on a conflict zone (#109)
  },
  "signalControl": { "actuated": false /* true or ["n0", …] */, "minGreen": 7, "maxGreen": 60,
                     "extension": 3.0, "detectorLength": 30, "allRed": 2.0 },
  "laneChange": {
    "interval": 5,                    // discretionary evaluation every n steps (staggered)
    "keepRightBias": 0.3,             // m/s², motorway / trunk roads
    "cooldown": 3.0, "urgencyDistance": 200.0,
    "duration": 3.0,                  // s at ≥ 10 m/s; 0 = instantaneous changes (pre-#108 model)
    "minDuration": 1.0,               // s from standstill (linear in between)
    "visualDuration": 2.5             // s, display slide of instantaneous changes only
  },
  "merging": { "cooperation": true, "cooperationDistance": 200, "maxCooperativeDeceleration": 2.0,
               "courtesyBias": 0.5 },
  // ---- Pedestrians at the package's crossings (ADR-0020, #86)
  "pedestrians": {
    "enabled": true,
    "demandFactor": 1.0,              // × every crossing's demand (scenario level)
    "crossings": { "x3": 250 },       // pedestrians/h per crossing (default: package `demand`; unknown ids ignored)
    "curve": null,                    // time-of-day curve for all crossings (null = constant)
    "walkSpeed": 1.3, "walkSpeedSpread": 0.15, // m/s, uniform ± spread
    "gapMargin": 2.0,                 // s, uncontrolled / unmarked: gap = span time + margin
    "minVehicleGreen": 20, "walkTime": 7 // s, push-button signals
  },

  // ---- Public transport (#85): buses on the package's transitLines (no effect without lines)
  "transit": {
    "enabled": true,
    "defaultHeadway": 1200,           // s per line number and direction without an OSM interval, shared by its variants
    "headwayFactor": 1.0,             // multiplies every headway (0.5 = twice the service)
    "headways": { "t0": 300 },        // s per line id, overrides the package; 0 = line out of service
    "dwellTime": 15,                  // s base dwell per stop
    "dwellTimeRandom": 10,            // s, plus uniform [0, dwellTimeRandom) from the line's stream
    "vehicleType": "bus"              // catalogue type of the buses
  },

  // ---- Routing (#55) and metrics (#57, #58, #62)
  "reRouting": { "enabled": true, "interval": 60, "smoothing": 0.3, "threshold": 0.1, "enRoute": true },
  "metrics": { "enabled": true, "cellLength": 10, "bucketDuration": 30, "maxBuckets": 480,
               "queueSpeed": 2.0, "jamGap": 20, "detectionInterval": 5, "congestedSpeed": 5.0,
               "tailbackMinLength": 50 }
}
```

### Vehicle types (#50)

Built-in catalogue (`builtinVehicleTypesJson()`; `vehicleTypes` patches a type or adds one based
on the built-in type of its `class`):

| Type | Class | Length | Width | Height | Weight (t) | v max | a | b | T | s0 | gap factor |
|------|-------|-------:|------:|-------:|-----------:|------:|--:|--:|--:|---:|-----------:|
| `car` | car | 4.5 | 1.8 | 1.5 | 1.5 | 50 | 1.5 | 2.0 | 1.2 | 2.0 | 1.0 |
| `van` | van | 5.5 | 2.0 | 2.6 | 3.5 | 44 | 1.2 | 2.0 | 1.2 | 2.0 | 1.0 |
| `truck` (rigid) | truck | 12.0 | 2.55 | 3.8 | 18 | 25 | 0.7 | 1.5 | 1.6 | 2.0 | 1.2 |
| `articulatedTruck` | truck | 16.5 | 2.55 | 4.0 | 40 | 25 | 0.5 | 1.5 | 1.8 | 2.0 | 1.3 |
| `bus` | bus | 12.0 | 2.55 | 3.2 | 18 | 28 | 0.8 | 1.5 | 1.5 | 2.0 | 1.2 |
| `motorcycle` | motorcycle | 2.2 | 0.8 | 1.3 | 0.3 | 55 | 2.5 | 2.0 | 1.2 | 1.5 | 0.9 |

Routing (#125) only uses links whose `limits` (network package) the vehicle's length, width,
height and weight are within; the vehicle's origin and destination link are exempt. A vehicle
with no such route is counted as `unroutable`. Routes are cached per class and per set of
exceeded limits, so a network without limits routes exactly as before.

Further fields: `delta` (4), `safeDeceleration` (4 / 3 for heavy vehicles), `politeness`
(0.25 / 0.4). Mixes reference type names; the class decides lane permissions, routing and the
snapshot class id.

### Driver profiles (#51) and perception (#52)

Every parameter is a truncated normal `{"mean", "sd", "min", "max"}` (or a plain number),
sampled once per vehicle from its source's random stream (Marsaglia polar method on top of
`detmath::ln`). Factors scale the vehicle type: `speedFactor` (× limit), `timeHeadway`,
`acceleration`, `deceleration`, `minimumGap`, `politeness`, `gapAcceptance`; absolute values:
`reactionTime` (s, ≤ 2.5), `laneChangeThreshold` (m/s²), `lapseRate` (lapses per hour),
`lapseDuration` (s), `familiarity` (probability of being a commuter who routes on experienced
travel times). Built-ins: `attentive`, `average`, `distracted` (reaction ≈ 1.2 s, 30 lapses/h),
`aggressive` (T × 0.7, speed × 1.12, low politeness), `commuter` (familiarity 1). Without a
`driverMix` all vehicles are legacy average drivers (reaction time 0.8 s, `heterogeneity`).

Perception: every vehicle keeps a 32-step ring buffer of its odometer and speed. A follower with
reaction time `τ` sees its leader as it was `τ` ago, extrapolated with the old speed (Human Driver
Model anticipation): `gap' = gap − (x(t) − x(t−τ) − τ·v(t−τ))`, `v' = v(t−τ)`. During a
distraction lapse the driver keeps its acceleration (at most the free-road value). Safety: the
true state overrides perception when it requires braking harder than `emergencyFactor × b` or the
gap falls below `s0`. Lane changes and gap acceptance use the true state.

## Demand (#42, #53, #111, #112)

Arrival processes, each with its own PCG32 stream (changing one never changes another):

1. **Boundary entries** – one per boundary node with outgoing links. Rate precedence:
   `entries[node]` > `demand[node]` > `defaultDemand` > road-class profile. The road-class
   default is `Σ volumePerLane(class of entry link) × lanes` with the profile's curve
   (`demandCurve` overrides every curve). Destinations: all exits weighted by
   `destinationWeights` (U-turns back to the entry node excluded).
2. **OD entries** – `from` zone origins (links leaving the zone's nodes, or the zone's links)
   to `to` zone destinations (links reaching its nodes, or its links), own curve and mixes.
3. **Residential trips** (`autoZones`) – outbound from all links of the residential classes
   (rate `outboundPerKm` × km, origin weighted by length, vehicles start at a random driveway
   position *along* the link at standstill) to non-residential links weighted by road class
   (`destinationWeights`, links ending at a boundary × `exitWeight`); inbound from
   non-residential links (entries × `exitWeight`) back to residential links weighted by length.
   Large destination sets are sampled by weight and then routed (≤ 8 draws).

Rates are vehicles per hour at curve factor 1 (the peak hour of the built-in curves). Curves are
piecewise constant and repeat with period `interval × factors.length`; arrivals integrate the
rate exactly (`Exp(1)` work, basic arithmetic only). Built-in curves (hourly): `flat`,
`weekday` (double peak), `morningPeak` = `commuterOut`, `eveningPeak` = `commuterIn`,
`freight`. Built-in road-class profiles (veh/h per lane, all with curve `weekday`):

| Class | veh/h/lane | Class | veh/h/lane |
|-------|-----------:|-------|-----------:|
| motorway | 1400 | tertiary | 250 |
| trunk | 1000 | tertiary_link | 150 |
| motorway_link, primary | 600 | unclassified | 120 |
| trunk_link, secondary | 400 | residential | 60 |
| primary_link | 300 | service, busway | 30 |
| secondary_link | 200 | living_street | 20 |
| road, unknown | 150 | | |

`demandJson()` lists every process: `{kind: "boundary" | "od" | "residentialOut" |
"residentialIn", node, od, vph, factor, origins}`.

**Default demand JSON for imported networks (#113).** The backend should generate exactly this
shape, referencing node/link ids of the package:

```json
{
  "startTimeOfDay": 25200,
  "curves": {},
  "profiles": {"motorway": {"volumePerLane": 1400, "curve": "weekday"}},
  "entries": {"<boundary node id>": {"vph": 1200, "curve": "weekday"}},
  "autoEntries": true,
  "autoZones": true,
  "residential": {"outboundPerKm": 40, "inboundPerKm": 40},
  "zones": [{"id": "<zone id>", "nodes": ["<node id>"], "links": ["<link id>"]}],
  "od": []
}
```

Everything except `startTimeOfDay` may be omitted: `{"autoZones": true}` alone gives road-class
entry demand plus residential trips. `entries` only needs the nodes whose demand differs from
the road-class default.

## Statistics (`statsJson`)

`time`, `spawned`, `arrived`, `active`, `waitingToEnter` (generated vehicles queued at their entry
because the gap was not yet safe), `rerouted` (missed mandatory lane change), `stranded` (removed
at a dead end), `unroutable` (no destination reachable), `laneChanges`, `laneChangeAborts`
(lane changes reversed in their first half, #108), `forcedEntries` (deadlock
breaker), `lapses` (distraction lapses), `commuterReroutes` (en-route route changes of familiar
drivers), `meanTravelTime` (arrived vehicles, s), `meanSpeed` (active vehicles, m/s),
`pedestrians` (only with pedestrians: `{served, waiting, crossing, meanDelay}`).

## Metrics (#57, #58, #62)

Metrics never feed back into the dynamics and are not part of the state checksum. Overhead on
the benchmark scenarios is about 10 % (see "Performance").

### Lane cells and `lane-cells-v1` (#57)

Each lane is split into cells of `cellLength` metres (the last one may be shorter). Per cell and
bucket (`bucketDuration`, rounded to whole steps) the core accumulates vehicle-seconds,
vehicle-metres, lost time against the speed limit, queue presence (any vehicle slower than
`queueSpeed`), stops (transition below 0.5 m/s) and front crossings of the downstream boundary.
The newest `maxBuckets` finished buckets are kept. Binary format, little endian:

| Offset | Type | Field |
|--------|------|-------|
| 0 | `u8[4]` | magic `"LCV1"` |
| 4 | `u16` | version 1 |
| 6 | `u16` | header size (48) |
| 8 | `u32` | lane count `L` (= all lanes, in network lane order) |
| 12 | `u32` | cell count `C` |
| 16 | `u32` | bucket count `B` in this blob |
| 20 | `u32` | run index of the first bucket in this blob |
| 24 | `f32` | nominal cell length (m) |
| 28 | `f32` | bucket duration (s) |
| 32 | `f64` | time of day at simulation time 0 (s) |
| 40 | `u32` | field mask (`0x7f`) |
| 44 | `u32` | reserved |
| 48 | `L × 20 B` | lane table: `u32` link index (package `links[]` order), `u16` lane index, `u16` cell count, `u32` first cell, `f32` length (m), `f32` speed limit (m/s) |
| 48 + 20 L | `B × (16 C + pad4(6 C))` | buckets, oldest first |

Bucket block (field-major, every array 4-byte aligned so typed-array views work directly):
`Float32[C]` density (veh/km), `Float32[C]` mean speed (m/s, NaN = empty), `Float32[C]` speed
ratio v/v_limit (NaN = empty), `Float32[C]` delay (vehicle-seconds lost), `Uint16[C]` queue share
(1/10000 of the bucket), `Uint16[C]` stops, `Uint16[C]` flow (vehicles crossing the cell end),
zero padding. Bucket `k` covers `[k·T, (k+1)·T)` simulated seconds. The backend stores the blob
opaque with `bucketFormat = "lane-cells-v1"`; `metrics::cells::LaneCells::decode` reads it in Rust.

### Summary (`summaryJson`, batch runs)

```jsonc
{"formatVersion": 1, "time": 3900, "duration": 3600 /* since resetMetrics */, "startTimeOfDay": 25200,
 "network": {"spawned", "arrived", "active", "waitingToEnter", "stranded", "unroutable", "rerouted",
             "commuterReroutes", "laneChanges", "lapses", "meanTravelTime", "meanSpeed",
             "vehicleKm", "vehicleHours", "delayHours", "stops"},
 "links": [{"id": "l1", "length": 140, "lanes": 2,
            "meanSpeed": 9.1,        // space-mean speed m/s (null without traffic)
            "speedRatio": 0.66,      // meanSpeed / limit
            "flow": 820,             // vehicles leaving the link per hour
            "density": 25.3,         // mean vehicles per km (all lanes)
            "delay": 12.4,           // s lost per vehicle leaving the link (null if none)
            "delayTotal": 10168,     // vehicle-seconds lost
            "queueMax": 96, "queueMean": 31,  // m, sampled every second from the link end
            "stops": 140, "travelTime": 21.2, "freeFlowTime": 10.1}],
 "junctions": [/* as junctionsJson */],
 "events": {"tailbacks": 3, "stopAndGoWaves": 1},
 // only with transit lines (#85); whole run, not reset by resetMetrics; also transitJson()
 "transit": [{"id": "t0", "label": "13A", "headway": 300, "buses": 12, "completed": 11, "active": 1,
              "waitingToDepart": 0, "meanTravelTime": 142.5, "stops": 6, "stopsServed": 66,
              "stopsMissed": 0, "meanDwell": 19.8,
              "observedHeadway": 301.2,  // mean gap between consecutive buses at the stops (s)
              "headwayCv": 0.08}]}       // its coefficient of variation (bunching raises it)
 // only with pedestrians (ADR-0020):
 "pedestrians": {"arrived", "served", "waiting", "crossing", "meanDelay" /* s per served pedestrian */,
                 "vehicleStops", "vehicleDelayHours" /* caused by pedestrians */, "signalPhases",
                 "crossings": [{"id", "kind", "arrived", "served", "meanDelay", "maxWaiting"}]}}
```

## Public transport (#85, ADR-0019)

Each line of the package (`transitLines`, see the network package spec) dispatches buses
(`transit.vehicleType`) at the start of its first link: the first departure at a phase drawn
from the line's own PCG32 stream, then one per headway (`transit.headways` > package `headway` >
`defaultHeadway` × variants, times `headwayFactor`; *variants* = half the package lines with the
same `ref`, at least 1, because OSM maps school, night and short variants as separate routes); departures that cannot be inserted yet wait in a FIFO.
Buses follow the line's links as a fixed route (no router). Before a stop on the current link a
bus changes to the kerb lane (mandatory change, it holds the kerb lane until the stop) and brakes
for a standing obstacle at the stop position (stops are moved at least 20 m into a link). Within
3 m of the stop and below 0.5 m/s it dwells `dwellTime` plus the seeded random part. A dwelling
bus blocks its lane, so followers queue or overtake by MOBIL on multi-lane links; at a **bay** it
leaves the lane (out of the occupant lists, drawn 3 m to the right) and pulls out once the
follower can brake comfortably. A bus pushed past a stop, or re-routed off its line after a
missed mandatory lane change, counts the stop as missed. Without lines nothing changes: no
random numbers are drawn and runs stay bit-identical.

### Junctions (`junctionsJson`, #58)

Per node with connectors: `{id, control, signalised, throughput, flow, meanDelay, meanWait, los,
queueMax, approaches: [{link, queueMax, queueMean, queueMaxVehicles}], movements: [{connector,
fromLink, toLink, turn, count, flow, meanWait, meanDelay, los}]}`. Delay and wait are measured on
the approach link (time lost against the speed limit / time below 0.5 m/s). Level of service
follows the HCM control-delay thresholds (signalised A ≤ 10 < B ≤ 20 < C ≤ 35 < D ≤ 55 < E ≤ 80 <
F; unsignalised 10/15/25/35/50 s).

### Phenomena (`eventsJson`, #62)

Every `detectionInterval` the congested runs per lane are found (consecutive vehicles slower than
`congestedSpeed` with gaps ≤ `jamGap`).

- **Tailbacks:** the longest run of a lane ≥ `tailbackMinLength` starts or continues a tailback
  (ends below half of it): `{link, lane, start, end, head, length, maxLength, spillback,
  samples: [[t, length], …]}`; `spillback` = the queue reached the lane start.
- **Stop-and-go waves:** runs of ≥ 2 vehicles are tracked between detections; a run whose front
  moves upstream at −30…−5 km/h for three detections and was never anchored at a stop line /
  lane end (or split off such a queue) is a wave: `{link, lane, start, end, from, to, speed
  (m/s), minSpeed}`. Signal queues discharging after green are therefore not reported.

At most 10 000 events of each kind are stored (all are counted).

## Re-routing (#55)

Every vehicle leaving a link reports its time on it. Every `reRouting.interval` the mean report
is blended into an exponentially smoothed travel time per link (`smoothing`); links without
reports but with occupants stuck longer than the estimate use that stay, empty links relax to
free flow. Familiar drivers (profile `familiarity`, e.g. `commuter`) route on these times (a
second router) and re-plan en route from their current lane when the new route is faster by more
than `threshold`. Everybody else keeps free-flow routing plus `setLinkTravelTime` overrides.

## Actuated signals (#82)

`signalControl.actuated` selects controllers (all or node ids); fixed time stays the default.
Phases come from the fixed plan (groups sorted by green start, identical greens merged). Each
phase's detectors cover the last `detectorLength` m of the lanes feeding its connectors. A green
lasts ≥ `minGreen`; when another phase has a call it ends on gap-out (no detection for
`extension` s) or max-out (`maxGreen`); without conflicting calls it rests in green. Then the
groups' amber, `allRed`, and the next phase in plan order that has a call.

## Pedestrians (ADR-0020, #86)

Crossing demand, not agents: per crossing a Poisson process (own seeded stream, rate = package
`demand` or `pedestrians.crossings[id]`, × `demandFactor` × `curve`) puts pedestrians at either
kerb; everybody waiting at a kerb starts together. The crossing is split into the lateral spans of
the crossed links; before entering a span a pedestrian checks it:

| Crossing | Pedestrians enter a span when | Vehicles hold before the crossing (if they can stop) |
|----------|-------------------------------|------------------------------------------------------|
| `zebra` (and `signal` without group) | no vehicle on the crossing, every approaching vehicle can stop with ≤ 1.2 × its comfortable deceleration | for pedestrians on their span (≤ emergency factor × b) and waiting to step onto it (≤ 1.5 b) |
| `uncontrolled`, `unmarked` | the next vehicle needs ≥ span width / walking speed + `gapMargin`; may wait on the centre line | for pedestrians on their span |
| `signal`, `parallel` | walk: group green with ≥ half the crossing time left (fixed time); then as zebra | for pedestrians on their span (turning vehicles); before the crosswalk, not on it, when holding at the line |
| `signal`, `request` | walk aspect of the push-button controller | as above |

Push-button controllers replace their group's fixed-time plan: green rests until a pedestrian
waits and `minVehicleGreen` has passed, then amber (group amber), `signalControl.allRed`,
`walkTime`, and a clearance of width / (walkSpeed × (1 − spread)) before green. Pedestrian delay is
the time from arrival to the far kerb minus the walking time. Packages without crossings (or
`enabled: false`) run bit-identically; the pedestrian state is part of the state checksum only when
pedestrians run.

## Model

One step runs, in this fixed order and always iterating vehicles in a stable order:

1. **Occupant lists** per segment (lane or connector), sorted downstream-first (ties by id).
2. **Travel times / re-routing** at their interval (#55); **queue sampling and phenomena
   detection** at their intervals (#58, #62).
3. **Signals:** fixed-time aspect per group from `(t − offset) mod cycle`; actuated controllers
   update from their detectors (#82).
4. **Sources:** arrivals of all processes, then at most one insertion per entry queue (start of
   the link, or along it for residential trips) once the gap is safe in front and behind.
5. **Lane changes (#46, #97, #81):** MOBIL with politeness, safety criterion, threshold,
   keep-right bias, courtesy towards mergers and a strategic bias towards lanes that continue two
   links ahead; mandatory changes towards a lane connected to the next route link with an urgency
   ramp. Mergers on an ending lane wait at its end; other vehicles in a wrong lane re-route at the
   zone (at the latest 15 m before the lane end). **Continuous lateral motion (#108):** a change
   takes `laneChange.duration` (3 s at ≥ 10 m/s, linearly down to `minDuration` at standstill).
   The vehicle joins the target lane at the start and stays on the source lane as a *shadow* until
   the change ends: followers on both lanes (IDM leader search incl. look-ahead into the next lane,
   insertion, junction exit checks, MOBIL gaps of later changes) see it in both lanes, and it
   follows the leaders of both lanes. It cannot start another change meanwhile. If in the first
   half the gap ahead on the target lane drops below 1 m or the new follower would have to brake
   harder than 2 × `safeDeceleration`, the change is reversed (the lanes swap roles, the lateral
   motion continues back); in the second half it is completed. Entering a connector completes a
   change at once. The lateral offset follows `w · (1 − (3p² − 2p³))` of the progress `p` (lane
   centre distance `w`), so `x, y` and the heading of the snapshot come from the model state.
6. **Junctions (#44, #45, #109):** signal aspects, stop signs, priority and gap acceptance on
   conflict zones, claims, the zone safety net (see "Junctions" below and the module docs of
   `sim::junction`).
7. **Perception (#52):** distraction lapses start/end.
8. **IDM (#41):** leader search along the path, perceived with the reaction time, stop-line
   obstacles, dead ends, speed-limit anticipation, cooperative yielding to mergers (#81),
   emergency reflex on the true state.
9. **Integration:** ballistic update, segment transitions, arrivals; travel-time reports, movement
   metrics and lane-cell accumulation; perception history; bucket flush at bucket ends.

### Junctions: conflict zones and gap acceptance (#109)

**Zones.** For every conflicting connector pair the network derives a zone on each connector:
the stretch where its centreline comes closer to the other centreline than the sum of both
half swept widths (lane width, at most 2.55 m + 2 × 0.25 m, minus 5 cm so adjacent parallel lanes
never overlap), sampled every 0.25 m. Crossings take the stretch around the geometric crossing,
merges (same target lane) the stretch from the merge point to the connector end, other declared
conflicts the hull of all overlapping stretches (or the whole connector if the paths never come
close). `Network::conflict_zone(c, k)` returns (entry, exit) along `c`; `conflict_point` is kept.
A vehicle occupies a zone from its front passing the entry until its rear passes the exit.

**Decisions** compare occupancy windows (kinematic estimates):

- Vehicles *committed* to a conflicting connector (claimed, on it, or with the rear still on it)
  block a crossing unless the deciding vehicle enters its zone ≥ `clearanceTime` after they leave
  theirs or leaves its zone ≥ `clearanceTime` before they can reach theirs. On a merge only the
  zone entries must be `clearanceTime` apart; the second vehicle then follows the first as its
  IDM leader measured towards the common end (*merging leader*). Claims no longer block whole
  movements, and vehicles may follow each other through a junction.
- *Gap acceptance* (HCM definition): the next prioritised vehicle must reach the conflict zone at
  least the critical gap after the yielding vehicle departs from its line. A vehicle that is still
  approaching adds how much later than a vehicle standing at the line it reaches its own zone
  (≈ 0 for a queue follower rolling up, more for one arriving from far away). Arrivals of a
  higher-ranked stream are kinematic (accelerating to its desired speed) and count even while
  queued; a vehicle of that stream holding or crawling (< 2 m/s) within 15 m of its line means
  the stream offers no gap. Equal-rank streams keep first-come-first-served among waiting vehicles
  (right before left).
- A yielding merge keeps exit-lane room for the prioritised vehicles about to merge (on the
  connector or within 30 m of their line) and never fills its exit lane completely, so a
  congested roundabout ring cannot lock up.

**Safety net** (computed sequentially in the junction phase, applied by the IDM as an obstacle
at the zone entry, flag bit 4): a committed vehicle stops before a crossing zone while its
counterpart is occupied, before a merge zone until the vehicle in the counterpart has moved
ahead by its length + `s0`, and, within 2 s of its zone, lets a committed conflicting vehicle go
first that reaches its own zone earlier (ties by index). The scenario tests check after every
step that no crossing is occupied twice and that vehicles inside a merge never overlap.

**Capacity validation** (`tests/junction_capacity.rs`): T junction, single-lane minor approach
oversaturated, HCM base values configured (right turn `criticalGapMinor` 6.2 s / `followUpTime`
3.3 s, left turn 7.1 s / 3.5 s), 1 h after a 10 min warm-up. Reference: the HCM gap-acceptance
function `n(h) = 1 + ⌊(h − t_c)/t_f⌋` (Harders, the basis of the HCM potential-capacity curve
`c_p = v_c·e^(−v_c·t_c/3600) / (1 − e^(−v_c·t_f/3600))`) applied to the *observed* conflicting
headways. A single-lane stream with minimum headways has fewer long gaps than the exponential
headways behind the closed-form curve (at 800 veh/h the observed stream yields ≈ 70 % of `c_p`
even without minor traffic), so the curve itself is listed for comparison only. Seed 3:

| Movement | v_c (veh/h) | Simulated (veh/h) | HCM on observed headways | Ratio | HCM curve `c_p` | Ratio | Before #109: simulated (ratio to reference) |
|----------|------------:|------------------:|-------------------------:|------:|----------------:|------:|--------------------------------------------:|
| right | 182 | 776 | 851 | 0.91 | 866 | 0.90 | 644 (0.76) |
| right | 396 | 547 | 619 | 0.88 | 658 | 0.83 | 386 (0.61) |
| right | 616 | 368 | 410 | 0.90 | 494 | 0.75 | 218 (0.52) |
| left (both directions) | 282 | 626 | 649 | 0.97 | 674 | 0.93 | 478 (0.74) |
| left | 562 | 378 | 405 | 0.93 | 441 | 0.86 | 253 (0.61) |
| left | 880 | 182 | 206 | 0.88 | 270 | 0.67 | 99 (0.47) |

Acceptance (asserted): within ±15 % of the reference for these cases (checked for seeds 1–5:
0.87–0.99). At 800 veh/h the right turn reaches ≈ 0.84–0.87 of the reference (follow-up
dynamics, see "Known limitations"). The point model before #109 reached 47–76 % of the
reference (37–74 % of `c_p`).

### Determinism (#48)

Same package + config + seed ⇒ bit-identical state, checked by `state_checksum()` and the
golden-run tests (`sim::tests::golden_runs`: fixture, T junction, roundabout, driver profiles,
OD matrix with curves, right-before-left crossroads, motorway merge). The core has no I/O, no wall
clock, no global RNG, no hash-map iteration, and only uses IEEE basic operations (+ − × ÷ √) for
state. Golden checksums change whenever the model changes on purpose: update them in the same
commit (Phase 5 changes: reaction times applied by default; checksum extended by odometer, lapse
state, smoothed travel times and actuated controller state; #108: continuous lane changes,
checksum extended by the lane-change state and the abort counter; #109: conflict zones).

## Performance (#78)

`cargo run --release --bin bench` times three scenarios from the same warmed-up state with and
without metrics (best of `--repeat` runs) and checks `benches/budgets.json` with `--check` (exit
code 1 on a violation; local only, timing on shared CI runners is too noisy). Reference numbers
(native, i5-12400, one thread, 120 s simulated):

| Scenario | Vehicles | µs / vehicle-step | Real-time factor | Metrics overhead |
|----------|---------:|------------------:|-----------------:|-----------------:|
| grid (20 × 20 priority junctions, 2 lanes) | 6 500 | 0.23 | 66× | ≈ 10 % |
| grid, `--scale 2` (40 × 40) | 12 700 | 0.34 | 23× | ≈ 14 % |
| motorway (40 weaving units) | 3 400 | 0.15 | 194× | ≈ 10 % |
| city (16 × 16 signalised, mixed fleet/drivers) | 4 100 | 0.21 | 115× | ≈ 8 % |

Continuous lane changes (#108) and conflict zones (#109) cost about 40 % on the junction-heavy
scenarios and 15 % on the motorway (same machine, best of 3, without / with metrics):
grid 0.164 / 0.183 → 0.232 / 0.248 µs, motorway 0.111 / 0.121 → 0.128 / 0.137 µs, city
0.166 / 0.183 → 0.195 / 0.211 µs per vehicle-step; metrics overhead now ≈ 7–8 %.

Budget: ≥ 10 000 vehicles at ≥ 1× real time single-threaded means ≤ 10 µs per vehicle-step; the
checked budgets (≤ 1 µs, minimum real-time factors per scenario, metrics overhead ≤ 15 % with
timing noise) leave room for the WASM slowdown (typically 1.5–2×).

## Batch runner (#84)

```bash
batch --package net.json [--config config.json] [--seeds 1,2,3 | --seed-count N] \
      [--duration 3600] [--warmup 300] [--out results.json] [--cells-dir DIR] [--threads N]
```

Per seed: warm-up, `resetMetrics`, measured duration. Output: `{formatVersion: 1, seeds,
duration, warmup, network: {mean KPIs}, links: [mean per-link metrics in package order, same
fields as the summary], runs: [{seed, checksum, summary}]}`; with `--cells-dir` one
`cells-seed-<n>.bin` (`lane-cells-v1`, all buckets of the run) per seed. Exit code 1 with a
message on stderr for bad arguments, files or configurations.

## Known limitations

- Lane changes occupy both lanes for their whole duration (no sublane model: no partial lateral
  overlap with vehicles of a third lane, no lateral gap acceptance); lane choice looks two links
  ahead at most.
- Conflict zones use lane widths (at most 3.05 m), not the actual vehicle widths; occupancy times
  are kinematic estimates, the safety net corrects deviations (a vehicle may have to stop inside
  the junction). Crossing zones are exclusive; vehicles cannot share a wide crossing area side by
  side.
- The follow-up time is a minimum: queues of default cars discharge at about 3.5–3.9 s per
  vehicle at a yield line (start-up and move-up dynamics), so with HCM parameters the minor-road
  capacity falls below the HCM reference at high conflicting flows (right turn ≈ 0.85 at
  800 veh/h, see "Junctions").
- Vehicles whose destination becomes unreachable from their lane re-route to the nearest exit.
- Actuated phases are derived from the fixed plan; overlapping (non-identical) green intervals
  become separate phases.
- Wave and tailback detection works per lane; a wave crossing a link boundary is reported as two
  events.
- Junction delay is measured over the whole approach link, not a fixed distance.
- Buses run on headways, not timetables (no schedule adherence or holding), with one dwell-time
  distribution for all stops (no passenger demand); bays have unlimited capacity.
- Pedestrians exist only at crossings (no sidewalks, no jaywalking, no pedestrian–pedestrian
  interaction); vehicles yield per directional link (all lanes of a direction), not per lane.
