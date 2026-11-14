import type { PackageIndex } from '../network/inspect';
import type { Link } from '../network/types';
import type { Movement } from './movements';

/**
 * Schematic top view of one junction for the lane connector editor (#66): approach stubs, a dot per
 * lane end and a curve per lane connection, in SVG coordinates (y down) fitted into a square.
 */
export interface DiagramPoint {
  x: number;
  y: number;
}

export interface DiagramLane extends DiagramPoint {
  linkId: string;
  laneIndex: number;
}

export interface DiagramArm {
  linkId: string;
  incoming: boolean;
  from: DiagramPoint;
  to: DiagramPoint;
  width: number;
}

export interface DiagramConnection {
  movementId: string;
  fromLink: string;
  fromLane: number;
  toLink: string;
  toLane: number;
  d: string;
}

export interface JunctionDiagram {
  size: number;
  centre: DiagramPoint;
  arms: DiagramArm[];
  incoming: DiagramLane[];
  outgoing: DiagramLane[];
  connections: DiagramConnection[];
}

const STUB_METRES = 25;

function unit(dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

export function junctionDiagram(index: PackageIndex, nodeId: string, movements: readonly Movement[], size = 240, margin = 14): JunctionDiagram {
  const node = index.nodes.get(nodeId);
  const cx = node?.x ?? 0;
  const cy = node?.y ?? 0;
  const incomingLinks = index.pkg.links.filter((l) => l.to === nodeId);
  const outgoingLinks = index.pkg.links.filter((l) => l.from === nodeId);

  const raw: { arms: { link: Link; incoming: boolean; a: [number, number]; b: [number, number] }[]; lanes: { link: Link; incoming: boolean; i: number; p: [number, number] }[] } = {
    arms: [],
    lanes: [],
  };
  for (const [links, incoming] of [
    [incomingLinks, true],
    [outgoingLinks, false],
  ] as const) {
    for (const link of links) {
      const g = link.geometry;
      const end = incoming ? g.at(-1)! : g[0]!;
      const next = incoming ? g.at(-2)! : g[1]!;
      const [ux, uy] = unit(next[0] - end[0], next[1] - end[1]);
      raw.arms.push({ link, incoming, a: [end[0] - cx, end[1] - cy], b: [end[0] - cx + ux * STUB_METRES, end[1] - cy + uy * STUB_METRES] });
      for (const lane of link.lanes) {
        const p = incoming ? lane.geometry.at(-1)! : lane.geometry[0]!;
        raw.lanes.push({ link, incoming, i: lane.index, p: [p[0] - cx, p[1] - cy] });
      }
    }
  }

  const extent = Math.max(10, ...raw.arms.flatMap((a) => [Math.abs(a.b[0]), Math.abs(a.b[1])]), ...raw.lanes.map((l) => Math.max(Math.abs(l.p[0]), Math.abs(l.p[1]))));
  const scale = (size / 2 - margin) / extent;
  const half = size / 2;
  const toSvg = ([x, y]: readonly [number, number]): DiagramPoint => ({ x: round(half + x * scale), y: round(half - y * scale) });

  const lanePoint = new Map<string, DiagramLane>();
  const incoming: DiagramLane[] = [];
  const outgoing: DiagramLane[] = [];
  for (const l of raw.lanes) {
    const lane: DiagramLane = { linkId: l.link.id, laneIndex: l.i, ...toSvg(l.p) };
    lanePoint.set(`${l.incoming ? 'in' : 'out'}:${l.link.id}:${l.i}`, lane);
    (l.incoming ? incoming : outgoing).push(lane);
  }

  const centre = { x: half, y: half };
  const connections: DiagramConnection[] = [];
  for (const m of movements) {
    for (const [fromLane, toLane] of m.connections) {
      const a = lanePoint.get(`in:${m.fromLink.id}:${fromLane}`);
      const b = lanePoint.get(`out:${m.toLink.id}:${toLane}`);
      if (!a || !b) continue;
      connections.push({
        movementId: m.id,
        fromLink: m.fromLink.id,
        fromLane,
        toLink: m.toLink.id,
        toLane,
        d: `M ${a.x} ${a.y} Q ${centre.x} ${centre.y} ${b.x} ${b.y}`,
      });
    }
  }

  return {
    size,
    centre,
    arms: raw.arms.map((a) => ({
      linkId: a.link.id,
      incoming: a.incoming,
      from: toSvg(a.a),
      to: toSvg(a.b),
      width: round(Math.max(2, a.link.lanes.reduce((s, l) => s + l.width, 0) * scale)),
    })),
    incoming,
    outgoing,
    connections,
  };
}

const round = (v: number) => Math.round(v * 10) / 10;
