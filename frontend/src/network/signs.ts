import { rightNormal } from './polyline';
import type { NetworkPackage, Vec3 } from './types';

export type SignKind = 'stop' | 'give_way' | 'priority_road' | 'signal';

/** A sign post at the right kerb of an approach, facing oncoming traffic. */
export interface SignPlacement {
  kind: SignKind;
  linkId: string;
  /** Foot of the post (ENU). */
  base: Vec3;
  /** Travel direction of the approach (radians, counter-clockwise from east). */
  heading: number;
}

export const SIGN_KERB_CLEARANCE = 0.8;

/**
 * Sign posts for every approach with an `endSign`, plus a signal mast for every signalised approach
 * (#103). Placed at the end of the rightmost lane, beside the kerb.
 */
export function signPlacements(pkg: NetworkPackage): SignPlacement[] {
  const signalised = new Set(pkg.connectors.filter((c) => c.priority === 'signal').map((c) => c.fromLink));
  const result: SignPlacement[] = [];
  for (const link of pkg.links) {
    const kind: SignKind | null = signalised.has(link.id) ? 'signal' : link.endSign && link.endSign !== 'none' ? link.endSign : null;
    if (!kind) continue;
    const lane = link.lanes.find((l) => l.index === 0) ?? link.lanes[0];
    const g = lane?.geometry;
    if (!lane || !g || g.length < 2) continue;
    const a = g[g.length - 2]!;
    const b = g[g.length - 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const dir: [number, number] = [dx / len, dy / len];
    const [nx, ny] = rightNormal(dir);
    const off = lane.width / 2 + SIGN_KERB_CLEARANCE;
    result.push({ kind, linkId: link.id, base: [b[0] + nx * off, b[1] + ny * off, b[2]], heading: Math.atan2(dir[1], dir[0]) });
  }
  return result;
}
