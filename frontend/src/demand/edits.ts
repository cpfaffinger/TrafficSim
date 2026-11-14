/** Immutable edits of a {@link DemandModel} (each returns a new model). */
import { isBuiltinCurve, type TimeCurve } from './curves';
import type { DemandModel, EntryOverride, Mix, OdEntry, ProfilePatch } from './model';

export const setStartTime = (m: DemandModel, seconds: number): DemandModel => ({ ...m, startTimeOfDay: seconds });

export function updateOd(m: DemandModel, index: number, patch: Partial<OdEntry>): DemandModel {
  return {
    ...m,
    od: m.od.map((e, i) => {
      if (i !== index) return e;
      const next: OdEntry = { ...e, ...patch };
      for (const k of ['curve', 'vehicleMix', 'driverMix'] as const) if (k in patch && patch[k] === undefined) delete next[k];
      return next;
    }),
  };
}

export const addOd = (m: DemandModel, entry: OdEntry): DemandModel => ({ ...m, od: [...m.od, entry] });

export const removeOd = (m: DemandModel, index: number): DemandModel => ({ ...m, od: m.od.filter((_, i) => i !== index) });

/** A new OD entry between the first two zones (or within the only one). */
export function newOdEntry(m: DemandModel, from?: string): OdEntry {
  const ids = m.zones.map((z) => z.id);
  const origin = from ?? ids[0] ?? '';
  const to = ids.find((z) => z !== origin) ?? origin;
  return { from: origin, to, vph: 0, curve: 'flat' };
}

/** Sets (or with null removes, back to the road-class default) the override of an entry node. */
export function setEntry(m: DemandModel, node: string, override: EntryOverride | null): DemandModel {
  const entries = { ...m.entries };
  if (override) entries[node] = override.curve ? override : { vph: override.vph };
  else delete entries[node];
  return { ...m, entries };
}

/** Patches a road-class profile; fields equal to the built-in default are dropped, empty patches removed. */
export function setProfile(m: DemandModel, roadClass: string, patch: ProfilePatch, builtin: { volumePerLane: number; curve: string }): DemandModel {
  const merged: ProfilePatch = { ...m.profiles[roadClass], ...patch };
  const clean: ProfilePatch = {};
  if (merged.volumePerLane !== undefined && merged.volumePerLane !== builtin.volumePerLane) clean.volumePerLane = merged.volumePerLane;
  if (merged.curve !== undefined && merged.curve !== builtin.curve) clean.curve = merged.curve;
  const profiles = { ...m.profiles };
  if (Object.keys(clean).length) profiles[roadClass] = clean;
  else delete profiles[roadClass];
  return { ...m, profiles };
}

export const resetProfiles = (m: DemandModel): DemandModel => ({ ...m, profiles: {} });

export function setCurve(m: DemandModel, name: string, curve: TimeCurve | null): DemandModel {
  const curves = { ...m.curves };
  if (curve) curves[name] = curve;
  else delete curves[name];
  return { ...m, curves };
}

/** First free name `custom1`, `custom2`, … */
export function freeCurveName(m: DemandModel, base = 'custom'): string {
  for (let n = 1; ; n++) if (!(`${base}${n}` in m.curves) && !isBuiltinCurve(`${base}${n}`)) return `${base}${n}`;
}

/** Renames a custom curve and every reference to it (OD, entries, profiles, residential). */
export function renameCurve(m: DemandModel, from: string, to: string): DemandModel {
  if (from === to || !(from in m.curves)) return m;
  const swap = <T extends { curve?: string }>(x: T): T => (x.curve === from ? { ...x, curve: to } : x);
  const curves = Object.fromEntries(Object.entries(m.curves).map(([k, c]) => [k === from ? to : k, c]));
  const rest = { ...m.rest };
  const r = rest.residential;
  if (typeof r === 'object' && r !== null && !Array.isArray(r)) {
    const res = { ...(r as Record<string, unknown>) };
    for (const k of ['outboundCurve', 'inboundCurve']) if (res[k] === from) res[k] = to;
    rest.residential = res;
  }
  if (rest.demandCurve === from) rest.demandCurve = to;
  return {
    ...m,
    curves,
    rest,
    od: m.od.map(swap),
    entries: Object.fromEntries(Object.entries(m.entries).map(([k, e]) => [k, swap(e)])),
    profiles: Object.fromEntries(Object.entries(m.profiles).map(([k, p]) => [k, swap(p)])),
  };
}

/** Number of references to a curve name in the configuration. */
export function curveUsage(m: DemandModel, name: string): number {
  const r = m.rest.residential as Record<string, unknown> | undefined;
  return (
    m.od.filter((e) => e.curve === name).length +
    Object.values(m.entries).filter((e) => e.curve === name).length +
    Object.values(m.profiles).filter((p) => p.curve === name).length +
    (m.rest.demandCurve === name ? 1 : 0) +
    (r && typeof r === 'object' ? ['outboundCurve', 'inboundCurve'].filter((k) => r[k] === name).length : 0)
  );
}

export type MixKind = 'vehicleMix' | 'driverMix';

export const setMix = (m: DemandModel, kind: MixKind, mix: Mix | null): DemandModel => ({ ...m, [kind]: mix });

/** Sets one share of a mix (0 keeps the name listed; the sim core normalises the weights). */
export const setShare = (mix: Mix | null, name: string, share: number): Mix => ({ ...mix, [name]: share });

/**
 * Sets one entry to `percent` % and rescales the others proportionally so that the shares sum to
 * 100 % (equal split when the others are all zero). Result in fractions, 4 decimals.
 */
export function setSharePercent(mix: Mix | null, names: readonly string[], name: string, percent: number): Mix {
  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0)) / 100;
  const current = normalizeMix(mix);
  const others = [...new Set([...names, ...Object.keys(mix ?? {})])].filter((n) => n !== name);
  const rest = others.reduce((a, n) => a + (current[n] ?? 0), 0);
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
  const out: Mix = {};
  for (const n of others) {
    const share = rest > 0 ? ((current[n] ?? 0) / rest) * (1 - p) : (1 - p) / others.length;
    if (share > 0 || (mix && n in mix)) out[n] = round(share);
  }
  out[name] = round(p);
  return out;
}

/** Shares normalised to fractions (for display); empty or all-zero mixes give {}. */
export function normalizeMix(mix: Mix | null | undefined): Mix {
  if (!mix) return {};
  const sum = Object.values(mix).reduce((a, s) => a + (Number.isFinite(s) && s > 0 ? s : 0), 0);
  if (!(sum > 0)) return {};
  return Object.fromEntries(Object.entries(mix).map(([k, s]) => [k, Number.isFinite(s) && s > 0 ? s / sum : 0]));
}
