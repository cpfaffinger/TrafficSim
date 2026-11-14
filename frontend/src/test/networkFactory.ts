// Test support: small hand-made network packages.
import type { Boundary, Connector, LaneTurn, Link, NetworkNode, NetworkPackage, NodeControl, Vec3 } from '../network/types';

export interface StraightLinkOptions {
  lanes?: number;
  width?: number;
  z?: number;
  structure?: Link['structure'];
  layer?: number;
  oppositeLink?: string | null;
  roadClass?: Link['roadClass'];
  leftEdge?: Link['leftEdge'];
  turns?: LaneTurn[][];
  boundaries?: Boundary[];
  noLaneChangeZone?: number;
  /** A two-way road's lanes start at the reference line; a one-way road is centred on it. */
  twoWay?: boolean;
}

export function straightLink(id: string, from: string, to: string, a: [number, number], b: [number, number], o: StraightLinkOptions = {}): Link {
  const lanes = o.lanes ?? 1;
  const w = o.width ?? 3;
  const z = o.z ?? 0;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const [rx, ry] = [dy / len, -dx / len];
  const centre = o.twoWay ? 0 : -(lanes * w) / 2;
  const geometry: Vec3[] = [
    [a[0], a[1], z],
    [b[0], b[1], z],
  ];
  return {
    id,
    osmWayId: null,
    from,
    to,
    roadClass: o.roadClass ?? 'residential',
    name: null,
    layer: o.layer ?? 0,
    structure: o.structure ?? 'none',
    roundabout: false,
    oppositeLink: o.oppositeLink ?? null,
    throughTraffic: true,
    length: len,
    speedLimit: 13.89,
    geometry,
    lanes: Array.from({ length: lanes }, (_, i) => {
      const off = centre + (lanes - 1 - i + 0.5) * w;
      return {
        id: `${id}:${i}`,
        index: i,
        width: w,
        speedLimit: 13.89,
        allowed: ['car' as const],
        turns: o.turns?.[i] ?? [],
        geometry: [
          [a[0] + rx * off, a[1] + ry * off, z],
          [b[0] + rx * off, b[1] + ry * off, z],
        ] as Vec3[],
        length: len,
      };
    }),
    boundaries:
      o.boundaries ??
      Array.from({ length: lanes - 1 }, (_, i) => ({ rightLane: i, leftLane: i + 1, marking: 'dashed' as const, allowLeft: true, allowRight: true })),
    leftEdge: o.leftEdge ?? 'edge',
    noLaneChangeZone: o.noLaneChangeZone ?? 0,
    assumed: [],
  };
}

export function node(id: string, x: number, y: number, control: NodeControl = 'none', z = 0): NetworkNode {
  return { id, osmId: null, x, y, z, control };
}

export function connector(id: string, nodeId: string, from: Link, to: Link, priority: Connector['priority'] = 'major'): Connector {
  const a = from.lanes[0]!.geometry.at(-1)!;
  const b = to.lanes[0]!.geometry[0]!;
  return {
    id,
    node: nodeId,
    fromLink: from.id,
    fromLane: 0,
    toLink: to.id,
    toLane: 0,
    turn: 'through',
    priority,
    signalGroup: null,
    geometry: [a, b],
    length: Math.hypot(b[0] - a[0], b[1] - a[1]),
    conflicts: [],
  };
}

export function packageOf(nodes: NetworkNode[], links: Link[], connectors: Connector[] = []): NetworkPackage {
  return {
    formatVersion: 1,
    baselineId: null,
    origin: { lat: 48.2, lon: 16.37 },
    bbox: [16.36, 48.19, 16.38, 48.21],
    osmTimestamp: null,
    attribution: ['© OpenStreetMap contributors (ODbL)'],
    nodes,
    links,
    connectors,
    signals: [],
    stats: { nodes: nodes.length, links: links.length, lanes: links.reduce((s, l) => s + l.lanes.length, 0), connectors: connectors.length, signals: 0 },
  };
}
