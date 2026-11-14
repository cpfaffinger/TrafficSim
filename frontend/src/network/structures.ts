import { isTunnel, linkEdges, linkWidth, maxZ, type BuildContext } from './buildContext';
import type { MeshData } from './meshData';
import { cumulativeLengths, distanceToSegmentSq, lift, offsetPolyline, stationAt } from './polyline';
import type { Link, Vec3 } from './types';

/**
 * Bridges, embankments and tunnel portals (#96). Geometry `z` is the schematic elevation from the
 * package (6 m per layer, ADR-0016); there is no terrain, the ground is z = 0.
 */

export const ELEVATED_THRESHOLD = 0.5;
export const DECK_THICKNESS = 0.9;
export const PARAPET_HEIGHT = 1.0;
export const PARAPET_WIDTH = 0.3;
export const PIER_SPACING = 30;
export const PIER_LENGTH = 1.2;
export const PIER_CLEARANCE = 0.75;
export const PORTAL_HEIGHT = 5.5;
export const PORTAL_THICKNESS = 0.8;

/** Lane centreline segments near the ground, bucketed in a uniform grid, to keep piers off roads below. */
export class ObstacleGrid {
  private readonly cells = new Map<string, { a: Vec3; b: Vec3; halfWidth: number }[]>();

  constructor(private readonly cellSize = 25) {}

  add(a: Vec3, b: Vec3, halfWidth: number): void {
    const [x0, x1] = [Math.min(a[0], b[0]) - halfWidth, Math.max(a[0], b[0]) + halfWidth];
    const [y0, y1] = [Math.min(a[1], b[1]) - halfWidth, Math.max(a[1], b[1]) + halfWidth];
    for (let i = Math.floor(x0 / this.cellSize); i <= Math.floor(x1 / this.cellSize); i++) {
      for (let j = Math.floor(y0 / this.cellSize); j <= Math.floor(y1 / this.cellSize); j++) {
        const key = `${i},${j}`;
        const list = this.cells.get(key);
        const item = { a, b, halfWidth };
        if (list) list.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  /** True if a disc of `radius` around p overlaps any registered carriageway. */
  blocked(p: readonly [number, number], radius: number): boolean {
    const key = `${Math.floor(p[0] / this.cellSize)},${Math.floor(p[1] / this.cellSize)}`;
    return (this.cells.get(key) ?? []).some(({ a, b, halfWidth }) => {
      const r = halfWidth + radius;
      return distanceToSegmentSq(p, a, b) < r * r;
    });
  }
}

export function buildStructures(ctx: BuildContext, structures: MeshData): void {
  const ground = groundObstacles(ctx);
  for (const link of ctx.pkg.links) {
    if (isTunnel(link)) continue;
    if (maxZ(link.geometry) <= ELEVATED_THRESHOLD) continue;
    structures.setOwner(ctx.registry.register({ kind: 'link', linkId: link.id }));
    if (link.structure === 'bridge') {
      bridgeDeck(link, structures);
      for (const pier of pierPlacements(link, ground)) {
        structures.box(pier.a, pier.b, pier.width, 0, pier.top);
      }
    } else {
      embankment(link, structures);
    }
  }
  tunnelPortals(ctx, structures);
  structures.setOwner(-1);
}

function groundObstacles(ctx: BuildContext): ObstacleGrid {
  const grid = new ObstacleGrid();
  for (const link of ctx.pkg.links) {
    for (const lane of link.lanes) {
      const g = lane.geometry;
      for (let i = 1; i < g.length; i++) {
        if (Math.min(g[i - 1]![2], g[i]![2]) < ELEVATED_THRESHOLD * 4) grid.add(g[i - 1]!, g[i]!, lane.width / 2);
      }
    }
  }
  return grid;
}

function bridgeDeck(link: Link, mesh: MeshData): void {
  const { left, right } = linkEdges(link);
  const leftBottom = lift(left, -DECK_THICKNESS);
  const rightBottom = lift(right, -DECK_THICKNESS);
  mesh.strip(rightBottom, leftBottom); // underside
  mesh.strip(right, rightBottom);
  mesh.strip(left, leftBottom);
  parapet(right, -PARAPET_WIDTH, mesh); // inward = left of the right edge
  // A two-way bridge's other direction adjoins the left edge; only one-way decks get a left parapet.
  if (link.oppositeLink === null) parapet(left, PARAPET_WIDTH, mesh);
}

function parapet(edge: Vec3[], inward: number, mesh: MeshData): void {
  const inner = offsetPolyline(edge, inward);
  const outerTop = lift(edge, PARAPET_HEIGHT);
  const innerTop = lift(inner, PARAPET_HEIGHT);
  mesh.strip(edge, outerTop);
  mesh.strip(inner, innerTop);
  mesh.strip(outerTop, innerTop);
}

/** Retaining walls from elevated non-bridge links (ramps) down to the ground. */
function embankment(link: Link, mesh: MeshData): void {
  const { left, right } = linkEdges(link);
  const toGround = (line: Vec3[]) => line.map((p) => [p[0], p[1], 0] as Vec3);
  mesh.strip(right, toGround(right));
  if (link.oppositeLink === null) mesh.strip(left, toGround(left));
}

export interface PierPlacement {
  a: [number, number];
  b: [number, number];
  width: number;
  top: number;
}

/** Piers every PIER_SPACING metres under a bridge deck, skipping positions above lower carriageways. */
export function pierPlacements(link: Link, obstacles: ObstacleGrid): PierPlacement[] {
  const right = link.lanes[0]!;
  const left = link.lanes.at(-1)!;
  const cum = cumulativeLengths(link.geometry);
  const length = cum.at(-1) ?? 0;
  const width = linkWidth(link) * 0.6;
  const out: PierPlacement[] = [];
  const count = Math.max(1, Math.floor(length / PIER_SPACING));
  const step = length / count;
  for (let k = 0; k < count; k++) {
    const s = step * (k + 0.5);
    const { dir } = stationAt(link.geometry, s, cum);
    const f = length > 0 ? s / length : 0;
    const pr = stationAt(right.geometry, f * right.length).point;
    const pl = stationAt(left.geometry, f * left.length).point;
    const centre: [number, number] = [(pr[0] + pl[0]) / 2, (pr[1] + pl[1]) / 2];
    const top = (pr[2] + pl[2]) / 2 - DECK_THICKNESS;
    if (top < 1.5) continue;
    if (obstacles.blocked(centre, Math.max(width, PIER_LENGTH) / 2 + PIER_CLEARANCE)) continue;
    const h = PIER_LENGTH / 2;
    out.push({
      a: [centre[0] - dir[0] * h, centre[1] - dir[1] * h],
      b: [centre[0] + dir[0] * h, centre[1] + dir[1] * h],
      width,
      top,
    });
  }
  return out;
}

/** Portal frames where a tunnel link meets a link that is not in a tunnel. */
function tunnelPortals(ctx: BuildContext, mesh: MeshData): void {
  const openNodes = new Set<string>();
  for (const l of ctx.pkg.links) {
    if (!isTunnel(l)) openNodes.add(l.from).add(l.to);
  }
  for (const link of ctx.pkg.links) {
    if (!isTunnel(link)) continue;
    mesh.setOwner(ctx.registry.register({ kind: 'link', linkId: link.id }));
    if (openNodes.has(link.from)) portal(link, false, mesh);
    if (openNodes.has(link.to)) portal(link, true, mesh);
  }
}

/** The two post positions of a portal at the start or end of a tunnel link, and the link direction there. */
export function portalFrame(link: Link, atEnd: boolean): { posts: [Vec3, Vec3]; dir: [number, number] } {
  const { left, right } = linkEdges(link);
  const pick = (line: Vec3[]) => (atEnd ? line.at(-1)! : line[0]!);
  const r = pick(right);
  const l = pick(left);
  const { dir } = stationAt(link.geometry, atEnd ? Infinity : 0);
  const margin = 0.6;
  // Push the posts outwards by `margin` along the cross direction.
  const cx = l[0] - r[0];
  const cy = l[1] - r[1];
  const cl = Math.hypot(cx, cy) || 1;
  return {
    posts: [
      [r[0] - (cx / cl) * margin, r[1] - (cy / cl) * margin, r[2]],
      [l[0] + (cx / cl) * margin, l[1] + (cy / cl) * margin, l[2]],
    ],
    dir,
  };
}

function portal(link: Link, atEnd: boolean, mesh: MeshData): void {
  const { posts, dir } = portalFrame(link, atEnd);
  const h = PORTAL_THICKNESS / 2;
  const base = Math.min(posts[0][2], posts[1][2]);
  for (const p of posts) {
    mesh.box([p[0] - dir[0] * h, p[1] - dir[1] * h], [p[0] + dir[0] * h, p[1] + dir[1] * h], PORTAL_THICKNESS, base, base + PORTAL_HEIGHT);
  }
  mesh.box([posts[0][0], posts[0][1]], [posts[1][0], posts[1][1]], PORTAL_THICKNESS, base + PORTAL_HEIGHT - 1, base + PORTAL_HEIGHT);
}
