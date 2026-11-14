import type { PackageIndex } from '../network/inspect';
import type { Link } from '../network/types';
import { EditError, splitsWay, type Changeset, type RemoveWayOp, type SetWayTagsOp, type TagChanges } from './ops';

/**
 * Relates compiled links back to the OSM way they came from, so UI actions can be written as tag
 * changes (ADR-0010).
 *
 * Direction: a two-way way compiles into a forward link (in way node order) and a backward link; the
 * package says which via `osmForward`; older packages fall back to the compiler emitting the forward link first. A one-way link uses the direction-free keys (`lanes`,
 * `turn:lanes`, …), which the compiler reads for `oneway=yes` and `oneway=-1` alike.
 */
export type WayDirection = 'forward' | 'backward' | 'oneway';

/** Which part of the way an edit applies to: the selected link's part or the whole way. */
export type EditScope = 'part' | 'way';

/** A way or the part of it between two of its OSM nodes (null = way start/end). */
export interface WayPart {
  wayId: number;
  fromNode: number | null;
  toNode: number | null;
}

export function wayDirection(index: PackageIndex, link: Link): WayDirection {
  const opposite = link.oppositeLink ? index.links.get(link.oppositeLink) : undefined;
  if (!opposite) return 'oneway';
  if (link.osmForward !== undefined) return link.osmForward ? 'forward' : 'backward';
  const links = index.pkg.links;
  return links.indexOf(link) <= links.indexOf(opposite) ? 'forward' : 'backward';
}

/** Tag key suffix for a direction (`:forward`, `:backward`, or none for one-way). */
export function directionSuffix(direction: WayDirection): string {
  return direction === 'oneway' ? '' : `:${direction}`;
}

export function oppositeOf(index: PackageIndex, link: Link): Link | null {
  return (link.oppositeLink && index.links.get(link.oppositeLink)) || null;
}

/** OSM id of a compiled node (null for synthetic boundary nodes). */
export function nodeOsmId(index: PackageIndex, nodeId: string): number | null {
  return index.nodes.get(nodeId)?.osmId ?? null;
}

/** Throws if the link has no OSM way (cannot be edited). */
export function requireWay(link: Link): number {
  if (link.osmWayId === null) throw new EditError('This road has no OpenStreetMap way and cannot be edited.');
  return link.osmWayId;
}

/** The part of the way that this link covers, with its ends in way node order. */
export function linkPart(index: PackageIndex, link: Link): WayPart {
  const wayId = requireWay(link);
  const a = nodeOsmId(index, link.from);
  const b = nodeOsmId(index, link.to);
  return wayDirection(index, link) === 'backward' ? { wayId, fromNode: b, toNode: a } : { wayId, fromNode: a, toNode: b };
}

const partKey = (p: WayPart) => `${p.wayId}:${[p.fromNode, p.toNode].sort().join('-')}`;

/**
 * Way parts an edit with the given scope must address. "Whole way" is a single way-level edit unless
 * an earlier edit in the changeset has split the way; then it is one edit per visible part, because
 * the backend applies way-level edits only to the part that kept the original id.
 */
export function scopeParts(index: PackageIndex, link: Link, scope: EditScope, changeset: Changeset): WayPart[] {
  const wayId = requireWay(link);
  if (scope === 'part') return [linkPart(index, link)];
  if (!changeset.some((op) => splitsWay(op, wayId))) return [{ wayId, fromNode: null, toNode: null }];
  const parts = new Map<string, WayPart>();
  for (const l of index.pkg.links) {
    if (l.osmWayId !== wayId) continue;
    const part = linkPart(index, l);
    parts.set(partKey(part), part);
  }
  return [...parts.values()];
}

export function setWayTags(parts: readonly WayPart[], tags: TagChanges): SetWayTagsOp[] {
  return parts.map((p) => ({ op: 'set_way_tags', wayId: p.wayId, fromNode: p.fromNode, toNode: p.toNode, tags: { ...tags } }));
}

export function removeWays(parts: readonly WayPart[]): RemoveWayOp[] {
  return parts.map((p) => ({ op: 'remove_way', wayId: p.wayId, fromNode: p.fromNode, toNode: p.toNode }));
}
