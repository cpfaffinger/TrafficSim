import type { NetworkNode, NodeControl } from '../network/types';
import { EditError, type EditResult, type TagChanges } from './ops';

/** Junction control choices of the signal/junction editor (#68), written as OSM node tags. */
export const CONTROL_CHOICES = ['auto', 'signal', 'stop', 'all_way_stop', 'give_way', 'mini_roundabout'] as const;
export type ControlChoice = (typeof CONTROL_CHOICES)[number];

export const CONTROL_LABELS: Record<ControlChoice, string> = {
  auto: 'Priority / uncontrolled (automatic)',
  signal: 'Traffic signals',
  stop: 'Stop sign',
  all_way_stop: 'All-way stop',
  give_way: 'Give way sign',
  mini_roundabout: 'Mini roundabout',
};

const CONTROL_TAGS: Record<ControlChoice, TagChanges> = {
  auto: { highway: null, stop: null },
  signal: { highway: 'traffic_signals', stop: null },
  stop: { highway: 'stop', stop: null },
  all_way_stop: { highway: 'stop', stop: 'all' },
  give_way: { highway: 'give_way', stop: null },
  mini_roundabout: { highway: 'mini_roundabout', stop: null },
};

/** Best guess of the current choice from the compiled control (signs on the node itself are not in the package). */
export function controlChoiceOf(control: NodeControl): ControlChoice {
  switch (control) {
    case 'signal':
      return 'signal';
    case 'all_way_stop':
      return 'all_way_stop';
    case 'roundabout':
      return 'mini_roundabout';
    default:
      return 'auto';
  }
}

export function requireOsmNode(node: NetworkNode): number {
  if (node.osmId === null) throw new EditError('This point is a network boundary, not an OpenStreetMap node; it cannot be edited.');
  return node.osmId;
}

export function setNodeControl(node: NetworkNode, choice: ControlChoice): EditResult {
  return {
    label: `Junction control: ${CONTROL_LABELS[choice].toLowerCase()}`,
    ops: [{ op: 'set_node_tags', nodeId: requireOsmNode(node), tags: { ...CONTROL_TAGS[choice] } }],
  };
}

export const MIN_ROUNDABOUT_RADIUS = 6;
export const MAX_ROUNDABOUT_RADIUS = 60;

export function convertToRoundabout(node: NetworkNode, radius: number): EditResult {
  const nodeId = requireOsmNode(node);
  if (!Number.isFinite(radius) || radius < MIN_ROUNDABOUT_RADIUS || radius > MAX_ROUNDABOUT_RADIUS) {
    throw new EditError(`Roundabout radius must be between ${MIN_ROUNDABOUT_RADIUS} and ${MAX_ROUNDABOUT_RADIUS} m.`);
  }
  return { label: `Convert to roundabout (r = ${radius} m)`, ops: [{ op: 'convert_to_roundabout', nodeId, radius }] };
}
