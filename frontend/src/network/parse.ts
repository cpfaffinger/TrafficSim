import { parseCrossings } from './crossings';
import {
  BOUNDARY_MARKINGS,
  CONNECTOR_TURNS,
  LANE_TURNS,
  LEFT_EDGES,
  NODE_CONTROLS,
  PRIORITIES,
  ROAD_CLASSES,
  STRUCTURES,
  VEHICLE_CLASSES,
  type BBox,
  type Boundary,
  type Connector,
  type Lane,
  type Link,
  type NetworkNode,
  type NetworkPackage,
  type PackageStats,
  type Polyline,
  type SignalController,
  type SignalGroup,
  type Vec3, END_SIGNS } from './types';

/** Thrown when a network package does not conform to format v1. `path` points at the offending value. */
export class NetworkPackageError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'NetworkPackageError';
  }
}

type Obj = Record<string, unknown>;

const fail = (path: string, message: string): never => {
  throw new NetworkPackageError(path, message);
};

function obj(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object');
  return value as Obj;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value as unknown[];
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value as number;
}

function nonNeg(value: unknown, path: string): number {
  const n = num(value, path);
  if (n < 0) fail(path, 'expected a non-negative number');
  return n;
}

function int(value: unknown, path: string): number {
  const n = num(value, path);
  if (!Number.isInteger(n)) fail(path, 'expected an integer');
  return n;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  return value as string;
}

function id(value: unknown, path: string): string {
  const s = str(value, path);
  if (s.length === 0) fail(path, 'expected a non-empty id');
  return s;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value as boolean;
}

function nullable<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): T | null {
  return value === null || value === undefined ? null : read(value, path);
}

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown, path: string): T => {
    const s = str(value, path);
    if (!(values as readonly string[]).includes(s)) fail(path, `unknown value "${s}"`);
    return s as T;
  };
}

function list<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): T[] {
  return arr(value, path).map((item, i) => read(item, `${path}[${i}]`));
}

function vec3(value: unknown, path: string): Vec3 {
  const a = arr(value, path);
  if (a.length !== 3) fail(path, 'expected [x, y, z]');
  return [num(a[0], `${path}[0]`), num(a[1], `${path}[1]`), num(a[2], `${path}[2]`)];
}

function polyline(value: unknown, path: string): Polyline {
  const points = list(value, path, vec3);
  if (points.length < 2) fail(path, 'expected at least two points');
  return points;
}

function bbox(value: unknown, path: string): BBox {
  const a = arr(value, path);
  if (a.length !== 4) fail(path, 'expected [west, south, east, north]');
  const [w, s, e, n] = a.map((v, i) => num(v, `${path}[${i}]`)) as [number, number, number, number];
  if (w >= e || s >= n) fail(path, 'expected west < east and south < north');
  return [w, s, e, n];
}

function node(value: unknown, path: string): NetworkNode {
  const o = obj(value, path);
  return {
    id: id(o.id, `${path}.id`),
    osmId: nullable(o.osmId, `${path}.osmId`, num),
    x: num(o.x, `${path}.x`),
    y: num(o.y, `${path}.y`),
    z: num(o.z ?? 0, `${path}.z`),
    control: oneOf(NODE_CONTROLS)(o.control, `${path}.control`),
  };
}

function lane(value: unknown, path: string): Lane {
  const o = obj(value, path);
  const width = num(o.width, `${path}.width`);
  if (width <= 0) fail(`${path}.width`, 'expected a positive width');
  return {
    id: id(o.id, `${path}.id`),
    index: int(o.index, `${path}.index`),
    width,
    speedLimit: nonNeg(o.speedLimit, `${path}.speedLimit`),
    allowed: list(o.allowed, `${path}.allowed`, oneOf(VEHICLE_CLASSES)),
    turns: list(o.turns, `${path}.turns`, oneOf(LANE_TURNS)),
    geometry: polyline(o.geometry, `${path}.geometry`),
    length: nonNeg(o.length, `${path}.length`),
  };
}

function boundary(value: unknown, path: string): Boundary {
  const o = obj(value, path);
  const b: Boundary = {
    rightLane: int(o.rightLane, `${path}.rightLane`),
    leftLane: int(o.leftLane, `${path}.leftLane`),
    marking: oneOf(BOUNDARY_MARKINGS)(o.marking, `${path}.marking`),
    allowLeft: bool(o.allowLeft, `${path}.allowLeft`),
    allowRight: bool(o.allowRight, `${path}.allowRight`),
  };
  if (b.leftLane !== b.rightLane + 1) fail(path, 'leftLane must equal rightLane + 1');
  return b;
}

function link(value: unknown, path: string): Link {
  const o = obj(value, path);
  const lanes = list(o.lanes, `${path}.lanes`, lane);
  if (lanes.length === 0) fail(`${path}.lanes`, 'expected at least one lane');
  lanes.forEach((l, i) => {
    if (l.index !== i) fail(`${path}.lanes[${i}].index`, `expected lanes ordered by index (got ${l.index}, expected ${i})`);
  });
  const boundaries = list(o.boundaries, `${path}.boundaries`, boundary);
  if (boundaries.length !== lanes.length - 1) {
    fail(`${path}.boundaries`, `expected ${lanes.length - 1} boundaries for ${lanes.length} lanes`);
  }
  boundaries.forEach((b, i) => {
    if (b.rightLane !== i) fail(`${path}.boundaries[${i}].rightLane`, `expected ${i}`);
  });
  return {
    id: id(o.id, `${path}.id`),
    osmWayId: nullable(o.osmWayId, `${path}.osmWayId`, num),
    from: id(o.from, `${path}.from`),
    to: id(o.to, `${path}.to`),
    roadClass: oneOf(ROAD_CLASSES)(o.roadClass, `${path}.roadClass`),
    name: nullable(o.name, `${path}.name`, str),
    layer: int(o.layer ?? 0, `${path}.layer`),
    structure: oneOf(STRUCTURES)(o.structure ?? 'none', `${path}.structure`),
    roundabout: bool(o.roundabout ?? false, `${path}.roundabout`),
    oppositeLink: nullable(o.oppositeLink, `${path}.oppositeLink`, id),
    throughTraffic: bool(o.throughTraffic ?? true, `${path}.throughTraffic`),
    length: nonNeg(o.length, `${path}.length`),
    speedLimit: nonNeg(o.speedLimit, `${path}.speedLimit`),
    geometry: polyline(o.geometry, `${path}.geometry`),
    lanes,
    boundaries,
    leftEdge: oneOf(LEFT_EDGES)(o.leftEdge, `${path}.leftEdge`),
    noLaneChangeZone: nonNeg(o.noLaneChangeZone ?? 0, `${path}.noLaneChangeZone`),
    assumed: list(o.assumed ?? [], `${path}.assumed`, str),
    osmAfterFrom: nullable(o.osmAfterFrom, `${path}.osmAfterFrom`, num),
    osmBeforeTo: nullable(o.osmBeforeTo, `${path}.osmBeforeTo`, num),
    ...(o.osmForward === undefined ? {} : { osmForward: bool(o.osmForward, `${path}.osmForward`) }),
    ...(o.endSign === undefined ? {} : { endSign: oneOf(END_SIGNS)(o.endSign, `${path}.endSign`) }),
    ...(o.osmNodes === undefined
      ? {}
      : {
          osmNodes: list(o.osmNodes, `${path}.osmNodes`, (v: unknown, p: string) => {
            const n = v as Record<string, unknown>;
            if (typeof n !== 'object' || n === null) throw new Error(`${p} must be an object`);
            return { id: nullable(n.id, `${p}.id`, num), x: num(n.x, `${p}.x`), y: num(n.y, `${p}.y`) };
          }),
        }),
  };
}

function connector(value: unknown, path: string): Connector {
  const o = obj(value, path);
  return {
    id: id(o.id, `${path}.id`),
    node: id(o.node, `${path}.node`),
    fromLink: id(o.fromLink, `${path}.fromLink`),
    fromLane: int(o.fromLane, `${path}.fromLane`),
    toLink: id(o.toLink, `${path}.toLink`),
    toLane: int(o.toLane, `${path}.toLane`),
    turn: oneOf(CONNECTOR_TURNS)(o.turn, `${path}.turn`),
    priority: oneOf(PRIORITIES)(o.priority, `${path}.priority`),
    signalGroup: nullable(o.signalGroup, `${path}.signalGroup`, id),
    geometry: polyline(o.geometry, `${path}.geometry`),
    length: nonNeg(o.length, `${path}.length`),
    conflicts: list(o.conflicts ?? [], `${path}.conflicts`, id),
  };
}

function interval(value: unknown, path: string): [number, number] {
  const a = arr(value, path);
  if (a.length !== 2) fail(path, 'expected [start, end]');
  const start = nonNeg(a[0], `${path}[0]`);
  const end = num(a[1], `${path}[1]`);
  if (start >= end) fail(path, 'expected start < end');
  return [start, end];
}

function signalGroup(value: unknown, path: string): SignalGroup {
  const o = obj(value, path);
  return {
    id: id(o.id, `${path}.id`),
    green: list(o.green, `${path}.green`, interval),
    amber: nonNeg(o.amber, `${path}.amber`),
  };
}

function signal(value: unknown, path: string): SignalController {
  const o = obj(value, path);
  const cycle = num(o.cycle, `${path}.cycle`);
  if (cycle <= 0) fail(`${path}.cycle`, 'expected a positive cycle time');
  const groups = list(o.groups, `${path}.groups`, signalGroup);
  groups.forEach((g, gi) =>
    g.green.forEach(([, end], ii) => {
      if (end > cycle) fail(`${path}.groups[${gi}].green[${ii}]`, 'green interval exceeds the cycle');
    }),
  );
  return { node: id(o.node, `${path}.node`), cycle, offset: num(o.offset ?? 0, `${path}.offset`), groups };
}

function uniqueIds(items: readonly { id: string }[], path: string, seen: Set<string>): void {
  items.forEach((item, i) => {
    if (seen.has(item.id)) fail(`${path}[${i}].id`, `duplicate id "${item.id}"`);
    seen.add(item.id);
  });
}

function checkReferences(pkg: NetworkPackage): void {
  const seen = new Set<string>();
  uniqueIds(pkg.nodes, 'nodes', seen);
  uniqueIds(pkg.links, 'links', seen);
  uniqueIds(pkg.connectors, 'connectors', seen);
  const nodes = new Set(pkg.nodes.map((n) => n.id));
  const links = new Map(pkg.links.map((l) => [l.id, l]));
  pkg.links.forEach((l, i) => {
    if (!nodes.has(l.from)) fail(`links[${i}].from`, `unknown node "${l.from}"`);
    if (!nodes.has(l.to)) fail(`links[${i}].to`, `unknown node "${l.to}"`);
    if (l.oppositeLink !== null && !links.has(l.oppositeLink)) {
      fail(`links[${i}].oppositeLink`, `unknown link "${l.oppositeLink}"`);
    }
  });
  const connectorIds = new Set(pkg.connectors.map((c) => c.id));
  pkg.connectors.forEach((c, i) => {
    const p = `connectors[${i}]`;
    if (!nodes.has(c.node)) fail(`${p}.node`, `unknown node "${c.node}"`);
    const from = links.get(c.fromLink) ?? fail(`${p}.fromLink`, `unknown link "${c.fromLink}"`);
    const to = links.get(c.toLink) ?? fail(`${p}.toLink`, `unknown link "${c.toLink}"`);
    if (c.fromLane < 0 || c.fromLane >= from.lanes.length) fail(`${p}.fromLane`, 'lane index out of range');
    if (c.toLane < 0 || c.toLane >= to.lanes.length) fail(`${p}.toLane`, 'lane index out of range');
    c.conflicts.forEach((other, j) => {
      if (!connectorIds.has(other)) fail(`${p}.conflicts[${j}]`, `unknown connector "${other}"`);
    });
  });
  const groups = new Set(pkg.signals.flatMap((s) => s.groups.map((g) => g.id)));
  pkg.signals.forEach((s, i) => {
    if (!nodes.has(s.node)) fail(`signals[${i}].node`, `unknown node "${s.node}"`);
  });
  pkg.connectors.forEach((c, i) => {
    if (c.signalGroup !== null && !groups.has(c.signalGroup)) {
      fail(`connectors[${i}].signalGroup`, `unknown signal group "${c.signalGroup}"`);
    }
  });
}

function stats(value: unknown, pkg: Omit<NetworkPackage, 'stats'>): PackageStats {
  if (value !== undefined && value !== null) {
    const o = obj(value, 'stats');
    return {
      nodes: nonNeg(o.nodes, 'stats.nodes'),
      links: nonNeg(o.links, 'stats.links'),
      lanes: nonNeg(o.lanes, 'stats.lanes'),
      connectors: nonNeg(o.connectors, 'stats.connectors'),
      signals: nonNeg(o.signals, 'stats.signals'),
    };
  }
  return {
    nodes: pkg.nodes.length,
    links: pkg.links.length,
    lanes: pkg.links.reduce((sum, l) => sum + l.lanes.length, 0),
    connectors: pkg.connectors.length,
    signals: pkg.signals.length,
  };
}

/**
 * Validates untrusted JSON against network package format v1 and returns a typed copy.
 * Unknown keys are ignored (forward compatibility); missing optional keys get their documented defaults.
 * @throws NetworkPackageError on the first violation.
 */
export function parseNetworkPackage(input: unknown): NetworkPackage {
  const o = obj(input, '$');
  if (o.formatVersion !== 1) fail('formatVersion', `unsupported format version ${String(o.formatVersion)} (expected 1)`);
  const origin = obj(o.origin, 'origin');
  const lat = num(origin.lat, 'origin.lat');
  const lon = num(origin.lon, 'origin.lon');
  if (Math.abs(lat) > 90) fail('origin.lat', 'latitude out of range');
  if (Math.abs(lon) > 180) fail('origin.lon', 'longitude out of range');
  const base = {
    formatVersion: 1 as const,
    baselineId: nullable(o.baselineId, 'baselineId', str),
    origin: { lat, lon },
    bbox: bbox(o.bbox, 'bbox'),
    ...(o.area === undefined || o.area === null
      ? {}
      : { area: list(o.area, 'area', (v: unknown, p: string) => { const a = list(v, p, num); if (a.length !== 2) fail(p, 'expected [lon, lat]'); return [a[0]!, a[1]!] as const; }) }),
    osmTimestamp: nullable(o.osmTimestamp, 'osmTimestamp', str),
    attribution: list(o.attribution ?? [], 'attribution', str),
    nodes: list(o.nodes, 'nodes', node),
    links: list(o.links, 'links', link),
    connectors: list(o.connectors ?? [], 'connectors', connector),
    signals: list(o.signals ?? [], 'signals', signal),
  };
  const pkg: NetworkPackage = { ...base, stats: stats(o.stats, base) };
  checkReferences(pkg);
  if (o.crossings !== undefined && o.crossings !== null) pkg.crossings = parseCrossings(o.crossings, pkg, fail);
  return pkg;
}
