import { ShapeUtils, Vector2 } from 'three';
import { MeshData } from '../network/meshData';
import type { BasemapKind, BasemapPolygon } from './decode';

/**
 * Ground layers below the road surface (ENU z). Each kind gets its own height so overlapping
 * polygons of different kinds never z-fight; roads sit at z ≥ 0.
 */
export const GROUND_LEVEL: Record<Exclude<BasemapKind, 'building'>, number> = {
  landuse: -0.22,
  park: -0.18,
  water: -0.14,
};

export type BasemapMeshes = Record<BasemapKind, MeshData>;

/** Triangulates ground polygons and extrudes buildings into one merged mesh per kind. */
export function buildBasemapMeshes(polygons: readonly BasemapPolygon[]): BasemapMeshes {
  const out: BasemapMeshes = { water: new MeshData(), park: new MeshData(), landuse: new MeshData(), building: new MeshData() };
  for (const p of polygons) {
    if (p.kind === 'building') extrude(out.building, p);
    else flat(out[p.kind], p.rings, GROUND_LEVEL[p.kind]);
  }
  return out;
}

/** Triangle indices into the concatenated rings (outer first, then holes). */
/**
 * Triangles of a polygon with holes (indices into the rings' vertices in order). Generalised tiles at
 * low zoom contain holes that touch their outer ring; earcut then bridges them with long horizontal
 * slivers (stripes across the map, #130). When the triangles do not cover the polygon's area, the
 * outer ring alone is used: a hole drawn filled is far less visible than a stripe.
 */
export function triangulate(rings: readonly (readonly [number, number])[][]): number[][] {
  const [outer, ...holes] = rings.map((r) => r.map(([x, y]) => new Vector2(x, y)));
  if (!outer || outer.length < 3) return [];
  if (holes.length === 0) return ShapeUtils.triangulateShape(outer, []);
  const tris = ShapeUtils.triangulateShape(outer, holes);
  const points = [outer, ...holes].flat();
  const covered = tris.reduce((sum, [a, b, c]) => sum + Math.abs(ShapeUtils.area([points[a!]!, points[b!]!, points[c!]!])), 0);
  const expected = Math.abs(ShapeUtils.area(outer)) - holes.reduce((sum, h) => sum + Math.abs(ShapeUtils.area(h)), 0);
  if (expected > 0 && Math.abs(covered - expected) <= 0.01 * expected) return tris;
  return ShapeUtils.triangulateShape(outer, []);
}

function flat(mesh: MeshData, rings: [number, number][][], z: number): void {
  const tris = triangulate(rings);
  if (tris.length === 0) return;
  const base = mesh.vertexCount;
  for (const ring of rings) for (const [x, y] of ring) mesh.vertex([x, y, z]);
  for (const [a, b, c] of tris) mesh.triangle(base + a!, base + b!, base + c!);
}

function extrude(mesh: MeshData, p: BasemapPolygon): void {
  const top = p.height ?? 10;
  const bottom = Math.min(p.minHeight ?? 0, top - 0.5);
  flat(mesh, p.rings, top);
  for (const ring of p.rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[(i + 1) % ring.length]!;
      mesh.fan([
        [ax, ay, bottom],
        [bx, by, bottom],
        [bx, by, top],
        [ax, ay, top],
      ]);
    }
  }
}
