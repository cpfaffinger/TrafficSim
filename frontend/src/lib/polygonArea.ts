import { LocalTangentPlane } from '../network/geo';
import type { BBox } from '../network/types';

/** Polygon import areas (#110): rings are `[lon, lat][]`, open (first vertex not repeated). */
export type LonLat = readonly [lon: number, lat: number];
export type Ring = readonly LonLat[];

export const MAX_RING_VERTICES = 500;

export function ringBounds(ring: Ring): BBox {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Area in km² (shoelace in a local tangent plane around the centre of the bounds). */
export function ringAreaKm2(ring: Ring): number {
  if (ring.length < 3) return 0;
  const b = ringBounds(ring);
  const plane = new LocalTangentPlane({ lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 });
  const local = ring.map(([lon, lat]) => plane.toLocal(lon, lat));
  let sum = 0;
  for (let i = 0; i < local.length; i++) {
    const a = local[i]!;
    const c = local[(i + 1) % local.length]!;
    sum += a[0] * c[1] - c[0] * a[1];
  }
  return Math.abs(sum) / 2 / 1e6;
}

function orient(p: LonLat, q: LonLat, r: LonLat): number {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

function segmentsCross(a: LonLat, b: LonLat, c: LonLat, d: LonLat): boolean {
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

/** True when two non-adjacent edges of the closed ring cross. */
export function ringSelfIntersects(ring: Ring): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j - i <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

/** Why a ring cannot be imported, or null when it is valid. */
export function ringProblem(ring: Ring): string | null {
  if (ring.length < 3) return 'Add at least three corners.';
  if (ring.length > MAX_RING_VERTICES) return `Use at most ${MAX_RING_VERTICES} corners.`;
  if (ringSelfIntersects(ring)) return 'The outline must not cross itself.';
  if (ringAreaKm2(ring) < 0.01) return 'The area is too small.';
  return null;
}

/** Rounds to ~0.1 m (6 decimals) so equal shapes produce identical requests. */
export function roundRing(ring: Ring): LonLat[] {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return ring.map(([lon, lat]) => [r(lon), r(lat)] as const);
}

/** True when an area value is a polygon ring rather than a `[w, s, e, n]` box. */
export function isRing(area: BBox | Ring): area is Ring {
  return area.length > 0 && Array.isArray(area[0]);
}
