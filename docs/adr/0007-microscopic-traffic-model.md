# ADR-0007: Microscopic traffic model — IDM + MOBIL, fixed step, deterministic

- Status: Accepted
- Date: 2026-11-14

## Context

We want emergent phenomena (stop-and-go waves, tailbacks, platoons, capacity drop) from individual
behaviour, plus heterogeneity (vehicle types, attentiveness, reaction times).

## Decision

- **Car following:** Intelligent Driver Model (Treiber, Hennecke, Helbing 2000):
  `a = a_max · [1 − (v/v0)^δ − (s*/s)²]` with `s* = s0 + max(0, v·T + v·Δv / (2·√(a_max·b)))`.
- **Reaction time:** each driver perceives leader gap/speed with a personal delay (0.3–1.5 s) via a
  history ring buffer; distracted drivers additionally get random perception lapses.
- **Lane changes:** MOBIL (politeness `p`, threshold `Δa_th`, safe braking `b_safe`), keep-right bias on
  motorways, mandatory changes for route following with distance-based urgency. A change takes a finite
  duration (default 3 s, shorter at low speed) during which the vehicle occupies source and target lane;
  it is reversed if a conflict appears in its first half (#108).
- **Junctions:** conflict zones between lane connectors; gap acceptance for priority / yield / stop;
  fixed-time signal plans first, actuated control later.
- **Integration:** fixed time step `Δt = 0.1 s` (configurable), ballistic position update, speeds clamped at ≥ 0.
- **Determinism:** a seeded PCG32 PRNG owned by each simulation; stable iteration order; single-threaded
  core per run (no parallel floating-point reductions).
- **Units:** SI internally (m, s, m/s, m/s²).

## Consequences

- Deterministic regression tests ("golden runs") are possible.
- IDM is collision-free for sane parameters; tests still assert explicitly that no overlap occurs.
- Parameter sets per vehicle type / driver profile are data, not code.

## Alternatives considered

- Gipps / Krauss (SUMO default): simpler, but IDM gives smoother, well-documented dynamics.
- Cellular automata (Nagel–Schreckenberg): fast, but not lane-geometry accurate.
