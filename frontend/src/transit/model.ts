/**
 * Public transport lines of a network package (#85, ADR-0019): lenient parsing, stop placement on
 * the map, the `transit` simulation config keys (sim-core README) and run KPIs.
 */
import { rightNormal, stationAt } from '../network/polyline';
import type { Link, NetworkPackage, TransitLine, TransitStop, Vec3 } from '../network/types';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Transit lines of untrusted package JSON. Lines are optional data: malformed lines, lines with
 * unknown links and stops off their line are dropped instead of failing the package.
 */
export function parseTransitLines(value: unknown, links: readonly Link[]): TransitLine[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(links.map((l) => l.id));
  const lines: TransitLine[] = [];
  for (const raw of value) {
    if (!isObject(raw) || !text(raw.id) || !Array.isArray(raw.links)) continue;
    const ids = raw.links.map(text);
    if (ids.length === 0 || ids.some((id) => id === null || !known.has(id))) continue;
    const lineLinks = ids as string[];
    const stops: TransitStop[] = [];
    for (const s of Array.isArray(raw.stops) ? raw.stops : []) {
      if (!isObject(s) || !text(s.id) || !text(s.link) || !lineLinks.includes(s.link as string) || finite(s.pos) === null) continue;
      stops.push({ id: s.id as string, osmId: finite(s.osmId), name: text(s.name), link: s.link as string, pos: s.pos as number, bay: s.bay === true });
    }
    const headway = finite(raw.headway);
    lines.push({
      id: raw.id as string,
      osmId: finite(raw.osmId),
      ref: text(raw.ref),
      name: text(raw.name),
      mode: text(raw.mode) ?? 'bus',
      colour: text(raw.colour),
      headway: headway !== null && headway > 0 ? headway : null,
      links: lineLinks,
      stops,
    });
  }
  return lines;
}

/** Short label of a line: its number, else its name, else its id. */
export const lineLabel = (line: TransitLine): string => line.ref ?? line.name ?? line.id;

/** A stop marker beside the kerb lane. */
export interface StopPlacement {
  stopId: string;
  lineId: string;
  name: string | null;
  /** Foot of the stop pole (ENU). */
  base: Vec3;
  /** Travel direction (radians, counter-clockwise from east). */
  heading: number;
  bay: boolean;
}

export const STOP_KERB_CLEARANCE = 1.2;

/**
 * One marker per stop (stops of several lines at the same place share it): beside the rightmost
 * lane of the stop's link at the stop position, further out for bays.
 */
export function stopPlacements(pkg: NetworkPackage): StopPlacement[] {
  const links = new Map(pkg.links.map((l) => [l.id, l]));
  const out: StopPlacement[] = [];
  const seen = new Set<string>();
  for (const line of pkg.transitLines ?? []) {
    for (const stop of line.stops) {
      const link = links.get(stop.link);
      const lane = link?.lanes.find((l) => l.index === 0) ?? link?.lanes[0];
      if (!link || !lane || lane.geometry.length < 2) continue;
      const key = `${stop.link}@${Math.round(stop.pos)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = link.length > 0 ? (stop.pos * lane.length) / link.length : stop.pos;
      const { point, dir } = stationAt(lane.geometry, s);
      const [nx, ny] = rightNormal(dir);
      const off = lane.width / 2 + STOP_KERB_CLEARANCE + (stop.bay ? 3 : 0);
      out.push({
        stopId: stop.id,
        lineId: line.id,
        name: stop.name,
        base: [point[0] + nx * off, point[1] + ny * off, point[2]],
        heading: Math.atan2(dir[1], dir[0]),
        bay: stop.bay,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ config (`transit` key)

/** The `transit` simulation config keys with sim-core's defaults. */
export interface TransitSettings {
  enabled: boolean;
  /** Headway (s) per line number and direction of lines without one in the package, shared by its variants. */
  defaultHeadway: number;
  headwayFactor: number;
  /** Headway (s) per line id; 0 = out of service. */
  headways: Record<string, number>;
  dwellTime: number;
  dwellTimeRandom: number;
}

export const TRANSIT_DEFAULTS: Readonly<TransitSettings> = {
  enabled: true,
  defaultHeadway: 1200,
  headwayFactor: 1,
  headways: {},
  dwellTime: 15,
  dwellTimeRandom: 10,
};

/** Reads the `transit` value of a scenario config (missing or malformed keys take the defaults). */
export function readTransit(value: unknown): TransitSettings {
  const o = isObject(value) ? value : {};
  const n = (key: keyof TransitSettings) => finite(o[key]) ?? (TRANSIT_DEFAULTS[key] as number);
  const headways = isObject(o.headways)
    ? Object.fromEntries(Object.entries(o.headways).flatMap(([id, h]) => (finite(h) === null ? [] : [[id, h as number]])))
    : {};
  return {
    enabled: o.enabled !== false,
    defaultHeadway: n('defaultHeadway'),
    headwayFactor: n('headwayFactor'),
    headways,
    dwellTime: n('dwellTime'),
    dwellTimeRandom: n('dwellTimeRandom'),
  };
}

/**
 * Merges changes into a scenario's `transit` value, keeping keys the UI does not model; a line
 * headway of `null` removes its override.
 */
export function patchTransit(value: unknown, patch: Partial<Omit<TransitSettings, 'headways'>> & { headways?: Record<string, number | null> }): Json {
  const out: Json = isObject(value) ? { ...value } : {};
  for (const [key, v] of Object.entries(patch)) {
    if (key === 'headways') continue;
    out[key] = v;
  }
  if (patch.headways) {
    const headways: Json = isObject(out.headways) ? { ...out.headways } : {};
    for (const [id, h] of Object.entries(patch.headways)) {
      if (h === null) delete headways[id];
      else headways[id] = h;
    }
    if (Object.keys(headways).length > 0) out.headways = headways;
    else delete out.headways;
  }
  return out;
}

/**
 * Route variants per direction of each line's number (mirrors sim-core): half the lines with the
 * same `ref`, at least 1. OSM maps school, night or short variants as separate routes.
 */
export function lineVariants(lines: readonly TransitLine[]): Map<string, number> {
  const perRef = new Map<string, number>();
  for (const l of lines) if (l.ref !== null) perRef.set(l.ref, (perRef.get(l.ref) ?? 0) + 1);
  return new Map(lines.map((l) => [l.id, l.ref === null ? 1 : Math.ceil((perRef.get(l.ref) ?? 1) / 2)]));
}

/**
 * Effective headway (s) of a line under the settings; null when out of service. Lines without a
 * headway of their own share the default service among their `variants`.
 */
export function effectiveHeadway(line: TransitLine, settings: TransitSettings, variants = 1): number | null {
  if (!settings.enabled) return null;
  const h = settings.headways[line.id] ?? line.headway ?? settings.defaultHeadway * variants;
  return h > 0 ? h * settings.headwayFactor : null;
}

/** Problems of the settings (mirrors sim-core's validation), as messages. */
export function transitIssues(settings: TransitSettings, lines: readonly TransitLine[] | null): string[] {
  const issues: string[] = [];
  if (!(settings.dwellTime >= 0) || !(settings.dwellTimeRandom >= 0)) issues.push('Transit: dwell times must not be negative.');
  if (!(settings.defaultHeadway > 0)) issues.push('Transit: the default headway must be positive.');
  if (!(settings.headwayFactor > 0)) issues.push('Transit: the headway factor must be positive.');
  const ids = lines ? new Set(lines.map((l) => l.id)) : null;
  for (const [id, h] of Object.entries(settings.headways)) {
    if (ids && !ids.has(id)) issues.push(`Transit: headway for unknown line ${id}.`);
    else if (!(h >= 0)) issues.push(`Transit: the headway of line ${id} must not be negative.`);
  }
  return issues;
}

// ------------------------------------------------------------------ run KPIs (summary `transit`)

/** Per-line metrics of a run summary (sim-core `TransitLineMetrics`). */
export interface TransitLineMetrics {
  id: string;
  label: string | null;
  headway: number;
  buses: number;
  completed: number;
  active: number;
  waitingToDepart: number;
  meanTravelTime: number | null;
  stops: number;
  stopsServed: number;
  stopsMissed: number;
  meanDwell: number | null;
  observedHeadway: number | null;
  headwayCv: number | null;
}

/** Transit lines of a run summary (empty for runs without lines). */
export function summaryTransit(summary: unknown): TransitLineMetrics[] {
  if (!isObject(summary) || !Array.isArray(summary.transit)) return [];
  return summary.transit.filter(isObject).map((t) => ({
    id: String(t.id ?? ''),
    label: text(t.label),
    headway: finite(t.headway) ?? 0,
    buses: finite(t.buses) ?? 0,
    completed: finite(t.completed) ?? 0,
    active: finite(t.active) ?? 0,
    waitingToDepart: finite(t.waitingToDepart) ?? 0,
    meanTravelTime: finite(t.meanTravelTime),
    stops: finite(t.stops) ?? 0,
    stopsServed: finite(t.stopsServed) ?? 0,
    stopsMissed: finite(t.stopsMissed) ?? 0,
    meanDwell: finite(t.meanDwell),
    observedHeadway: finite(t.observedHeadway),
    headwayCv: finite(t.headwayCv),
  }));
}

/** Weighted mean of `value` over lines with weight `weight`; null when nothing is weighted. */
function weighted(lines: readonly TransitLineMetrics[], value: (l: TransitLineMetrics) => number | null, weight: (l: TransitLineMetrics) => number): number | null {
  let sum = 0;
  let total = 0;
  for (const l of lines) {
    const v = value(l);
    const w = weight(l);
    if (v === null || w <= 0) continue;
    sum += v * w;
    total += w;
  }
  return total > 0 ? sum / total : null;
}

/** Network-wide transit KPIs of a summary; all null without lines. */
export function transitKpis(summary: unknown): { trips: number | null; travelTime: number | null; dwell: number | null; headwayCv: number | null; missedStops: number | null } {
  const lines = summaryTransit(summary);
  if (lines.length === 0) return { trips: null, travelTime: null, dwell: null, headwayCv: null, missedStops: null };
  return {
    trips: lines.reduce((a, l) => a + l.completed, 0),
    travelTime: weighted(lines, (l) => l.meanTravelTime, (l) => l.completed),
    dwell: weighted(lines, (l) => l.meanDwell, (l) => l.stopsServed),
    headwayCv: weighted(lines, (l) => l.headwayCv, () => 1),
    missedStops: lines.reduce((a, l) => a + l.stopsMissed, 0),
  };
}
