import type { PackageIndex } from '../network/inspect';
import type { BoundaryMarking, LaneTurn, Link } from '../network/types';
import {
  addLane as addProfileLane,
  laneCountTags,
  laneTags,
  MAX_LANE_WIDTH,
  MAX_LANES_PER_DIRECTION,
  MIN_LANE_WIDTH,
  profileOf,
  removeLane as removeProfileLane,
  setBoundary,
  setWidths,
  updateLane,
  type LaneProfile,
} from './laneProfile';
import { EditError, type Changeset, type EditResult, type TagChanges } from './ops';
import { oppositeOf, removeWays, scopeParts, setWayTags, wayDirection, type EditScope } from './wayContext';

/**
 * Link tools (#65, #67, #98, #69): UI actions on a selected link → `set_way_tags` / `remove_way` edits.
 * All builders are pure; they throw `EditError` for actions that make no sense on the link.
 */
export interface LinkEditContext {
  index: PackageIndex;
  changeset: Changeset;
  scope: EditScope;
}

const scopeLabel = (scope: EditScope) => (scope === 'part' ? 'this part' : 'whole road');

function tagEdit(ctx: LinkEditContext, link: Link, label: string, tags: TagChanges): EditResult {
  return { label: `${label} (${scopeLabel(ctx.scope)})`, ops: setWayTags(scopeParts(ctx.index, link, ctx.scope, ctx.changeset), tags) };
}

/** Rewrites lane count and per-lane tags of the link's direction from an edited profile. */
function profileEdit(ctx: LinkEditContext, link: Link, label: string, edit: (p: LaneProfile) => LaneProfile): EditResult {
  const direction = wayDirection(ctx.index, link);
  const profile = edit(profileOf(link));
  const opposite = oppositeOf(ctx.index, link);
  const tags = { ...laneCountTags(direction, profile.lanes.length, opposite?.lanes.length ?? 0), ...laneTags(profile, direction) };
  return tagEdit(ctx, link, label, tags);
}

export function addLane(ctx: LinkEditContext, link: Link, side: 'left' | 'right'): EditResult {
  if (link.lanes.length >= MAX_LANES_PER_DIRECTION) throw new EditError(`At most ${MAX_LANES_PER_DIRECTION} lanes per direction.`);
  return profileEdit(ctx, link, `Add lane on the ${side}`, (p) => addProfileLane(p, side));
}

export function removeLane(ctx: LinkEditContext, link: Link, laneIndex: number): EditResult {
  if (link.lanes.length <= 1) throw new EditError('A road needs at least one lane per direction. Remove the road or make it one-way instead.');
  if (laneIndex < 0 || laneIndex >= link.lanes.length) throw new EditError(`Lane ${laneIndex} does not exist.`);
  return profileEdit(ctx, link, `Remove lane ${laneIndex}`, (p) => removeProfileLane(p, laneIndex));
}

/** Moves the leftmost lane of this direction to the opposite direction (changes the direction split). */
export function moveLaneToOpposite(ctx: LinkEditContext, link: Link): EditResult {
  const opposite = oppositeOf(ctx.index, link);
  if (!opposite) throw new EditError('Only two-way roads have an opposite direction.');
  if (link.lanes.length <= 1) throw new EditError('This direction has only one lane.');
  if (opposite.lanes.length >= MAX_LANES_PER_DIRECTION) throw new EditError('The opposite direction already has the maximum number of lanes.');
  const direction = wayDirection(ctx.index, link);
  const own = removeProfileLane(profileOf(link), link.lanes.length - 1);
  const other = addProfileLane(profileOf(opposite), 'left');
  const tags = {
    ...laneCountTags(direction, own.lanes.length, other.lanes.length),
    ...laneTags(own, direction),
    ...laneTags(other, wayDirection(ctx.index, opposite)),
  };
  return tagEdit(ctx, link, 'Move a lane to the opposite direction', tags);
}

export function setLaneWidth(ctx: LinkEditContext, link: Link, laneIndex: number | null, width: number): EditResult {
  if (!Number.isFinite(width) || width < MIN_LANE_WIDTH || width > MAX_LANE_WIDTH) {
    throw new EditError(`Lane width must be between ${MIN_LANE_WIDTH} and ${MAX_LANE_WIDTH} m.`);
  }
  const which = laneIndex === null ? 'all lanes' : `lane ${laneIndex}`;
  return profileEdit(ctx, link, `Width of ${which}: ${width} m`, (p) => setWidths(p, laneIndex, width));
}

/**
 * Two-way → one-way in the selected link's direction; one-way → two-way with the lanes split between
 * both directions (at least one each).
 */
export function toggleOneway(ctx: LinkEditContext, link: Link): EditResult {
  const direction = wayDirection(ctx.index, link);
  if (direction === 'oneway') {
    const n = link.lanes.length;
    const forward = Math.max(1, Math.ceil(n / 2));
    const backward = Math.max(1, n - forward);
    const cleared: TagChanges = {};
    for (const key of ['turn:lanes', 'change:lanes', 'bus:lanes', 'psv:lanes', 'width:lanes']) cleared[key] = null;
    return tagEdit(ctx, link, 'Make two-way', { oneway: 'no', ...laneCountTags('forward', forward, backward), ...cleared });
  }
  const profile = profileOf(link);
  return tagEdit(ctx, link, 'Make one-way', {
    oneway: direction === 'forward' ? 'yes' : '-1',
    ...laneCountTags('oneway', profile.lanes.length, 0),
    ...laneTags(profile, 'oneway'),
  });
}

export function setTurns(ctx: LinkEditContext, link: Link, laneIndex: number, turns: readonly LaneTurn[]): EditResult {
  if (!link.lanes[laneIndex]) throw new EditError(`Lane ${laneIndex} does not exist.`);
  const label = `Turn markings of lane ${laneIndex}: ${turns.length ? turns.join(', ').replace(/_/g, ' ') : 'none'}`;
  return profileEdit(ctx, link, label, (p) => updateLane(p, laneIndex, { turns: [...turns] }));
}

export function setBusLane(ctx: LinkEditContext, link: Link, laneIndex: number, busOnly: boolean): EditResult {
  if (!link.lanes[laneIndex]) throw new EditError(`Lane ${laneIndex} does not exist.`);
  if (busOnly && link.lanes.length === 1) throw new EditError('Add a lane first: a single-lane road cannot become a bus lane.');
  return profileEdit(ctx, link, `${busOnly ? 'Bus lane' : 'General lane'}: lane ${laneIndex}`, (p) => updateLane(p, laneIndex, { busOnly }));
}

export function setBoundaryMarking(ctx: LinkEditContext, link: Link, boundaryIndex: number, marking: BoundaryMarking): EditResult {
  if (!link.boundaries[boundaryIndex]) throw new EditError(`Boundary ${boundaryIndex} does not exist.`);
  return profileEdit(ctx, link, `Marking between lanes ${boundaryIndex} and ${boundaryIndex + 1}: ${marking.replace(/_/g, ' ')}`, (p) =>
    setBoundary(p, boundaryIndex, marking),
  );
}

/** Speed limit in km/h for this direction or both; null resets to the default for the road class. */
export function setSpeedLimit(ctx: LinkEditContext, link: Link, kmh: number | null, bothDirections: boolean): EditResult {
  if (kmh !== null && (!Number.isInteger(kmh) || kmh < 5 || kmh > 200)) throw new EditError('Speed limit must be a whole number between 5 and 200 km/h.');
  const direction = wayDirection(ctx.index, link);
  const value = kmh === null ? null : String(kmh);
  const label = kmh === null ? 'Default speed limit' : `Speed limit ${kmh} km/h`;
  if (direction === 'oneway' || bothDirections) {
    return tagEdit(ctx, link, label, {
      maxspeed: value,
      'maxspeed:forward': null,
      'maxspeed:backward': null,
      'maxspeed:lanes': null,
      'maxspeed:lanes:forward': null,
      'maxspeed:lanes:backward': null,
    });
  }
  return tagEdit(ctx, link, `${label} (${direction})`, { [`maxspeed:${direction}`]: value, [`maxspeed:lanes:${direction}`]: null });
}

export function setHgvBan(ctx: LinkEditContext, link: Link, banned: boolean): EditResult {
  return tagEdit(ctx, link, banned ? 'No trucks' : 'Trucks allowed', { hgv: banned ? 'no' : null });
}

export function setDestinationOnly(ctx: LinkEditContext, link: Link, destinationOnly: boolean): EditResult {
  return tagEdit(ctx, link, destinationOnly ? 'Destination traffic only' : 'Through traffic allowed', {
    access: destinationOnly ? 'destination' : null,
  });
}

/** Solid (no overtaking) or dashed centre line of a two-way road. */
export function setCentreLine(ctx: LinkEditContext, link: Link, solid: boolean): EditResult {
  if (!link.oppositeLink) throw new EditError('One-way roads have no centre line.');
  return tagEdit(ctx, link, solid ? 'Solid centre line (no overtaking)' : 'Dashed centre line', {
    overtaking: solid ? 'no' : 'yes',
    'overtaking:forward': null,
    'overtaking:backward': null,
    divider: null,
  });
}

export type EditableStructure = 'none' | 'bridge' | 'tunnel';

export function defaultLayer(structure: EditableStructure): number {
  return structure === 'bridge' ? 1 : structure === 'tunnel' ? -1 : 0;
}

/** Bridge, tunnel or ground level, with an OSM layer (−5…5). */
export function structureTags(structure: EditableStructure, layer: number = defaultLayer(structure)): TagChanges {
  if (!Number.isInteger(layer) || layer < -5 || layer > 5) throw new EditError('Layer must be a whole number between −5 and 5.');
  switch (structure) {
    case 'bridge':
      return { bridge: 'yes', tunnel: null, layer: String(layer) };
    case 'tunnel':
      return { tunnel: 'yes', bridge: null, layer: String(layer) };
    case 'none':
      return { bridge: null, tunnel: null, layer: layer === 0 ? null : String(layer) };
  }
}

export function setStructure(ctx: LinkEditContext, link: Link, structure: EditableStructure, layer?: number): EditResult {
  const tags = structureTags(structure, layer);
  const label = structure === 'none' ? 'At grade' : `${structure === 'bridge' ? 'Bridge' : 'Tunnel'}, layer ${tags.layer}`;
  return tagEdit(ctx, link, label, tags);
}

export function removeRoad(ctx: LinkEditContext, link: Link): EditResult {
  return { label: `Remove road (${scopeLabel(ctx.scope)})`, ops: removeWays(scopeParts(ctx.index, link, ctx.scope, ctx.changeset)) };
}
