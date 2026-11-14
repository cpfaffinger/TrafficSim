import { LocalTangentPlane } from '../network/geo';
import type { PackageIndex } from '../network/inspect';
import type { Link, RoadClass } from '../network/types';
import { structureTags, type EditableStructure } from './linkEdits';
import { EditError, IdAllocator, type Changeset, type EditOperation, type EditResult, type WayNodeRef } from './ops';
import { wayDirection } from './wayContext';

/**
 * Drawing new roads (#69): clicked ground points are snapped to existing junctions or attached to
 * existing roads (`insert_node`), then written as one `add_way` with client-chosen negative ids.
 */
export type DraftPoint =
  | { kind: 'node'; osmId: number; nodeId: string; x: number; y: number }
  | { kind: 'insert'; wayId: number; afterNode: number; linkId: string; x: number; y: number }
  | { kind: 'free'; x: number; y: number };

export interface RoadSpec {
  highway: RoadClass;
  /** Lanes per direction. */
  lanes: number;
  oneway: boolean;
  /** km/h; null = default for the class. */
  maxspeed: number | null;
  structure: EditableStructure;
  layer: number;
  name: string;
}

export const DEFAULT_ROAD: RoadSpec = { highway: 'residential', lanes: 1, oneway: false, maxspeed: null, structure: 'none', layer: 0, name: '' };

/** Road classes offered for new roads. */
export const NEW_ROAD_CLASSES: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'motorway_link', 'primary_link'];

export const SNAP_NODE_METRES = 10;
const ATTACH_EXTRA_METRES = 2;

type XY = readonly [number, number];

/** Nearest point on segment ab to p, with the parameter t ∈ [0, 1]. */
export function projectOnSegment(p: XY, a: XY, b: XY): { x: number; y: number; t: number; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const x = a[0] + dx * t;
  const y = a[1] + dy * t;
  return { x, y, t, distance: Math.hypot(p[0] - x, p[1] - y) };
}

/**
 * OSM node after which a point on segment `segment` of the link is inserted (way order), or null if
 * unknown. Only the first and last segment of a link have known OSM nodes on both ends.
 */
export function insertAfterNode(index: PackageIndex, link: Link, segment: number): number | null {
  const last = link.geometry.length - 2;
  const fromOsm = index.nodes.get(link.from)?.osmId ?? null;
  const toOsm = index.nodes.get(link.to)?.osmId ?? null;
  let pair: [number | null, number | null];
  if (segment === 0) pair = [fromOsm, link.osmAfterFrom ?? (last === 0 ? toOsm : null)];
  else if (segment === last) pair = [link.osmBeforeTo ?? null, toOsm];
  else return null;
  return wayDirection(index, link) === 'backward' ? pair[1] : pair[0];
}

/** Attach via the link's OSM nodes (#105): the clicked OSM segment, `afterNode` in way order. */
function attachViaOsmNodes(index: PackageIndex, link: Link, p: XY): (DraftPoint & { kind: 'insert' }) | null {
  const nodes = link.osmNodes;
  if (link.osmWayId === null || !nodes || nodes.length < 2) return null;
  let best: { k: number; x: number; y: number; distance: number } | null = null;
  for (let k = 0; k < nodes.length - 1; k++) {
    const a = nodes[k]!;
    const b = nodes[k + 1]!;
    if (a.id === null || b.id === null) continue;
    const pr = projectOnSegment(p, [a.x, a.y], [b.x, b.y]);
    if (!best || pr.distance < best.distance) best = { k, ...pr };
  }
  if (!best) return null;
  const forward = link.osmForward ?? wayDirection(index, link) !== 'backward';
  const afterNode = forward ? nodes[best.k]!.id! : nodes[best.k + 1]!.id!;
  return { kind: 'insert', wayId: link.osmWayId, afterNode, linkId: link.id, x: best.x, y: best.y };
}

function attachToLink(index: PackageIndex, link: Link, p: XY): (DraftPoint & { kind: 'insert' }) | null {
  if (link.osmWayId === null) return null;
  if (link.osmNodes && link.osmNodes.length >= 2) return attachViaOsmNodes(index, link, p);
  const g = link.geometry;
  const last = g.length - 2;
  // Middle segments have no known OSM nodes: use the nearest addressable (first or last) segment.
  const segments = last === 0 ? [0] : [0, last];
  let best: { seg: number; x: number; y: number; distance: number } | null = null;
  for (const seg of segments) {
    const pr = projectOnSegment(p, [g[seg]![0], g[seg]![1]], [g[seg + 1]![0], g[seg + 1]![1]]);
    if (!best || pr.distance < best.distance) best = { seg, ...pr };
  }
  const afterNode = best ? insertAfterNode(index, link, best.seg) : null;
  if (!best || afterNode === null) return null;
  return { kind: 'insert', wayId: link.osmWayId, afterNode, linkId: link.id, x: best.x, y: best.y };
}

function distanceToLink(link: Link, p: XY): number {
  let d = Infinity;
  for (let i = 0; i < link.geometry.length - 1; i++) {
    const a = link.geometry[i]!;
    const b = link.geometry[i + 1]!;
    d = Math.min(d, projectOnSegment(p, [a[0], a[1]], [b[0], b[1]]).distance);
  }
  return d;
}

/** Interprets a click at ENU `p`: snap to a nearby junction, attach to a road under it, or a free point. */
export function snapPoint(index: PackageIndex, p: XY, snapRadius = SNAP_NODE_METRES): DraftPoint {
  let node: { osmId: number; nodeId: string; x: number; y: number; d: number } | null = null;
  for (const n of index.pkg.nodes) {
    if (n.osmId === null) continue;
    const d = Math.hypot(n.x - p[0], n.y - p[1]);
    if (d <= snapRadius && (!node || d < node.d)) node = { osmId: n.osmId, nodeId: n.id, x: n.x, y: n.y, d };
  }
  if (node) return { kind: 'node', osmId: node.osmId, nodeId: node.nodeId, x: node.x, y: node.y };

  let hit: { link: Link; d: number } | null = null;
  for (const link of index.pkg.links) {
    const half = link.lanes.reduce((s, l) => s + l.width, 0) * (link.oppositeLink ? 1 : 0.5) + ATTACH_EXTRA_METRES;
    const d = distanceToLink(link, p);
    if (d <= half && (!hit || d < hit.d)) hit = { link, d };
  }
  const attached = hit ? attachToLink(index, hit.link, p) : null;
  return attached ?? { kind: 'free', x: p[0], y: p[1] };
}

/** Adds a point to the draft; repeated clicks on the same spot are ignored. */
export function addDraftPoint(points: readonly DraftPoint[], point: DraftPoint): DraftPoint[] {
  const last = points.at(-1);
  if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.5) return [...points];
  return [...points, point];
}

export function roadTags(spec: RoadSpec): Record<string, string> {
  if (!Number.isInteger(spec.lanes) || spec.lanes < 1 || spec.lanes > 4) throw new EditError('A new road has 1–4 lanes per direction.');
  if (spec.maxspeed !== null && (!Number.isInteger(spec.maxspeed) || spec.maxspeed < 5 || spec.maxspeed > 200)) {
    throw new EditError('Speed limit must be a whole number between 5 and 200 km/h.');
  }
  const tags: Record<string, string> = { highway: spec.highway, lanes: String(spec.oneway ? spec.lanes : spec.lanes * 2) };
  if (spec.oneway) tags.oneway = 'yes';
  else tags['lanes:forward'] = tags['lanes:backward'] = String(spec.lanes);
  if (spec.maxspeed !== null) tags.maxspeed = String(spec.maxspeed);
  for (const [k, v] of Object.entries(structureTags(spec.structure, spec.layer))) if (v !== null) tags[k] = v;
  if (spec.name.trim()) tags.name = spec.name.trim();
  return tags;
}

const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

/** Builds the edits for a drawn road: attach points first, then the new way. */
export function buildRoad(index: PackageIndex, points: readonly DraftPoint[], spec: RoadSpec, changeset: Changeset): EditResult {
  if (points.length < 2) throw new EditError('Click at least two points to draw a road.');
  const tags = roadTags(spec);
  const ids = new IdAllocator(changeset);
  const plane = new LocalTangentPlane(index.pkg.origin);
  const ops: EditOperation[] = [];
  const nodes: WayNodeRef[] = [];
  for (const p of points) {
    if (p.kind === 'node') {
      nodes.push({ id: p.osmId });
      continue;
    }
    const [lon, lat] = plane.toGeo(p.x, p.y);
    const id = ids.take();
    if (p.kind === 'insert') {
      ops.push({ op: 'insert_node', wayId: p.wayId, afterNode: p.afterNode, nodeId: id, lat: round7(lat), lon: round7(lon) });
      nodes.push({ id });
    } else {
      nodes.push({ id, lat: round7(lat), lon: round7(lon) });
    }
  }
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length && !(nodes.length > 3 && nodes[0]!.id === nodes.at(-1)!.id)) {
    throw new EditError('A road cannot pass the same junction twice.');
  }
  ops.push({ op: 'add_way', wayId: ids.take(), nodes, tags });
  const name = spec.name.trim() ? ` “${spec.name.trim()}”` : '';
  return { label: `New ${spec.highway.replace(/_/g, ' ')} road${name}`, ops };
}
