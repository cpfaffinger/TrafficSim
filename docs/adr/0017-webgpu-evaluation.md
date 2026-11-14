# ADR-0017: Stay on WebGL2, prepare for Three.js WebGPURenderer

- Status: Accepted
- Date: 2026-11-14

## Context

Issue #83 asks whether the renderer should move to WebGPU for large scenarios (10k+ vehicles,
city-scale networks, heatmap overlays). Three.js ships a `WebGPURenderer` (with automatic WebGL2
fallback) and the node-based TSL material system; WebGPU is available in Chromium-based browsers and
Safari, Firefox support is still rolling out.

Our rendering load is dominated by:

- **Vehicles:** one `InstancedMesh` per vehicle class, updated per frame from the worker snapshot
  (a few hundred KB per frame at 10k vehicles) — bound by upload bandwidth, not draw calls.
- **Static network geometry:** merged lane, marking and structure meshes — a handful of draw calls.
- **Heatmaps:** per-lane-cell colours updated every bucket (seconds), not every frame.

## Decision

- Keep the **WebGL2 renderer** as the default. All scene code stays renderer-agnostic: no raw GL calls,
  standard materials or `ShaderMaterial` only where unavoidable, instanced attributes for vehicle
  state, data textures for heatmaps.
- Re-evaluate WebGPU when one of these holds: (a) vehicle counts exceed ~50k on target hardware,
  (b) we move vehicle interpolation or heatmap smoothing into compute shaders, (c) Firefox ships
  WebGPU by default. The switch is then `WebGPURenderer` with WebGL2 fallback behind a feature flag.
- Performance budgets (#78) are measured on WebGL2; LOD and culling (#80) and SharedArrayBuffer
  snapshots (#79) deliver the scaling we need first.

## Consequences

- No second rendering path to maintain now; the upgrade path stays open because Three.js abstracts it.
- Compute-shader ideas (GPU vehicle interpolation, screen-space density blur) are deferred.

## Alternatives considered

- Switch now to `WebGPURenderer`: little gain for an upload-bound workload, extra browser-specific
  risk, and TSL would require rewriting the custom marking/structure materials.
- Raw WebGPU without Three.js: far more code for the same result.
