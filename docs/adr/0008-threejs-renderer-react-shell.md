# ADR-0008: Three.js renderer with a React UI shell

- Status: Accepted
- Date: 2026-11-14

## Context

We need a 3D scene with road meshes, thousands of moving vehicles, heatmap overlays and editing tools
(picking lanes, dragging nodes), plus conventional UI (panels, forms, timelines).

## Decision

- **Three.js** (WebGL2 renderer; WebGPU renderer optional later) renders the scene, written as plain
  imperative TypeScript modules under `frontend/src/scene`. Vehicles use `InstancedMesh`; heatmaps use
  per-instance attributes and custom shaders.
- **React** (Vite build) renders only the UI shell: panels, toolbars, dialogs, scenario forms. React never
  re-renders per simulation frame; it subscribes to throttled summaries.
- The basemap (OpenFreeMap vector tiles) is rendered into ground textures in a later phase; the scene uses
  local metric coordinates (ADR-0011).

## Consequences

- Scene modules are testable without React; UI is testable without WebGL.
- No react-three-fiber: avoids reconciliation overhead and keeps the hot path explicit.

## Alternatives considered

- Babylon.js: more built-ins (gizmos, inspector), smaller ecosystem, heavier bundle.
- MapLibre + deck.gl: excellent geo heatmaps, but a city-builder-style lane editor is much harder.
