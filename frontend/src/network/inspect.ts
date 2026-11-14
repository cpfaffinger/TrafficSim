import type { PickTarget } from './meshData';
import type { Connector, Lane, Link, NetworkNode, NetworkPackage, SignalController } from './types';

/** View model for the inspector panel (#37): plain labelled values, no rendering concerns. */

export interface InspectorField {
  label: string;
  value: string;
  /** The value was filled from defaults by the compiler (`assumed`). */
  assumed?: boolean;
}

export interface InspectorSection {
  title: string;
  fields: InspectorField[];
}

export interface InspectorModel {
  title: string;
  kind: PickTarget['kind'];
  sections: InspectorSection[];
}

/** Lookup tables for repeated inspection of one package. */
export class PackageIndex {
  readonly links: Map<string, Link>;
  readonly nodes: Map<string, NetworkNode>;
  readonly connectors: Map<string, Connector>;
  readonly signals: Map<string, SignalController>;

  constructor(readonly pkg: NetworkPackage) {
    this.links = new Map(pkg.links.map((l) => [l.id, l]));
    this.nodes = new Map(pkg.nodes.map((n) => [n.id, n]));
    this.connectors = new Map(pkg.connectors.map((c) => [c.id, c]));
    this.signals = new Map(pkg.signals.map((s) => [s.node, s]));
  }
}

export const kmh = (metresPerSecond: number) => `${Math.round(metresPerSecond * 3.6)} km/h`;
const metres = (m: number) => `${m.toFixed(m < 10 ? 2 : 1)} m`;
const words = (s: string) => s.replace(/_/g, ' ');
const list = (items: readonly string[], empty: string) => (items.length ? items.map(words).join(', ') : empty);

export function inspect(index: PackageIndex, target: PickTarget): InspectorModel | null {
  switch (target.kind) {
    case 'lane': {
      const link = index.links.get(target.linkId);
      const lane = link?.lanes[target.laneIndex];
      if (!link || !lane) return null;
      return { title: `Lane ${lane.id}`, kind: 'lane', sections: [laneSection(link, lane), ...linkSections(index, link)] };
    }
    case 'link': {
      const link = index.links.get(target.linkId);
      return link ? { title: `Link ${link.id}`, kind: 'link', sections: linkSections(index, link) } : null;
    }
    case 'connector': {
      const c = index.connectors.get(target.connectorId);
      return c ? { title: `Movement ${c.id}`, kind: 'connector', sections: connectorSections(index, c) } : null;
    }
    case 'node': {
      const n = index.nodes.get(target.nodeId);
      return n ? { title: `Node ${n.id}`, kind: 'node', sections: nodeSections(index, n) } : null;
    }
  }
}

function laneSection(link: Link, lane: Lane): InspectorSection {
  const assumed = new Set(link.assumed);
  const position = lane.index === 0 ? 'rightmost' : lane.index === link.lanes.length - 1 ? 'leftmost' : 'middle';
  return {
    title: 'Lane',
    fields: [
      { label: 'Index', value: `${lane.index} (${position} of ${link.lanes.length})` },
      { label: 'Width', value: metres(lane.width), assumed: assumed.has('width') },
      { label: 'Speed limit', value: kmh(lane.speedLimit), assumed: assumed.has('speedLimit') },
      { label: 'Allowed', value: list(lane.allowed, 'closed') },
      { label: 'Turns', value: list(lane.turns, 'unmarked'), assumed: assumed.has('turns') },
      { label: 'Length', value: metres(lane.length) },
    ],
  };
}

export function boundaryLabel(link: Link): string {
  if (link.boundaries.length === 0) return 'none (single lane)';
  return link.boundaries
    .map((b) => {
      const may = [b.allowLeft ? '→left' : null, b.allowRight ? '→right' : null].filter(Boolean).join(' ');
      return `${b.rightLane}|${b.leftLane}: ${words(b.marking)}${may ? ` (${may})` : ' (no change)'}`;
    })
    .join('; ');
}

function linkSections(index: PackageIndex, link: Link): InspectorSection[] {
  const assumed = new Set(link.assumed);
  const road: InspectorSection = {
    title: 'Road',
    fields: [
      { label: 'Link', value: link.id },
      { label: 'Name', value: link.name ?? '—' },
      { label: 'Road class', value: words(link.roadClass) },
      { label: 'OSM way', value: link.osmWayId === null ? '—' : String(link.osmWayId) },
      { label: 'From → to', value: `${link.from} → ${link.to}` },
      { label: 'Direction', value: link.oppositeLink ? `two-way (opposite ${link.oppositeLink})` : 'one-way' },
      { label: 'Lanes', value: String(link.lanes.length), assumed: assumed.has('lanes') },
      { label: 'Speed limit', value: kmh(link.speedLimit), assumed: assumed.has('speedLimit') },
      { label: 'Length', value: metres(link.length) },
      { label: 'Through traffic', value: link.throughTraffic ? 'yes' : 'no (destination only)' },
    ],
  };
  const markings: InspectorSection = {
    title: 'Markings',
    fields: [
      { label: 'Lane boundaries', value: boundaryLabel(link) },
      { label: 'Left edge', value: words(link.leftEdge) },
      { label: 'No lane change zone', value: link.noLaneChangeZone > 0 ? `last ${metres(link.noLaneChangeZone)}` : 'none' },
    ],
  };
  const structure: InspectorSection = {
    title: 'Structure',
    fields: [
      { label: 'Layer', value: String(link.layer) },
      { label: 'Structure', value: words(link.structure) },
      { label: 'Roundabout', value: link.roundabout ? 'yes' : 'no' },
      { label: 'End node control', value: words(index.nodes.get(link.to)?.control ?? 'unknown') },
    ],
  };
  const sections = [road, markings, structure];
  if (link.assumed.length) {
    sections.push({ title: 'Assumed values', fields: [{ label: 'Filled from defaults', value: list(link.assumed, '—'), assumed: true }] });
  }
  return sections;
}

function groupPlan(signal: SignalController | undefined, groupId: string | null): string {
  const group = signal?.groups.find((g) => g.id === groupId);
  if (!signal || !group) return '—';
  const green = group.green.map(([a, b]) => `${a}–${b} s`).join(', ');
  return `green ${green}, amber ${group.amber} s (cycle ${signal.cycle} s)`;
}

function connectorSections(index: PackageIndex, c: Connector): InspectorSection[] {
  const signal = index.signals.get(c.node);
  const fields: InspectorField[] = [
    { label: 'Node', value: `${c.node} (${words(index.nodes.get(c.node)?.control ?? 'unknown')})` },
    { label: 'From', value: `${c.fromLink} lane ${c.fromLane}` },
    { label: 'To', value: `${c.toLink} lane ${c.toLane}` },
    { label: 'Turn', value: words(c.turn) },
    { label: 'Priority', value: words(c.priority) },
    { label: 'Length', value: metres(c.length) },
    { label: 'Conflicts', value: c.conflicts.length ? `${c.conflicts.length}: ${c.conflicts.join(', ')}` : 'none' },
  ];
  if (c.signalGroup) {
    fields.push({ label: 'Signal group', value: c.signalGroup }, { label: 'Signal timing', value: groupPlan(signal, c.signalGroup) });
  }
  return [{ title: 'Movement', fields }];
}

function nodeSections(index: PackageIndex, n: NetworkNode): InspectorSection[] {
  const incoming = index.pkg.links.filter((l) => l.to === n.id).length;
  const outgoing = index.pkg.links.filter((l) => l.from === n.id).length;
  const movements = index.pkg.connectors.filter((c) => c.node === n.id).length;
  const sections: InspectorSection[] = [
    {
      title: 'Junction',
      fields: [
        { label: 'Node', value: n.id },
        { label: 'OSM node', value: n.osmId === null ? '—' : String(n.osmId) },
        { label: 'Control', value: words(n.control) },
        { label: 'Links in / out', value: `${incoming} / ${outgoing}` },
        { label: 'Movements', value: String(movements) },
        { label: 'Position', value: `${n.x.toFixed(1)} E, ${n.y.toFixed(1)} N, ${n.z.toFixed(1)} up (m)` },
      ],
    },
  ];
  const signal = index.signals.get(n.id);
  if (signal) {
    sections.push({
      title: 'Signal plan',
      fields: [
        { label: 'Cycle', value: `${signal.cycle} s` },
        { label: 'Offset', value: `${signal.offset} s` },
        ...signal.groups.map((g) => ({ label: `Group ${g.id}`, value: groupPlan(signal, g.id).replace(/ \(cycle.*\)$/, '') })),
      ],
    });
  }
  return sections;
}
