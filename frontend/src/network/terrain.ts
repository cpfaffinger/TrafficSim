import { MeshData } from './meshData';
import type { TerrainGrid } from './types';

/**
 * Terrain helpers (#87, ADR-0018): bilinear heights like the backend's `TerrainGrid`, a height-field
 * mesh and draping of flat meshes (basemap) onto the terrain. Renderer-agnostic, scene coordinates.
 */

/** Height (m, relative to the origin's ground) at an ENU position; outside the grid the edge is used. */
export function terrainHeightAt(t: TerrainGrid, east: number, north: number): number {
  const fx = Math.min(Math.max((east - t.west) / t.cellSize, 0), t.columns - 1);
  const fy = Math.min(Math.max((north - t.south) / t.cellSize, 0), t.rows - 1);
  const c = Math.min(Math.floor(fx), t.columns - 2);
  const r = Math.min(Math.floor(fy), t.rows - 2);
  const tx = fx - c;
  const ty = fy - r;
  const h = (row: number, col: number) => t.heights[row * t.columns + col]!;
  const south = h(r, c) * (1 - tx) + h(r, c + 1) * tx;
  const north2 = h(r + 1, c) * (1 - tx) + h(r + 1, c + 1) * tx;
  return south * (1 - ty) + north2 * ty;
}

/** Lowest and highest height of the grid. */
export function terrainRange(t: TerrainGrid): [min: number, max: number] {
  let min = Infinity;
  let max = -Infinity;
  for (const h of t.heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return [min, max];
}

/**
 * Height-field mesh of the grid, `offset` metres below the terrain (roads and draped basemap stay on
 * top). Grids larger than `maxSide` samples per side are decimated to keep the vertex count sane.
 */
export function buildTerrainMesh(t: TerrainGrid, offset = 1, maxSide = 257): MeshData {
  const mesh = new MeshData();
  const step = Math.max(1, Math.ceil(Math.max(t.columns, t.rows) / maxSide));
  const cols: number[] = [];
  const rows: number[] = [];
  for (let c = 0; c < t.columns; c += step) cols.push(c);
  if (cols.at(-1) !== t.columns - 1) cols.push(t.columns - 1);
  for (let r = 0; r < t.rows; r += step) rows.push(r);
  if (rows.at(-1) !== t.rows - 1) rows.push(t.rows - 1);
  for (const r of rows) {
    for (const c of cols) {
      mesh.vertex([t.west + c * t.cellSize, t.south + r * t.cellSize, t.heights[r * t.columns + c]! - offset]);
    }
  }
  const n = cols.length;
  for (let i = 0; i < rows.length - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      // Counter-clockwise seen from above (scene y up): south-west, south-east, north-east, north-west.
      mesh.quad(a, a + 1, a + n + 1, a + n);
    }
  }
  return mesh;
}

/** Lifts every vertex of a mesh (scene coordinates) by the terrain height under it. */
export function drapeOnTerrain(mesh: MeshData, t: TerrainGrid): void {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    // Scene x = east, z = −north.
    p[i + 1] = p[i + 1]! + terrainHeightAt(t, p[i]!, -p[i + 2]!);
  }
}
