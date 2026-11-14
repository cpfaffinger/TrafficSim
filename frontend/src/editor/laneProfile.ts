import type { BoundaryMarking, LaneTurn, Link } from '../network/types';
import type { TagChanges } from './ops';
import { directionSuffix, type WayDirection } from './wayContext';

/**
 * Editable per-lane layout of one link direction. Lane 0 is the rightmost lane (package convention);
 * OSM `*:lanes` tags list lanes left → right, so tags are written in reverse order.
 */
export interface LaneSpec {
  turns: LaneTurn[];
  width: number;
  busOnly: boolean;
}

/** Lane-change permissions across the boundary between lane i and i + 1. */
export interface BoundarySpec {
  allowLeft: boolean;
  allowRight: boolean;
}

export interface LaneProfile {
  lanes: LaneSpec[];
  /** One per pair of adjacent lanes (`lanes.length - 1`). */
  boundaries: BoundarySpec[];
  /** Lane widths are tagged (not compiler defaults), so they are written as `width:lanes`. */
  widthTagged: boolean;
}

export const MIN_LANE_WIDTH = 2;
export const MAX_LANE_WIDTH = 5;
export const MAX_LANES_PER_DIRECTION = 8;

/** Per-lane keys written for a direction; their directional variants are cleared for one-way roads. */
export const PER_LANE_KEYS = ['turn:lanes', 'change:lanes', 'bus:lanes', 'psv:lanes', 'width:lanes'] as const;

const DASHED: BoundarySpec = { allowLeft: true, allowRight: true };

export function profileOf(link: Link): LaneProfile {
  return {
    lanes: link.lanes.map((l) => ({
      turns: [...l.turns],
      width: l.width,
      busOnly: l.allowed.length === 1 && l.allowed[0] === 'bus',
    })),
    boundaries: link.boundaries.map((b) => ({ allowLeft: b.allowLeft, allowRight: b.allowRight })),
    widthTagged: !link.assumed.includes('width'),
  };
}

/** Adds a lane on the left (centre side) or right (kerb side), copying the neighbour's width. */
export function addLane(p: LaneProfile, side: 'left' | 'right'): LaneProfile {
  const neighbour = side === 'left' ? p.lanes.at(-1) : p.lanes[0];
  const lane: LaneSpec = { turns: [], width: neighbour?.width ?? 3.25, busOnly: false };
  if (p.lanes.length === 0) return { ...p, lanes: [lane], boundaries: [] };
  return side === 'left'
    ? { ...p, lanes: [...p.lanes, lane], boundaries: [...p.boundaries, { ...DASHED }] }
    : { ...p, lanes: [lane, ...p.lanes], boundaries: [{ ...DASHED }, ...p.boundaries] };
}

/** Removes lane `index`; the boundary on its left side goes with it (the right one for the leftmost lane). */
export function removeLane(p: LaneProfile, index: number): LaneProfile {
  const lanes = p.lanes.filter((_, i) => i !== index);
  const drop = index >= p.lanes.length - 1 ? index - 1 : index;
  return { ...p, lanes, boundaries: p.boundaries.filter((_, i) => i !== drop) };
}

export function updateLane(p: LaneProfile, index: number, change: Partial<LaneSpec>): LaneProfile {
  return { ...p, lanes: p.lanes.map((l, i) => (i === index ? { ...l, ...change } : l)) };
}

export function setWidths(p: LaneProfile, index: number | null, width: number): LaneProfile {
  return { ...p, widthTagged: true, lanes: p.lanes.map((l, i) => (index === null || i === index ? { ...l, width } : l)) };
}

/** Permissions for a marking drawn on a boundary (ADR-0016). */
export function permissionsOf(marking: BoundaryMarking): BoundarySpec {
  switch (marking) {
    case 'dashed':
      return { allowLeft: true, allowRight: true };
    case 'solid':
    case 'double_solid':
      return { allowLeft: false, allowRight: false };
    case 'solid_dashed':
      return { allowLeft: true, allowRight: false };
    case 'dashed_solid':
      return { allowLeft: false, allowRight: true };
  }
}

export function markingOf(b: BoundarySpec): BoundaryMarking {
  if (b.allowLeft && b.allowRight) return 'dashed';
  if (b.allowLeft) return 'solid_dashed';
  if (b.allowRight) return 'dashed_solid';
  return 'solid';
}

const MARKING_CYCLE: BoundaryMarking[] = ['dashed', 'solid', 'solid_dashed', 'dashed_solid'];

/** Next marking when clicking a boundary: dashed → solid → solid|dashed → dashed|solid → dashed. */
export function nextMarking(current: BoundaryMarking): BoundaryMarking {
  const i = MARKING_CYCLE.indexOf(current === 'double_solid' ? 'solid' : current);
  return MARKING_CYCLE[(i + 1) % MARKING_CYCLE.length]!;
}

export function setBoundary(p: LaneProfile, index: number, marking: BoundaryMarking): LaneProfile {
  return { ...p, boundaries: p.boundaries.map((b, i) => (i === index ? permissionsOf(marking) : b)) };
}

/** OSM `change:lanes` value of lane i from the boundaries on either side. */
function changeValue(p: LaneProfile, i: number): string {
  const left = p.boundaries[i]?.allowLeft ?? true;
  const right = i > 0 ? (p.boundaries[i - 1]?.allowRight ?? true) : true;
  if (left && right) return 'yes';
  if (right) return 'not_left';
  if (left) return 'not_right';
  return 'no';
}

export function turnValue(turns: readonly LaneTurn[]): string {
  return turns.length ? turns.join(';') : 'none';
}

const formatWidth = (w: number) => String(Math.round(w * 100) / 100);

/** Joins per-lane values (index 0 = rightmost) in OSM order (left → right). */
export function osmLanes(values: readonly string[]): string {
  return [...values].reverse().join('|');
}

/** `*:lanes` tags describing the profile for one direction; tags that would carry no information are removed. */
export function laneTags(p: LaneProfile, direction: WayDirection): TagChanges {
  const suffix = directionSuffix(direction);
  const tags: TagChanges = {};
  const set = (key: string, values: string[] | null) => {
    tags[`${key}${suffix}`] = values ? osmLanes(values) : null;
    if (direction === 'oneway') {
      tags[`${key}:forward`] = null;
      tags[`${key}:backward`] = null;
    }
  };
  set('turn:lanes', p.lanes.some((l) => l.turns.length) ? p.lanes.map((l) => turnValue(l.turns)) : null);
  const change = p.lanes.map((_, i) => changeValue(p, i));
  set('change:lanes', change.some((c) => c !== 'yes') ? change : null);
  set('bus:lanes', p.lanes.some((l) => l.busOnly) ? p.lanes.map((l) => (l.busOnly ? 'designated' : 'yes')) : null);
  set('psv:lanes', null);
  set('width:lanes', p.widthTagged ? p.lanes.map((l) => formatWidth(l.width)) : null);
  return tags;
}

/** Lane count tags for a way given the lanes of this link's direction and of the opposite direction. */
export function laneCountTags(direction: WayDirection, own: number, opposite: number): TagChanges {
  if (direction === 'oneway') return { lanes: String(own), 'lanes:forward': null, 'lanes:backward': null };
  const forward = direction === 'forward' ? own : opposite;
  const backward = direction === 'forward' ? opposite : own;
  const total = forward + backward;
  return {
    lanes: total <= MAX_LANES_PER_DIRECTION ? String(total) : null,
    'lanes:forward': String(forward),
    'lanes:backward': String(backward),
  };
}
