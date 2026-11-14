/**
 * Pedestrian crossings of a network package (ADR-0020, #86): validation of the optional `crossings`
 * key, road markings (zebra stripes, crosswalk edge lines) and pedestrian positions from the
 * simulation's pedestrian snapshot. Pure functions; the scene's `CrossingLayer` draws them.
 */
import { CROSSING_KINDS, CROSSING_SIGNAL_MODES, type Crossing, type CrossingLink, type NetworkPackage, type Vec3 } from './types';

type Fail = (path: string, message: string) => never;
type Obj = Record<string, unknown>;

/** Floats per pedestrian in the sim core's `pedestrianSnapshot()` (sim-core/README.md). */
export const PEDESTRIAN_STRIDE = 5;

export const PEDESTRIAN_STATES = { waiting: 0, walking: 1, waitingOnCrossing: 2 } as const;

function parseCrossing(value: unknown, path: string, fail: Fail): Crossing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object');
  const o = value as Obj;
  const num = (v: unknown, p: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(p, 'expected a finite number'));
  const str = (v: unknown, p: string): string => (typeof v === 'string' && v.length > 0 ? v : fail(p, 'expected a non-empty string'));
  const opt = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === null || v === undefined ? null : read(v));
  const point = (v: unknown, p: string): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3) fail(p, 'expected [x, y, z]');
    const a = v as unknown[];
    return [num(a[0], `${p}[0]`), num(a[1], `${p}[1]`), num(a[2], `${p}[2]`)];
  };
  const kind = str(o.kind, `${path}.kind`);
  if (!(CROSSING_KINDS as readonly string[]).includes(kind)) fail(`${path}.kind`, `unknown value "${kind}"`);
  const mode = opt(o.signalMode, (v) => str(v, `${path}.signalMode`));
  if (mode !== null && !(CROSSING_SIGNAL_MODES as readonly string[]).includes(mode)) fail(`${path}.signalMode`, `unknown value "${mode}"`);
  const width = num(o.width, `${path}.width`);
  if (width <= 0) fail(`${path}.width`, 'expected a positive width');
  if (!Array.isArray(o.geometry) || o.geometry.length !== 2) fail(`${path}.geometry`, 'expected two kerb points');
  const geometry = o.geometry as unknown[];
  if (!Array.isArray(o.links) || o.links.length === 0) fail(`${path}.links`, 'expected at least one link');
  const links = (o.links as unknown[]).map((l, i): CrossingLink => {
    const p = `${path}.links[${i}]`;
    if (typeof l !== 'object' || l === null) fail(p, 'expected an object');
    const e = l as Obj;
    if (!Array.isArray(e.span) || e.span.length !== 2) fail(`${p}.span`, 'expected [from, to]');
    const span = e.span as unknown[];
    return { link: str(e.link, `${p}.link`), position: num(e.position, `${p}.position`), span: [num(span[0], `${p}.span[0]`), num(span[1], `${p}.span[1]`)] };
  });
  return {
    id: str(o.id, `${path}.id`),
    osmId: opt(o.osmId, (v) => num(v, `${path}.osmId`)),
    kind: kind as Crossing['kind'],
    node: opt(o.node, (v) => str(v, `${path}.node`)),
    signalGroup: opt(o.signalGroup, (v) => str(v, `${path}.signalGroup`)),
    signalMode: mode as Crossing['signalMode'],
    implicit: o.implicit === true,
    width,
    depth: o.depth === undefined ? 3 : num(o.depth, `${path}.depth`),
    demand: o.demand === undefined ? 0 : num(o.demand, `${path}.demand`),
    geometry: [point(geometry[0], `${path}.geometry[0]`), point(geometry[1], `${path}.geometry[1]`)],
    links,
  };
}

/** Validates the optional `crossings` key; references are checked against links and signal groups. */
export function parseCrossings(value: unknown, pkg: Pick<NetworkPackage, 'links' | 'signals'>, fail: Fail): Crossing[] {
  if (!Array.isArray(value)) return fail('crossings', 'expected an array');
  const links = new Set(pkg.links.map((l) => l.id));
  const groups = new Set(pkg.signals.flatMap((s) => s.groups.map((g) => g.id)));
  const seen = new Set<string>();
  return value.map((v, i) => {
    const c = parseCrossing(v, `crossings[${i}]`, fail);
    if (seen.has(c.id)) fail(`crossings[${i}].id`, `duplicate id "${c.id}"`);
    seen.add(c.id);
    c.links.forEach((l, j) => {
      if (!links.has(l.link)) fail(`crossings[${i}].links[${j}].link`, `unknown link "${l.link}"`);
    });
    if (c.signalGroup !== null && !groups.has(c.signalGroup)) fail(`crossings[${i}].signalGroup`, `unknown signal group "${c.signalGroup}"`);
    return c;
  });
}

/** Crossing frame in the ENU plane: first kerb, unit vector across (to the second kerb) and along the road. */
export function crossingFrame(c: Crossing): { origin: Vec3; across: [number, number]; along: [number, number]; length: number } {
  const [a, b] = c.geometry;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const across: [number, number] = len > 1e-9 ? [dx / len, dy / len] : [0, 1];
  return { origin: a, across, along: [across[1], -across[0]], length: len > 1e-9 ? len : c.width };
}

/** A flat marking rectangle: centre, rotation of its long side (rad, counter-clockwise from east), size. */
export interface MarkingRect {
  centre: Vec3;
  angle: number;
  length: number;
  width: number;
}

export const ZEBRA_STRIPE = 0.5;
export const ZEBRA_GAP = 0.5;
const EDGE_DASH = 0.5;
const EDGE_WIDTH = 0.15;

/**
 * Road markings of a crossing: zebra stripes (0.5 m wide, 0.5 m apart, as long as the crossing is deep)
 * for `zebra`, dashed edge lines for `signal` and `uncontrolled` crossings, nothing for `unmarked`.
 */
export function crossingMarkings(c: Crossing): MarkingRect[] {
  const { origin, across, along, length } = crossingFrame(c);
  const z = (t: number) => origin[2] + (c.geometry[1][2] - origin[2]) * (t / length);
  const at = (t: number, s: number): Vec3 => [origin[0] + across[0] * t + along[0] * s, origin[1] + across[1] * t + along[1] * s, z(t)];
  const out: MarkingRect[] = [];
  if (c.kind === 'zebra') {
    const angle = Math.atan2(along[1], along[0]);
    for (let t = ZEBRA_GAP / 2 + ZEBRA_STRIPE / 2; t + ZEBRA_STRIPE / 2 <= length; t += ZEBRA_STRIPE + ZEBRA_GAP) {
      out.push({ centre: at(t, 0), angle, length: c.depth, width: ZEBRA_STRIPE });
    }
  } else if (c.kind === 'signal' || c.kind === 'uncontrolled') {
    const angle = Math.atan2(across[1], across[0]);
    for (const side of [-1, 1]) {
      for (let t = EDGE_DASH / 2; t + EDGE_DASH / 2 <= length; t += 2 * EDGE_DASH) {
        out.push({ centre: at(t, (side * c.depth) / 2), angle, length: EDGE_DASH, width: EDGE_WIDTH });
      }
    }
  }
  return out;
}

export interface PedestrianView {
  crossing: number;
  position: Vec3;
  /** Walking direction (rad, counter-clockwise from east). */
  heading: number;
  state: number;
}

/** Positions of the pedestrians of a snapshot; entries with an unknown crossing index are skipped. */
export function pedestrianViews(crossings: readonly Crossing[], snapshot: Float32Array): PedestrianView[] {
  const out: PedestrianView[] = [];
  for (let o = 0; o + PEDESTRIAN_STRIDE <= snapshot.length; o += PEDESTRIAN_STRIDE) {
    const index = Math.round(snapshot[o]!);
    const c = crossings[index];
    if (!c) continue;
    const progress = snapshot[o + 1]!;
    const dir = snapshot[o + 2]! >= 0 ? 1 : -1;
    const state = Math.round(snapshot[o + 3]!);
    const slot = Math.round(snapshot[o + 4]!);
    const { origin, across, along, length } = crossingFrame(c);
    // Spread a group along the road (within the crossing); waiting pedestrians queue on the pavement.
    const s = ((slot % 4) - 1.5) * Math.min(0.6, c.depth / 4);
    let t = progress * length;
    if (state === PEDESTRIAN_STATES.waiting) t += (progress < 0.5 ? -1 : 1) * (0.6 + 0.6 * Math.floor(slot / 4));
    const z = origin[2] + (c.geometry[1][2] - origin[2]) * Math.min(1, Math.max(0, t / length));
    out.push({
      crossing: index,
      position: [origin[0] + across[0] * t + along[0] * s, origin[1] + across[1] * t + along[1] * s, z],
      heading: Math.atan2(across[1] * dir, across[0] * dir),
      state,
    });
  }
  return out;
}
