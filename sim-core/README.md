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
| `network` | validated runtime lane graph: lanes and connectors as *segments*, flat arrays, conflict points |
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
| 0, 1, 2 | `x, y, z` | metres, ENU (same frame as the package); vehicle **centre** on the lane centreline plus the visual lane-change offset |
| 3 | `heading` | radians, counter-clockwise from +x (east) |
| 4 | `speed` | m/s |
| 5 | `length` | m (from the vehicle type) |
| 6 | `classId` | 0 car, 1 van, 2 truck (rigid and articulated), 3 bus, 4 motorcycle |
| 7 | `flags` | bit 0 braking (< −1 m/s²), bit 1 waiting (< 0.5 m/s), bit 2 lane change in progress (visual), bit 3 inside a junction (on a connector), bit 4 holding at a stop line (red / stop sign / yielding) |
| 8 | `vehicleId` | stable id, unique per run (exact up to 2²⁴) |

Vehicles appear in insertion order; the order changes when vehicles leave, so match by `vehicleId`
when interpolating between frames.

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

  // ---- Junctions, signals, lane changes (#44, #45, #46, #81, #82)
  "junction": {
    "criticalGapMinor": 4.0, "criticalGapStop": 4.5, "criticalGapRoundabout": 3.0,
    "criticalGapRightBeforeLeft": 3.0, "criticalGapPermissive": 4.0,
    "followUpTime": 2.0, "maxWait": 45.0
  },
  "signalControl": { "actuated": false /* true or ["n0", …] */, "minGreen": 7, "maxGreen": 60,
                     "extension": 3.0, "detectorLength": 30, "allRed": 2.0 },
  "laneChange": {
    "interval": 5,                    // discretionary evaluation every n steps (staggered)
    "keepRightBias": 0.3,             // m/s², motorway / trunk roads
    "cooldown": 3.0, "urgencyDistance": 200.0, "visualDuration": 2.5
  },
  "merging": { "cooperation": true, "cooperationDistance": 200, "maxCooperativeDeceleration": 2.0,
               "courtesyBias": 0.5 },

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

| Type | Class | Length | Width | v max | a | b | T | s0 | gap factor |
|------|-------|-------:|------:|------:|--:|--:|--:|---:|-----------:|
| `car` | car | 4.5 | 1.8 | 50 | 1.5 | 2.0 | 1.2 | 2.0 | 1.0 |
| `van` | van | 5.5 | 2.0 | 44 | 1.2 | 2.0 | 1.2 | 2.0 | 1.0 |
| `truck` (rigid) | truck | 12.0 | 2.55 | 25 | 0.7 | 1.5 | 1.6 | 2.0 | 1.2 |
| `articulatedTruck` | truck | 16.5 | 2.55 | 25 | 0.5 | 1.5 | 1.8 | 2.0 | 1.3 |
| `bus` | bus | 12.0 | 2.55 | 28 | 0.8 | 1.5 | 1.5 | 2.0 | 1.2 |
| `motorcycle` | motorcycle | 2.2 | 0.8 | 55 | 2.5 | 2.0 | 1.2 | 1.5 | 0.9 |

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
at a dead end), `unroutable` (no destination reachable), `laneChanges`, `forcedEntries` (deadlock
breaker), `lapses` (distraction lapses), `commuterReroutes` (en-route route changes of familiar
drivers), `meanTravelTime` (arrived vehicles, s), `meanSpeed` (active vehicles, m/s).

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
 "events": {"tailbacks": 3, "stopAndGoWaves": 1}}
```

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
   zone (at the latest 15 m before the lane end).
6. **Junctions (#44, #45):** signal aspects, stop signs, priority and gap acceptance, claims (see
   module docs of `sim::junction`).
7. **Perception (#52):** distraction lapses start/end.
8. **IDM (#41):** leader search along the path, perceived with the reaction time, stop-line
   obstacles, dead ends, speed-limit anticipation, cooperative yielding to mergers (#81),
   emergency reflex on the true state.
9. **Integration:** ballistic update, segment transitions, arrivals; travel-time reports, movement
   metrics and lane-cell accumulation; perception history; bucket flush at bucket ends.

### Determinism (#48)

Same package + config + seed ⇒ bit-identical state, checked by `state_checksum()` and the
golden-run tests (`sim::tests::golden_runs`: fixture, T junction, roundabout, driver profiles,
OD matrix with curves, right-before-left crossroads, motorway merge). The core has no I/O, no wall
clock, no global RNG, no hash-map iteration, and only uses IEEE basic operations (+ − × ÷ √) for
state. Golden checksums change whenever the model changes on purpose: update them in the same
commit (Phase 5 changes: reaction times applied by default; checksum extended by odometer, lapse
state, smoothed travel times and actuated controller state).

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

- Lane changes are instantaneous in the model (the snapshot interpolates laterally for display);
  lane choice looks two links ahead at most.
- Conflict areas are reduced to one conflict point per connector pair; claims block whole
  movements until that point is cleared.
- Vehicles whose destination becomes unreachable from their lane re-route to the nearest exit.
- Actuated phases are derived from the fixed plan; overlapping (non-identical) green intervals
  become separate phases.
- Wave and tailback detection works per lane; a wave crossing a link boundary is reported as two
  events.
- Junction delay is measured over the whole approach link, not a fixed distance.
