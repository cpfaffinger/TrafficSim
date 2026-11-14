import type { Polyline, Vec3 } from './types';

/** Polyline helpers in package ENU coordinates. Offsets are horizontal; positive = right of the driving direction. */

const EPS = 1e-9;
const MAX_MITER = 4;

/** Cumulative 3D distance at each vertex (first entry 0). */
export function cumulativeLengths(line: Polyline): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    out.push(out[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return out;
}

export function polylineLength(line: Polyline): number {
  return cumulativeLengths(line).at(-1) ?? 0;
}

/** Horizontal unit direction of segment i (falls back to +east for degenerate segments). */
function segmentDir(line: Polyline, i: number): [number, number] {
  const a = line[i]!;
  const b = line[i + 1]!;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  return l < EPS ? [1, 0] : [dx / l, dy / l];
}

/** Right-hand unit normal of a horizontal direction. */
export function rightNormal(dir: readonly [number, number]): [number, number] {
  return [dir[1], -dir[0]];
}

/** Lifts every vertex by `dz` metres. */
export function lift(line: readonly Vec3[], dz: number): Vec3[] {
  return line.map((p) => [p[0], p[1], p[2] + dz]);
}

/**
 * Offsets a polyline horizontally by `distance` (positive = right), either one distance for all
 * vertices or one per vertex (tapering ribbons). Interior vertices use mitred normals (bisector scaled
 * by 1/cos, clamped) so parallel offsets stay parallel through bends.
 */
export function offsetPolyline(line: Polyline, distance: number | readonly number[]): Vec3[] {
  const n = line.length;
  const at = (i: number) => (typeof distance === 'number' ? distance : (distance[i] ?? 0));
  if (n < 2) return line.map((p) => [p[0], p[1], p[2]]);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = line[i]!;
    let nx: number;
    let ny: number;
    if (i === 0) [nx, ny] = rightNormal(segmentDir(line, 0));
    else if (i === n - 1) [nx, ny] = rightNormal(segmentDir(line, n - 2));
    else {
      const [ax, ay] = rightNormal(segmentDir(line, i - 1));
      const [bx, by] = rightNormal(segmentDir(line, i));
      const mx = ax + bx;
      const my = ay + by;
      const ml = Math.hypot(mx, my);
      if (ml < EPS) [nx, ny] = [ax, ay];
      else {
        const cos = (mx / ml) * ax + (my / ml) * ay;
        const scale = Math.min(MAX_MITER, 1 / Math.max(cos, EPS));
        nx = (mx / ml) * scale;
        ny = (my / ml) * scale;
      }
    }
    const d = at(i);
    out.push([p[0] + nx * d, p[1] + ny * d, p[2]]);
  }
  return out;
}

export interface Station {
  point: Vec3;
  /** Horizontal unit tangent. */
  dir: [number, number];
}

/** Point and tangent at distance `s` along the line (clamped to its ends). */
export function stationAt(line: Polyline, s: number, cumulative = cumulativeLengths(line)): Station {
  const total = cumulative.at(-1) ?? 0;
  const t = Math.min(Math.max(s, 0), total);
  let i = 0;
  while (i < line.length - 2 && cumulative[i + 1]! < t) i++;
  const a = line[i]!;
  const b = line[i + 1]!;
  const segLen = cumulative[i + 1]! - cumulative[i]!;
  const f = segLen < EPS ? 0 : (t - cumulative[i]!) / segLen;
  return {
    point: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f],
    dir: segmentDir(line, i),
  };
}

/** Sub-polyline between distances `from` and `to` (clamped; empty if the range is empty). */
export function slicePolyline(line: Polyline, from: number, to: number, cumulative = cumulativeLengths(line)): Vec3[] {
  const total = cumulative.at(-1) ?? 0;
  const a = Math.max(0, from);
  const b = Math.min(total, to);
  if (b - a < EPS) return [];
  const out: Vec3[] = [stationAt(line, a, cumulative).point];
  for (let i = 1; i < line.length - 1; i++) {
    const c = cumulative[i]!;
    const p = line[i]!;
    if (c > a + EPS && c < b - EPS) out.push([p[0], p[1], p[2]]);
  }
  out.push(stationAt(line, b, cumulative).point);
  return out;
}

/**
 * Dash intervals `[start, end]` along a line of `length` metres. The pattern starts with a dash at
 * `phase` (metres into the first period) and ends cleanly at the line end.
 */
export function dashIntervals(length: number, dash: number, gap: number, phase = 0): [number, number][] {
  if (length <= 0) return [];
  if (gap <= 0) return [[0, length]];
  const period = dash + gap;
  const out: [number, number][] = [];
  let start = -(((phase % period) + period) % period);
  for (; start < length; start += period) {
    const a = Math.max(0, start);
    const b = Math.min(length, start + dash);
    if (b - a > 1e-6) out.push([a, b]);
  }
  return out;
}

/** Keeps the intervals before `solidFrom` and makes everything from there to `length` continuous (solid). */
export function withSolidTail(intervals: [number, number][], length: number, solidFrom: number): [number, number][] {
  if (solidFrom >= length) return intervals;
  const cut = Math.max(0, solidFrom);
  const out = intervals.filter(([, b]) => b <= cut).map(([a, b]) => [a, b] as [number, number]);
  const straddling = intervals.find(([a, b]) => a < cut && b > cut);
  if (straddling) out.push([straddling[0], cut]);
  out.push([cut, length]);
  return mergeIntervals(out);
}

function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** 2D convex hull (monotone chain), counter-clockwise, without collinear points. */
export function convexHull(points: readonly (readonly [number, number])[]): [number, number][] {
  const pts = [...points].map((p) => [p[0], p[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Squared horizontal distance from point p to segment ab. */
export function distanceToSegmentSq(p: readonly [number, number], a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < EPS ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const x = a[0] + dx * t - p[0];
  const y = a[1] + dy * t - p[1];
  return x * x + y * y;
}
