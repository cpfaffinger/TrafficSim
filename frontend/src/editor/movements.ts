import type { PackageIndex } from '../network/inspect';
import type { ConnectorTurn, Link, Polyline } from '../network/types';
import { EditError, type Changeset, type EditResult, type SetLaneConnectionsOp } from './ops';

/**
 * Movements at a junction for the lane connector editor (#66). A movement is keyed by stable OSM ids
 * (ADR-0010): junction node, the incoming link's `osmBeforeTo` and the outgoing link's `osmAfterFrom`.
 */
export interface MovementKey {
  nodeId: number;
  fromNeighbour: number;
  toNeighbour: number;
}

export const keyString = (k: MovementKey) => `${k.nodeId}:${k.fromNeighbour}:${k.toNeighbour}`;

export interface Movement {
  /** `fromLink>toLink` (compiled ids, valid within one package). */
  id: string;
  fromLink: Link;
  toLink: Link;
  key: MovementKey | null;
  turn: ConnectorTurn;
  /** Lane pairs `[fromLane, toLane]` currently connected (from the package). */
  connections: [number, number][];
  banned: boolean;
  /** The changeset overrides this movement's lane connections. */
  overridden: boolean;
}

/** Lane-graph overrides in effect after applying the changeset (mirrors the backend's replay order). */
export interface MovementOverrides {
  banned: Set<string>;
  connections: Map<string, Map<number, number[]>>;
}

export function changesetOverrides(changeset: Changeset): MovementOverrides {
  const banned = new Set<string>();
  const connections = new Map<string, Map<number, number[]>>();
  for (const op of changeset) {
    if (op.op === 'ban_movement') {
      const k = keyString(op);
      banned.add(k);
      connections.delete(k);
    } else if (op.op === 'set_lane_connections') {
      const k = keyString(op);
      banned.delete(k);
      const map = connections.get(k) ?? new Map<number, number[]>();
      map.set(op.fromLane, [...new Set(op.toLanes)].sort((a, b) => a - b));
      connections.set(k, map);
    }
  }
  return { banned, connections };
}

function direction(line: Polyline, atEnd: boolean): [number, number] {
  const [a, b] = atEnd ? [line.at(-2)!, line.at(-1)!] : [line[0]!, line[1]!];
  return [b[0] - a[0], b[1] - a[1]];
}

/** Signed angle in degrees from the approach to the exit direction (+ = left turn). */
export function turnAngle(incoming: Link, outgoing: Link): number {
  const [ax, ay] = direction(incoming.geometry, true);
  const [bx, by] = direction(outgoing.geometry, false);
  return (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI;
}

/** Same thresholds as the compiler's turn classification. */
export function classifyTurn(angle: number): ConnectorTurn {
  const a = Math.abs(angle);
  const left = angle > 0;
  if (a <= 20) return 'through';
  if (a <= 45) return left ? 'slight_left' : 'slight_right';
  if (a <= 135) return left ? 'left' : 'right';
  if (a <= 170) return left ? 'sharp_left' : 'sharp_right';
  return 'reverse';
}

export function movementKey(index: PackageIndex, nodeId: string, from: Link, to: Link): MovementKey | null {
  const osm = index.nodes.get(nodeId)?.osmId ?? null;
  const a = from.osmBeforeTo ?? null;
  const b = to.osmAfterFrom ?? null;
  return osm === null || a === null || b === null ? null : { nodeId: osm, fromNeighbour: a, toNeighbour: b };
}

/** All movements the compiler would consider at the node (U-turns only at dead ends), incl. banned ones. */
export function junctionMovements(index: PackageIndex, nodeId: string, changeset: Changeset): Movement[] {
  const overrides = changesetOverrides(changeset);
  const incoming = index.pkg.links.filter((l) => l.to === nodeId);
  const outgoing = index.pkg.links.filter((l) => l.from === nodeId);
  const connectors = index.pkg.connectors.filter((c) => c.node === nodeId);
  const result: Movement[] = [];
  for (const from of incoming) {
    const candidates = outgoing.filter((o) => o.id !== from.oppositeLink);
    const targets = candidates.length ? candidates : outgoing;
    const angled = targets.map((to) => ({ to, angle: turnAngle(from, to) })).sort((a, b) => a.angle - b.angle);
    for (const { to, angle } of angled) {
      const own = connectors.filter((c) => c.fromLink === from.id && c.toLink === to.id);
      const key = movementKey(index, nodeId, from, to);
      const k = key ? keyString(key) : null;
      result.push({
        id: `${from.id}>${to.id}`,
        fromLink: from,
        toLink: to,
        key,
        turn: own[0]?.turn ?? classifyTurn(angle),
        connections: own.map((c) => [c.fromLane, c.toLane] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
        banned: k !== null && overrides.banned.has(k),
        overridden: k !== null && overrides.connections.has(k),
      });
    }
  }
  return result;
}

function requireKey(m: Movement): MovementKey {
  if (!m.key) throw new EditError('This movement lacks OpenStreetMap node ids and cannot be edited.');
  return m.key;
}

const turnWords = (m: Movement) => m.turn.replace(/_/g, ' ');

/**
 * Sets the outgoing lanes of every incoming lane of the movement. The backend replaces the whole
 * movement's mapping once any lane is overridden, so all lanes are written.
 */
export function setMovementLanes(m: Movement, lanes: ReadonlyMap<number, readonly number[]>, label: string): EditResult {
  const key = requireKey(m);
  const ops: SetLaneConnectionsOp[] = m.fromLink.lanes.map((lane) => ({
    op: 'set_lane_connections',
    nodeId: key.nodeId,
    fromNeighbour: key.fromNeighbour,
    fromLane: lane.index,
    toNeighbour: key.toNeighbour,
    toLanes: [...new Set(lanes.get(lane.index) ?? [])].filter((t) => t >= 0 && t < m.toLink.lanes.length).sort((a, b) => a - b),
  }));
  return { label, ops };
}

export function connectionMap(m: Movement): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const [from, to] of m.connections) map.set(from, [...(map.get(from) ?? []), to]);
  return map;
}

/** Connects or disconnects one lane pair of the movement. */
export function toggleConnection(m: Movement, fromLane: number, toLane: number): EditResult {
  if (!m.fromLink.lanes[fromLane] || !m.toLink.lanes[toLane]) throw new EditError('Lane does not exist.');
  const map = connectionMap(m);
  const current = map.get(fromLane) ?? [];
  const connected = current.includes(toLane);
  map.set(fromLane, connected ? current.filter((t) => t !== toLane) : [...current, toLane]);
  const verb = connected ? 'Disconnect' : 'Connect';
  return setMovementLanes(m, map, `${verb} lane ${fromLane} → lane ${toLane} (${turnWords(m)})`);
}

export function banMovement(m: Movement): EditResult {
  const key = requireKey(m);
  return { label: `Ban ${turnWords(m)} turn`, ops: [{ op: 'ban_movement', ...key }] };
}

/** Removes the ban and/or lane connection edits of one movement from the changeset (back to compiler defaults). */
export function withoutMovementEdits(changeset: Changeset, m: Movement, which: 'ban' | 'all'): Changeset {
  const key = requireKey(m);
  const k = keyString(key);
  return changeset.filter((op) => {
    if (op.op === 'ban_movement') return keyString(op) !== k;
    if (op.op === 'set_lane_connections') return which === 'ban' || keyString(op) !== k;
    return true;
  });
}

const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'] as const;

/** Compass direction of an ENU vector. */
export function compass(dx: number, dy: number): string {
  const i = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return COMPASS[(i + 8) % 8]!;
}

/** "from W (Main St)" / "to N": which arm of the junction a link is, seen from the junction. */
export function armLabel(link: Link, incoming: boolean): string {
  const [dx, dy] = direction(link.geometry, incoming);
  const side = incoming ? compass(-dx, -dy) : compass(dx, dy);
  return `${incoming ? 'from' : 'to'} ${side}${link.name ? ` (${link.name})` : ''}`;
}
