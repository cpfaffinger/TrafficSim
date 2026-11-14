import type { NetworkPackage } from '../network/types';
import type { Zone } from './model';

export type Point = readonly [number, number];

/** Map geometry of a zone in package ENU metres. */
export interface ZoneShape {
  id: string;
  /** Polylines of the zone's links. */
  links: Point[][];
  /** Positions of the zone's nodes (e.g. boundary nodes of `ext`). */
  nodes: Point[];
  /** Convex hull of all points (outline); fewer than 3 points for degenerate zones. */
  hull: Point[];
  /** Marker position (mean of the points), null when nothing resolves. */
  center: Point | null;
  /** Referenced ids missing from the package. */
  missing: string[];
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise, without duplicate points. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (list: Point[]) => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

export function zoneShapes(zones: readonly Zone[], pkg: NetworkPackage): ZoneShape[] {
  const links = new Map(pkg.links.map((l) => [l.id, l]));
  const nodes = new Map(pkg.nodes.map((n) => [n.id, n]));
  return zones.map((z) => {
    const missing: string[] = [];
    const lines: Point[][] = [];
    for (const id of z.links) {
      const l = links.get(id);
      if (l) lines.push(l.geometry.map((p) => [p[0], p[1]] as const));
      else missing.push(id);
    }
    const nodePoints: Point[] = [];
    for (const id of z.nodes) {
      const n = nodes.get(id);
      if (n) nodePoints.push([n.x, n.y]);
      else missing.push(id);
    }
    const all = [...lines.flat(), ...nodePoints];
    const center: Point | null = all.length
      ? [all.reduce((a, p) => a + p[0], 0) / all.length, all.reduce((a, p) => a + p[1], 0) / all.length]
      : null;
    return { id: z.id, links: lines, nodes: nodePoints, hull: convexHull(all), center, missing };
  });
}

/** Zones containing a link (directly, or through one of its end nodes). */
export function zonesAt(zones: readonly Zone[], target: { linkId?: string; nodeIds?: readonly string[] }): string[] {
  return zones
    .filter((z) => (target.linkId !== undefined && z.links.includes(target.linkId)) || (target.nodeIds ?? []).some((n) => z.nodes.includes(n)))
    .map((z) => z.id);
}
