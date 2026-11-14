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

/**
 * Splits the triangles of a mesh (scene coordinates) until no edge is longer than `maxEdge`
 * horizontally, so a draped surface follows the terrain instead of spanning it with large flat
 * triangles that float above roads on convex slopes. Vertices are not shared in the result.
 */
export function subdivide(mesh: MeshData, maxEdge: number): MeshData {
  type P = [number, number, number];
  const out = new MeshData();
  const p = mesh.positions;
  const at = (i: number): P => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
  const len2 = (a: P, b: P) => (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2;
  const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const max2 = maxEdge * maxEdge;
  const stack: [P, P, P, number][] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    stack.push([at(mesh.indices[t]!), at(mesh.indices[t + 1]!), at(mesh.indices[t + 2]!), 0]);
    while (stack.length > 0) {
      const [a, b, c, depth] = stack.pop()!;
      const [ab, bc, ca] = [len2(a, b), len2(b, c), len2(c, a)];
      const longest = Math.max(ab, bc, ca);
      if (longest <= max2 || depth >= 12) {
        const i = out.vertexCount;
        out.positions.push(...a, ...b, ...c);
        out.triangle(i, i + 1, i + 2);
      } else if (longest === ab) {
        const d = mid(a, b);
        stack.push([a, d, c, depth + 1], [d, b, c, depth + 1]);
      } else if (longest === bc) {
        const d = mid(b, c);
        stack.push([a, b, d, depth + 1], [a, d, c, depth + 1]);
      } else {
        const d = mid(c, a);
        stack.push([a, b, d, depth + 1], [d, b, c, depth + 1]);
      }
    }
  }
  return out;
}
