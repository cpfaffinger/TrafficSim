import { isTunnel, type BuildContext } from './buildContext';
import type { MeshData } from './meshData';
import {
  cumulativeLengths,
  dashIntervals,
  lift,
  offsetPolyline,
  rightNormal,
  slicePolyline,
  stationAt,
  withSolidTail,
} from './polyline';
import type { BoundaryMarking, LaneTurn, Link, Polyline, RoadClass, Vec3 } from './types';

/** Road markings (#95), generated from the same boundaries the simulation obeys (ADR-0016). */

export const MARKING_LIFT = 0.03;
export const LINE_WIDTH = 0.12;
export const EDGE_LINE_WIDTH = 0.15;
/** Half the centre-to-centre distance of the two lines of a double or asymmetric marking. */
export const DOUBLE_HALF_GAP = 0.12;
export const EDGE_INSET = 0.25;
export const STOP_LINE_WIDTH = 0.4;

export type LineKind = 'solid' | 'dashed';

export interface DashPattern {
  dash: number;
  gap: number;
}

const FAST_ROADS: ReadonlySet<RoadClass> = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const EDGE_LINE_ROADS: ReadonlySet<RoadClass> = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
]);

/** Lane-line dash pattern: long dashes on motorways and trunk roads, short ones elsewhere. */
export function dashPattern(roadClass: RoadClass): DashPattern {
  return FAST_ROADS.has(roadClass) ? { dash: 6, gap: 12 } : { dash: 3, gap: 6 };
}

export interface LineComponent {
  /** Lateral offset from the boundary (positive = right of the driving direction). */
  offset: number;
  kind: LineKind;
}

/** The painted lines of a lane boundary marking; asymmetric markings put the solid line on the restricted side. */
export function boundaryComponents(marking: BoundaryMarking): LineComponent[] {
  const g = DOUBLE_HALF_GAP;
  switch (marking) {
    case 'dashed':
      return [{ offset: 0, kind: 'dashed' }];
    case 'solid':
      return [{ offset: 0, kind: 'solid' }];
    case 'double_solid':
      return [
        { offset: -g, kind: 'solid' },
        { offset: g, kind: 'solid' },
      ];
    case 'solid_dashed': // solid on the left: only the right lane may cross
      return [
        { offset: -g, kind: 'solid' },
        { offset: g, kind: 'dashed' },
      ];
    case 'dashed_solid': // dashed on the left: only the left lane may cross
      return [
        { offset: -g, kind: 'dashed' },
        { offset: g, kind: 'solid' },
      ];
  }
}

/** Painted intervals along a line, with dashes turned solid inside the no-lane-change zone at the end. */
export function lineIntervals(kind: LineKind, length: number, pattern: DashPattern, solidZone = 0): [number, number][] {
  if (kind === 'solid') return length > 0 ? [[0, length]] : [];
  const dashes = dashIntervals(length, pattern.dash, pattern.gap);
  return solidZone > 0 ? withSolidTail(dashes, length, length - solidZone) : dashes;
}

/** Paints a line of `width` along `base` (offset laterally by `offset`) over the given intervals. */
export function paintLine(
  mesh: MeshData,
  base: Polyline,
  offset: number,
  width: number,
  intervals: (length: number) => [number, number][],
): void {
  const line = offsetPolyline(base, offset);
  const cum = cumulativeLengths(line);
  for (const [a, b] of intervals(cum.at(-1) ?? 0)) {
    const piece = slicePolyline(line, a, b, cum);
    if (piece.length < 2) continue;
    mesh.strip(lift(offsetPolyline(piece, -width / 2), MARKING_LIFT), lift(offsetPolyline(piece, width / 2), MARKING_LIFT));
  }
}

export interface MarkingTargets {
  markings: MeshData;
  tunnelMarkings: MeshData;
}

export function buildMarkings(ctx: BuildContext, out: MarkingTargets): void {
  for (const link of ctx.pkg.links) {
    const mesh = isTunnel(link) ? out.tunnelMarkings : out.markings;
    mesh.setOwner(-1);
    laneBoundaries(link, mesh);
    leftEdgeLine(ctx, link, mesh);
    if (EDGE_LINE_ROADS.has(link.roadClass)) rightEdgeLine(link, mesh);
    stopLine(ctx, link, mesh);
    turnArrows(link, mesh);
  }
}

function laneBoundaries(link: Link, mesh: MeshData): void {
  const pattern = dashPattern(link.roadClass);
  for (const b of link.boundaries) {
    const lane = link.lanes[b.rightLane];
    if (!lane) continue;
    const edge = offsetPolyline(lane.geometry, -lane.width / 2);
    for (const c of boundaryComponents(b.marking)) {
      paintLine(mesh, edge, c.offset, LINE_WIDTH, (len) => lineIntervals(c.kind, len, pattern, link.noLaneChangeZone));
    }
  }
}

/** Centre line of a two-way road. Identical halves are drawn once; differing halves each draw their own side. */
export function centreLinePlan(link: Link, opposite: Link | undefined): LineComponent[] {
  const own: LineKind | 'double' | null =
    link.leftEdge === 'centre_dashed' ? 'dashed' : link.leftEdge === 'centre_solid' ? 'solid' : link.leftEdge === 'double_solid' ? 'double' : null;
  if (own === null) return [];
  if (opposite && opposite.leftEdge === link.leftEdge) {
    if (link.id > opposite.id) return []; // the other direction draws the shared line
    return own === 'double'
      ? [
          { offset: -DOUBLE_HALF_GAP, kind: 'solid' },
          { offset: DOUBLE_HALF_GAP, kind: 'solid' },
        ]
      : [{ offset: 0, kind: own }];
  }
  // Asymmetric centre (e.g. solid on one side, dashed on the other): draw only this direction's half.
  return [{ offset: DOUBLE_HALF_GAP, kind: own === 'double' ? 'solid' : own }];
}

function leftEdgeLine(ctx: BuildContext, link: Link, mesh: MeshData): void {
  const lane = link.lanes.at(-1)!;
  const edge = offsetPolyline(lane.geometry, -lane.width / 2);
  if (link.leftEdge === 'edge') {
    paintLine(mesh, edge, EDGE_INSET, EDGE_LINE_WIDTH, (len) => [[0, len]]);
    return;
  }
  const opposite = link.oppositeLink ? ctx.links.get(link.oppositeLink) : undefined;
  const pattern = dashPattern(link.roadClass);
  for (const c of centreLinePlan(link, opposite)) {
    paintLine(mesh, edge, c.offset, LINE_WIDTH, (len) => lineIntervals(c.kind, len, pattern));
  }
}

function rightEdgeLine(link: Link, mesh: MeshData): void {
  const lane = link.lanes[0]!;
  const edge = offsetPolyline(lane.geometry, lane.width / 2);
  paintLine(mesh, edge, -EDGE_INSET, EDGE_LINE_WIDTH, (len) => [[0, len]]);
}

export type StopLineKind = 'stop' | 'give_way';

/** Stop line (signals, stop signs, all-way stops, level crossings) or give-way line at the link end. */
export function stopLineKind(ctx: BuildContext, link: Link): StopLineKind | null {
  const priorities = new Set((ctx.connectorsByFromLink.get(link.id) ?? []).map((c) => c.priority));
  const control = ctx.nodes.get(link.to)?.control;
  if (priorities.has('signal') || priorities.has('stop')) return 'stop';
  if (control === 'all_way_stop' || control === 'level_crossing') return 'stop';
  if (priorities.size === 0 && control === 'signal') return 'stop';
  if (priorities.has('minor') || priorities.has('roundabout_entry')) return 'give_way';
  return null;
}

function stopLine(ctx: BuildContext, link: Link, mesh: MeshData): void {
  const kind = stopLineKind(ctx, link);
  if (!kind) return;
  for (const lane of link.lanes) {
    const cum = cumulativeLengths(lane.geometry);
    const len = cum.at(-1) ?? 0;
    const s = Math.max(len / 2, len - 1 - STOP_LINE_WIDTH / 2);
    const { point, dir } = stationAt(lane.geometry, s, cum);
    const across: [number, number][] = kind === 'stop' ? [[0, lane.width]] : dashIntervals(lane.width, 0.5, 0.3, 0);
    const [rx, ry] = rightNormal(dir);
    const h = STOP_LINE_WIDTH / 2;
    for (const [a, b] of across) {
      // Lateral positions measured from the left lane edge towards the right.
      const la = -lane.width / 2 + a;
      const lb = -lane.width / 2 + b;
      const at = (lat: number, lon: number): Vec3 => [
        point[0] + rx * lat + dir[0] * lon,
        point[1] + ry * lat + dir[1] * lon,
        point[2] + MARKING_LIFT,
      ];
      mesh.fan([at(la, -h), at(lb, -h), at(lb, h), at(la, h)]);
    }
  }
}

// ---- Turn arrows ----

const TURN_ANGLE: Record<Exclude<LaneTurn, 'reverse'>, number> = {
  through: 0,
  slight_left: 45,
  left: 90,
  sharp_left: 135,
  slight_right: -45,
  right: -90,
  sharp_right: -135,
  merge_to_left: 25,
  merge_to_right: -25,
};

const SHAFT_WIDTH = 0.15;
const SHAFT_LENGTH = 3;
const BRANCH_LENGTH = 1.1;
const HEAD_WIDTH = 0.6;
const HEAD_LENGTH = 0.9;

type P2 = [number, number];
/** A triangle in arrow-local coordinates: u forward, v left, metres. */
export type Tri2 = [P2, P2, P2];

function bar(from: P2, angleDeg: number, length: number, out: Tri2[]): P2 {
  const a = (angleDeg * Math.PI) / 180;
  const d: P2 = [Math.cos(a), Math.sin(a)];
  const n: P2 = [-d[1] * (SHAFT_WIDTH / 2), d[0] * (SHAFT_WIDTH / 2)];
  const to: P2 = [from[0] + d[0] * length, from[1] + d[1] * length];
  const p1: P2 = [from[0] + n[0], from[1] + n[1]];
  const p2: P2 = [from[0] - n[0], from[1] - n[1]];
  const p3: P2 = [to[0] - n[0], to[1] - n[1]];
  const p4: P2 = [to[0] + n[0], to[1] + n[1]];
  out.push([p1, p2, p3], [p1, p3, p4]);
  return to;
}

function head(tip: P2, angleDeg: number, out: Tri2[]): void {
  const a = (angleDeg * Math.PI) / 180;
  const d: P2 = [Math.cos(a), Math.sin(a)];
  const n: P2 = [-d[1] * (HEAD_WIDTH / 2), d[0] * (HEAD_WIDTH / 2)];
  out.push([
    [tip[0] + n[0], tip[1] + n[1]],
    [tip[0] - n[0], tip[1] - n[1]],
    [tip[0] + d[0] * HEAD_LENGTH, tip[1] + d[1] * HEAD_LENGTH],
  ]);
}

/**
 * Arrow triangles for a lane's turn set: a shared shaft ending at the origin (u ≤ 0) and one branch +
 * head per turn. Returns an empty list for unmarked lanes.
 */
export function arrowTriangles(turns: readonly LaneTurn[]): Tri2[] {
  if (turns.length === 0) return [];
  const out: Tri2[] = [];
  bar([-SHAFT_LENGTH, 0], 0, SHAFT_LENGTH, out);
  for (const turn of new Set(turns)) {
    if (turn === 'reverse') {
      const corner = bar([0, 0], 90, 0.8, out);
      head(bar(corner, 180, BRANCH_LENGTH, out), 180, out);
      continue;
    }
    const angle = TURN_ANGLE[turn];
    head(bar([0, 0], angle, BRANCH_LENGTH, out), angle, out);
  }
  return out;
}

/** Distances from the lane start at which arrows are painted (one near the end, a second on long lanes). */
export function arrowStations(length: number): number[] {
  if (length < 16) return [];
  return length > 60 ? [length - 40, length - 10] : [length - 10];
}

function turnArrows(link: Link, mesh: MeshData): void {
  for (const lane of link.lanes) {
    const tris = arrowTriangles(lane.turns);
    if (tris.length === 0) continue;
    const cum = cumulativeLengths(lane.geometry);
    const scale = Math.min(1, lane.width / 3);
    for (const s of arrowStations(cum.at(-1) ?? 0)) {
      const { point, dir } = stationAt(lane.geometry, s, cum);
      const left: P2 = [-dir[1], dir[0]];
      const at = ([u, v]: P2): Vec3 => [
        point[0] + (dir[0] * u + left[0] * v) * scale,
        point[1] + (dir[1] * u + left[1] * v) * scale,
        point[2] + MARKING_LIFT,
      ];
      for (const [a, b, c] of tris) mesh.fan([at(a), at(b), at(c)]);
    }
  }
}
