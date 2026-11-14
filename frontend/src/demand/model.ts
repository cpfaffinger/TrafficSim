/**
 * Editable view of a scenario's demand configuration (sim-core/README.md "Configuration" and
 * "Demand"; generated per scenario by the backend, docs/architecture/fixtures/generated-demand-v1.json).
 * Keys the editor does not model are carried through unchanged.
 */
import { DAY, type TimeCurve } from './curves';

export type Mix = Record<string, number>;

export interface Zone {
  id: string;
  nodes: string[];
  links: string[];
}

export interface OdEntry {
  from: string;
  to: string;
  vph: number;
  /** Time-of-day curve; constant when absent. */
  curve?: string;
  vehicleMix?: Mix;
  driverMix?: Mix;
}

/** Explicit demand of a boundary entry node (overrides the road-class default). */
export interface EntryOverride {
  vph: number;
  curve?: string;
}

export interface ProfilePatch {
  volumePerLane?: number;
  curve?: string;
}

export interface DemandModel {
  /** Seconds since midnight. */
  startTimeOfDay: number;
  zones: Zone[];
  od: OdEntry[];
  entries: Record<string, EntryOverride>;
  profiles: Record<string, ProfilePatch>;
  curves: Record<string, TimeCurve>;
  vehicleMix: Mix | null;
  driverMix: Mix | null;
  /** All other keys of the configuration, untouched (autoEntries, autoZones, residential, …). */
  rest: Record<string, unknown>;
  /** Modelled keys present in the source (kept even when emptied). */
  present: ReadonlySet<string>;
}

type Json = Record<string, unknown>;

const MODELLED = ['startTimeOfDay', 'zones', 'od', 'entries', 'profiles', 'curves', 'vehicleMix', 'driverMix'] as const;
export const DEFAULT_START = 7 * 3600;

export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** `"HH:MM"` / `"HH:MM:SS"` → seconds; null when malformed. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d{1,2}$/.test(p))) return null;
  const [h, m, s = 0] = parts.map(Number) as [number, number, number?];
  if (h >= 24 || m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}

/** Seconds since midnight → `"HH:MM"` (with `:SS` when not on a minute). */
export function formatClock(seconds: number): string {
  const t = ((Math.round(seconds) % DAY) + DAY) % DAY;
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}`;
  return t % 60 ? `${base}:${pad(t % 60)}` : base;
}

function parseStart(v: unknown): number {
  if (typeof v === 'string') return parseClock(v) ?? NaN;
  if (v === undefined || v === null) return DEFAULT_START;
  return num(v);
}

function parseMix(v: unknown): Mix | null {
  if (!isObject(v)) return null;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, num(x)]));
}

function parseZones(v: unknown): Zone[] {
  const one = (id: string, z: unknown): Zone => {
    const o = isObject(z) ? z : {};
    return { id, nodes: strings(o.nodes), links: strings(o.links) };
  };
  if (Array.isArray(v)) return v.map((z) => one(isObject(z) ? String(z.id ?? '') : '', z));
  if (isObject(v)) return Object.entries(v).map(([id, z]) => one(id, z));
  return [];
}

function parseOd(v: unknown): OdEntry[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const e = isObject(raw) ? raw : {};
    const out: OdEntry = { from: String(e.from ?? ''), to: String(e.to ?? ''), vph: num(e.vph) };
    const curve = str(e.curve);
    if (curve) out.curve = curve;
    const vm = parseMix(e.vehicleMix);
    if (vm) out.vehicleMix = vm;
    const dm = parseMix(e.driverMix);
    if (dm) out.driverMix = dm;
    return out;
  });
}

function parseEntries(v: unknown): Record<string, EntryOverride> {
  if (!isObject(v)) return {};
  return Object.fromEntries(
    Object.entries(v).map(([node, e]) => {
      if (!isObject(e)) return [node, { vph: num(e) }];
      const curve = str(e.curve);
      return [node, curve ? { vph: num(e.vph), curve } : { vph: num(e.vph) }];
    }),
  );
}

function parseProfiles(v: unknown): Record<string, ProfilePatch> {
  if (!isObject(v)) return {};
  return Object.fromEntries(
    Object.entries(v).map(([cls, p]) => {
      const o = isObject(p) ? p : {};
      const patch: ProfilePatch = {};
      if (o.volumePerLane !== undefined) patch.volumePerLane = num(o.volumePerLane);
      const curve = str(o.curve);
      if (curve) patch.curve = curve;
      return [cls, patch];
    }),
  );
}

function parseCurves(v: unknown): Record<string, TimeCurve> {
  if (!isObject(v)) return {};
  return Object.fromEntries(
    Object.entries(v).map(([name, c]) => {
      const o = isObject(c) ? c : {};
      return [name, { interval: num(o.interval), factors: Array.isArray(o.factors) ? o.factors.map(num) : [] }];
    }),
  );
}

/** Reads a scenario's opaque demand value (null/absent = sim-core defaults). */
export function parseDemand(raw: unknown): DemandModel {
  const src: Json = isObject(raw) ? raw : {};
  const rest = Object.fromEntries(Object.entries(src).filter(([k]) => !(MODELLED as readonly string[]).includes(k)));
  return {
    startTimeOfDay: parseStart(src.startTimeOfDay),
    zones: parseZones(src.zones),
    od: parseOd(src.od),
    entries: parseEntries(src.entries),
    profiles: parseProfiles(src.profiles),
    curves: parseCurves(src.curves),
    vehicleMix: parseMix(src.vehicleMix),
    driverMix: parseMix(src.driverMix),
    rest,
    present: new Set(MODELLED.filter((k) => k in src)),
  };
}

const entryJson = (e: EntryOverride): unknown => (e.curve ? { vph: e.vph, curve: e.curve } : e.vph);

/** Configuration JSON for `updateScenario(id, { demand })`. */
export function serializeDemand(m: DemandModel): Json {
  const out: Json = { ...m.rest, startTimeOfDay: m.startTimeOfDay };
  const put = (key: (typeof MODELLED)[number], value: unknown, empty: boolean) => {
    if (!empty || m.present.has(key)) out[key] = value;
  };
  put('curves', m.curves, Object.keys(m.curves).length === 0);
  put('profiles', m.profiles, Object.keys(m.profiles).length === 0);
  put('entries', Object.fromEntries(Object.entries(m.entries).map(([k, e]) => [k, entryJson(e)])), Object.keys(m.entries).length === 0);
  if (m.vehicleMix) out.vehicleMix = m.vehicleMix;
  if (m.driverMix) out.driverMix = m.driverMix;
  put(
    'zones',
    m.zones.map((z) => ({ id: z.id, ...(z.nodes.length ? { nodes: z.nodes } : {}), ...(z.links.length ? { links: z.links } : {}) })),
    m.zones.length === 0,
  );
  put('od', m.od, m.od.length === 0);
  return out;
}

/** Number of OD entries using the zone as origin or destination. */
export function zoneUsage(m: DemandModel, zoneId: string): number {
  return m.od.filter((e) => e.from === zoneId || e.to === zoneId).length;
}
