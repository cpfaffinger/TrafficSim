import { isTunnel, isTunnelConnector, laneEdges, type BuildContext } from './buildContext';
import type { MeshData } from './meshData';
import { convexHull, cumulativeLengths, lift, offsetPolyline } from './polyline';
import type { Connector, Vec3 } from './types';

/** Junction patches sit slightly below connector ribbons so a raycast prefers the movement. */
export const JUNCTION_PATCH_DROP = 0.02;

export interface SurfaceTargets {
  surface: MeshData;
  tunnelSurface: MeshData;
}

/**
 * Road surfaces (#35): one ribbon per lane from its centreline and width, one tapering ribbon per
 * connector (from-lane width → to-lane width) and a convex junction patch per node with movements.
 */
export function buildRoadSurfaces(ctx: BuildContext, out: SurfaceTargets): void {
  for (const link of ctx.pkg.links) {
    const mesh = isTunnel(link) ? out.tunnelSurface : out.surface;
    for (const lane of link.lanes) {
      mesh.setOwner(ctx.registry.register({ kind: 'lane', linkId: link.id, laneIndex: lane.index }));
      const { left, right } = laneEdges(lane);
      mesh.strip(left, right);
    }
  }

  for (const c of ctx.pkg.connectors) {
    const mesh = isTunnelConnector(ctx, c) ? out.tunnelSurface : out.surface;
    mesh.setOwner(ctx.registry.register({ kind: 'connector', connectorId: c.id }));
    const { left, right } = connectorEdges(ctx, c);
    mesh.strip(left, right);
  }

  for (const [nodeId, connectors] of ctx.connectorsByNode) {
    const patch = junctionPatch(ctx, connectors);
    if (!patch) continue;
    const mesh = connectors.every((c) => isTunnelConnector(ctx, c)) ? out.tunnelSurface : out.surface;
    mesh.setOwner(ctx.registry.register({ kind: 'node', nodeId }));
    mesh.fan(patch);
  }

  out.surface.setOwner(-1);
  out.tunnelSurface.setOwner(-1);
}

function laneWidth(ctx: BuildContext, linkId: string, index: number): number {
  return ctx.links.get(linkId)?.lanes[index]?.width ?? 3;
}

/** Edges of a connector ribbon whose width tapers linearly from the incoming to the outgoing lane. */
export function connectorEdges(ctx: BuildContext, c: Connector): { left: Vec3[]; right: Vec3[] } {
  const w0 = laneWidth(ctx, c.fromLink, c.fromLane);
  const w1 = laneWidth(ctx, c.toLink, c.toLane);
  const cum = cumulativeLengths(c.geometry);
  const total = cum.at(-1) || 1;
  const half = cum.map((s) => (w0 + (w1 - w0) * (s / total)) / 2);
  return { left: offsetPolyline(c.geometry, half.map((h) => -h)), right: offsetPolyline(c.geometry, half) };
}

/** Convex hull of the lane edge points where movements enter and leave the node. */
export function junctionPatch(ctx: BuildContext, connectors: readonly Connector[]): Vec3[] | null {
  const pts: Vec3[] = [];
  for (const c of connectors) {
    const { left, right } = connectorEdges(ctx, c);
    pts.push(left[0]!, right[0]!, left.at(-1)!, right.at(-1)!);
  }
  const hull = convexHull(pts.map((p) => [p[0], p[1]] as const));
  if (hull.length < 3) return null;
  const z = pts.reduce((sum, p) => sum + p[2], 0) / pts.length - JUNCTION_PATCH_DROP;
  return lift(
    hull.map(([x, y]) => [x, y, 0] as Vec3),
    z,
  );
}
