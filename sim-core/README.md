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
cargo test --release -- --ignored --nocapture perf   # throughput benchmark (PERF_GRID=n, PERF_VPH=v)
```

`wasm-bindgen-cli` must match the pinned `wasm-bindgen` version in `Cargo.toml`
(`cargo install wasm-bindgen-cli --version 0.2.130 --locked`). The frontend runs these steps with
`npm run build:wasm`.

## Modules

| Module | Purpose |
|--------|---------|
| `package` | serde types of the network package v1 (unknown keys ignored, unknown enum values tolerated) |
| `network` | validated runtime lane graph: lanes and connectors as *segments*, flat arrays, conflict points |
| `routing` | Dijkstra on links (free-flow times, replaceable link travel times, classes, `throughTraffic`) |
| `signals` | fixed-time signal plans (green / amber / red per group) |
| `sim` | the simulation: sources, IDM following, junction control, MOBIL lane changes, snapshots |
| `config` | simulation configuration (JSON) |
| `vehicle` | vehicle classes and per-vehicle parameters (`VehicleParams`) |
| `detmath` | `ln` and `x^δ` from IEEE basic operations only (platform-independent state) |
| `idm`, `rng`, `ring` | IDM, PCG32, the ring-road demo (`RingRoadSim`, unchanged) |
| `wasm` | `RingRoadSim` and `NetworkSim` bindings |

## WebAssembly API: `NetworkSim`

```ts
const sim = new NetworkSim(packageJson, configJson /* "" or "{}" = defaults */, 42n /* seed: BigInt */);
sim.step(n);                    // advance n fixed steps (Δt = sim.timeStep, default 0.1 s)
sim.time;                       // simulated seconds
sim.vehicleCount;
const buf = sim.snapshot();     // Float32Array, sim.snapshotStride (= 9) floats per vehicle
JSON.parse(sim.statsJson());    // see "Statistics"
sim.signalStates();             // Uint8Array, one per signal group: 0 red, 1 amber, 2 green
JSON.parse(sim.signalGroupIdsJson()); // group ids in the same order
sim.setDemand("n1", 900);       // vehicles per hour at an entry (boundary) node; throws if not an entry
sim.demand("n1");               // current rate or undefined
sim.setLinkTravelTime("l7", 42);// routing cost of a link for vehicles generated from now on
sim.stateChecksum();            // 16 hex digits over the full state (determinism checks)
```

The constructor throws a JS `Error` with a readable message for invalid JSON, dangling references
(unknown nodes/links/lanes/conflicts/signal groups), inconsistent topology or invalid configuration.

### Snapshot layout (stride 9, `f32`)

| Offset | Field | Unit / encoding |
|--------|-------|-----------------|
| 0, 1, 2 | `x, y, z` | metres, ENU (same frame as the package); vehicle **centre** on the lane centreline plus the visual lane-change offset |
| 3 | `heading` | radians, counter-clockwise from +x (east) |
| 4 | `speed` | m/s |
| 5 | `length` | m |
| 6 | `classId` | 0 car, 1 van, 2 truck, 3 bus, 4 motorcycle |
| 7 | `flags` | bit 0 braking (< −1 m/s²), bit 1 waiting (< 0.5 m/s), bit 2 lane change in progress (visual), bit 3 inside a junction (on a connector), bit 4 holding at a stop line (red / stop sign / yielding) |
| 8 | `vehicleId` | stable id, unique per run (exact up to 2²⁴) |

Vehicles appear in insertion order; the order changes when vehicles leave, so match by `vehicleId`
when interpolating between frames.

### Configuration (`configJson`)

All keys are optional; unknown keys are ignored.

```jsonc
{
  "timeStep": 0.1,                    // s, (0, 1]
  "defaultDemand": 300,               // veh/h for every entry node not listed in "demand"
  "demand": { "n1": 900, "n3": 200 }, // veh/h per entry (boundary) node id
  "destinationWeights": { "n2": 2 },  // relative weight per exit node id (default 1, 0 = never)
  "vehicleMix": { "car": 0.85, "truck": 0.1, "motorcycle": 0.05 }, // default: cars only
  "heterogeneity": 0.0,               // 0..0.5 relative spread of v0 factor, T and a
  "maxVehicles": 100000,              // insertion pauses above this count
  "junction": {
    "criticalGapMinor": 4.0, "criticalGapStop": 4.5, "criticalGapRoundabout": 3.0,
    "criticalGapRightBeforeLeft": 3.0, "criticalGapPermissive": 4.0,
    "followUpTime": 2.0, "maxWait": 45.0
  },
  "laneChange": {
    "interval": 5,                    // discretionary evaluation every n steps (staggered)
    "keepRightBias": 0.3,             // m/s², motorway / trunk roads
    "cooldown": 3.0, "urgencyDistance": 200.0, "visualDuration": 2.5
  }
}
```

### Statistics (`statsJson`)

`time`, `spawned`, `arrived`, `active`, `waitingToEnter` (generated vehicles queued at their entry
because the gap was not yet safe), `rerouted`, `stranded` (removed at a dead end), `unroutable`
(no destination reachable), `laneChanges`, `forcedEntries` (deadlock breaker), `meanTravelTime`
(arrived vehicles, s), `meanSpeed` (active vehicles, m/s).

## Model

One step runs, in this fixed order and always iterating vehicles in a stable order:

1. **Occupant lists** per segment (lane or connector), sorted downstream-first (ties by id).
2. **Signals:** aspect per group from `(t − offset) mod cycle`; amber follows each green interval.
3. **Sources (#42):** every boundary node with outgoing links is an entry with Poisson arrivals
   (`demand`) drawn from its *own* PCG32 stream, so changing one entry never changes another.
   Each arrival draws class, parameters and a destination (exit links weighted by
   `destinationWeights`, U-turns back to the entry node excluded). It is inserted at the start of
   the entry link in the lane with the most space once the equilibrium gap for the leader's speed
   is available; until then it waits in the entry queue. Vehicles leave at the end of their
   destination link.
4. **Lane changes (#46, #97):** MOBIL with politeness, safety criterion (`b_safe`), threshold and a
   keep-right bias on motorways; a driver only changes for an own advantage (or the keep-right
   rule). A vehicle whose lane has no connector to its next route link changes towards the nearest
   lane that has one; the accepted braking of the new follower grows with urgency towards the end
   of the lane-change area. Changes happen only where the boundary allows them (`allowLeft` /
   `allowRight`), never inside `noLaneChangeZone`, and never after a junction entry was claimed.
   A vehicle still in a wrong lane at the zone (at the latest 15 m before the lane end) re-routes
   from its lane (original destination if reachable, otherwise the nearest exit).
5. **Junctions (#44, #45):** the vehicle that is first in line for a controlled connector decides
   every step. Red → hold; amber → hold if a comfortable stop is possible (`v²/2b ≤ d`), otherwise
   go (dilemma zone); stop sign → full stop first. Then: the exit lane must have room (keep the box
   clear), no conflicting connector may be *blocking* (claimed, or a vehicle on it has not cleared
   the conflict point — the first crossing of the two geometries, or the end for merges), and for
   every conflicting movement it must yield to, the next approaching vehicle (searched upstream
   across connectors) must arrive at least the critical gap after this vehicle reaches its holding
   position; consecutive yielding entries keep the follow-up time. Priority: `major` and
   `roundabout_ring` over `minor`, `stop`, `roundabout_entry`, `right_before_left`; equal low rank
   → right before left; oncoming → left turns yield; permissive signalised movements (left turns)
   yield to conflicting movements of the same green. A vehicle holding at a stop line defers to
   approaching vehicles that are also holding only if they waited longer (first come, first served),
   which resolves mutual yielding; after `maxWait` an unsignalised vehicle ignores approaching
   traffic and only waits for the junction to be physically clear. A positive decision becomes a
   *claim* at the point of no return (yielding movements) or right before the stop line
   (prioritised movements); vehicles never enter a controlled connector without a claim.
   Connectors at different nodes never conflict, so bridges and tunnels never interact with the
   roads they cross.
6. **IDM (#41):** leader search along the vehicle's own path (lane → connector → lane …) within a
   look-ahead of `30 m + 7 s · v` (max 250 m), including vehicles still leaving the lane through
   another connector; stop-line obstacles; dead-end lanes; anticipation of lower speed limits ahead
   (connector curve speeds are derived from the connector geometry with 2.5 m/s² lateral
   acceleration). Desired speed = `speedFactor × limit`, capped by the vehicle's top speed.
7. **Integration:** ballistic update with speeds clamped at ≥ 0; segment transitions; arrivals.

### Determinism (#48)

Same package + config + seed ⇒ bit-identical state, checked by `state_checksum()` and the
golden-run tests (`sim::tests::golden_runs`, which also pass unchanged in the WASM build). The core
has no I/O, no wall clock, no global RNG, no hash-map iteration, and only uses IEEE basic operations
(+ − × ÷ √) for state (`detmath::ln` replaces libm's `ln` for Poisson arrivals, `x^δ` uses
multiplication for integer δ). Golden checksums change whenever the model changes on purpose:
update them in the same commit.

### Phase 5/6 hooks

- `VehicleParams` holds per-vehicle IDM (`speedFactor`, `T`, `a`, `b`, `s0`, `δ`), MOBIL
  (`politeness`, threshold, `b_safe`), `reactionTime` (stored, not applied yet), length, class and
  a gap-acceptance factor; diversity only changes how they are sampled.
- `Simulation::set_link_travel_time` / `Router::set_link_travel_time` feed measured travel times
  into routing for new vehicles (re-routing of vehicles en route comes with Phase 5).

### Known limitations

- Lane changes are instantaneous in the model (the snapshot interpolates laterally for display);
  lane choice looks one link ahead only.
- Conflict areas are reduced to one conflict point per connector pair; claims block whole
  movements until that point is cleared.
- Vehicles whose destination becomes unreachable from their lane re-route to the nearest exit.
