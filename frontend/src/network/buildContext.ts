import { PickRegistry } from './meshData';
import { offsetPolyline } from './polyline';
import type { Connector, Lane, Link, NetworkNode, NetworkPackage, Vec3 } from './types';

/** Lookup tables shared by the mesh generators of one package. */
export interface BuildContext {
  pkg: NetworkPackage;
  registry: PickRegistry;
  links: Map<string, Link>;
  nodes: Map<string, NetworkNode>;
  connectorsByNode: Map<string, Connector[]>;
  connectorsByFromLink: Map<string, Connector[]>;
}

export function createBuildContext(pkg: NetworkPackage, registry = new PickRegistry()): BuildContext {
  const group = (key: (c: Connector) => string) => {
    const map = new Map<string, Connector[]>();
    for (const c of pkg.connectors) {
      const k = key(c);
      const list = map.get(k);
      if (list) list.push(c);
      else map.set(k, [c]);
    }
    return map;
  };
  return {
    pkg,
    registry,
    links: new Map(pkg.links.map((l) => [l.id, l])),
    nodes: new Map(pkg.nodes.map((n) => [n.id, n])),
    connectorsByNode: group((c) => c.node),
    connectorsByFromLink: group((c) => c.fromLink),
  };
}

/** Tunnels are drawn in their own (ghosted, optionally hidden) layer. */
export function isTunnel(link: Link): boolean {
  return link.structure === 'tunnel';
}

export function isTunnelConnector(ctx: BuildContext, c: Connector): boolean {
  const from = ctx.links.get(c.fromLink);
  const to = ctx.links.get(c.toLink);
  return !!from && !!to && isTunnel(from) && isTunnel(to);
}

export interface LaneEdges {
  left: Vec3[];
  right: Vec3[];
}

export function laneEdges(lane: Lane): LaneEdges {
  return { left: offsetPolyline(lane.geometry, -lane.width / 2), right: offsetPolyline(lane.geometry, lane.width / 2) };
}

/** Right edge of lane 0 and left edge of the leftmost lane: the carriageway outline of a link. */
export function linkEdges(link: Link): LaneEdges {
  const right = link.lanes[0]!;
  const left = link.lanes.at(-1)!;
  return { left: offsetPolyline(left.geometry, -left.width / 2), right: offsetPolyline(right.geometry, right.width / 2) };
}

/** Total carriageway width of a link. */
export function linkWidth(link: Link): number {
  return link.lanes.reduce((sum, l) => sum + l.width, 0);
}

/** Max elevation (ENU z) of a polyline. */
export function maxZ(line: readonly Vec3[]): number {
  return line.reduce((m, p) => Math.max(m, p[2]), -Infinity);
}
