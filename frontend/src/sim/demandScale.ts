/**
 * Scales a sim-core demand configuration (sim-core/README.md) by a factor (#115): OD and entry rates,
 * road-class profile volumes (built-ins included, so the default boundary demand scales too) and
 * residential generation rates.
 */
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const scaleNumber = (v: unknown, s: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * s * 100) / 100 : v);

/** Default residential rates of the sim core (veh/h per km of residential street). */
export const DEFAULT_RESIDENTIAL_PER_KM = 40;

export function scaleDemand(config: Json, scale: number, builtinProfiles: Record<string, { volumePerLane: number; curve?: string }>): Json {
  if (!Number.isFinite(scale) || scale < 0) throw new Error('Demand scale must be a non-negative number.');
  const out: Json = structuredClone(config);
  if (scale === 1) return out;

  if (Array.isArray(out.od)) {
    out.od = out.od.map((e) => (isObject(e) ? { ...e, vph: scaleNumber(e.vph, scale) } : e));
  }
  if (isObject(out.entries)) {
    out.entries = Object.fromEntries(
      Object.entries(out.entries).map(([k, v]) => [k, isObject(v) ? { ...v, vph: scaleNumber(v.vph, scale) } : scaleNumber(v, scale)]),
    );
  }
  if (isObject(out.demand)) {
    out.demand = Object.fromEntries(Object.entries(out.demand).map(([k, v]) => [k, scaleNumber(v, scale)]));
  }
  if ('defaultDemand' in out) out.defaultDemand = scaleNumber(out.defaultDemand, scale);

  const profiles: Json = isObject(out.profiles) ? { ...out.profiles } : {};
  for (const [cls, builtin] of Object.entries(builtinProfiles)) {
    const current = isObject(profiles[cls]) ? (profiles[cls] as Json) : { ...builtin };
    profiles[cls] = { ...current, volumePerLane: scaleNumber(current.volumePerLane ?? builtin.volumePerLane, scale) };
  }
  out.profiles = profiles;

  if (out.autoZones === true) {
    const r: Json = isObject(out.residential) ? { ...out.residential } : {};
    r.outboundPerKm = scaleNumber(r.outboundPerKm ?? DEFAULT_RESIDENTIAL_PER_KM, scale);
    r.inboundPerKm = scaleNumber(r.inboundPerKm ?? DEFAULT_RESIDENTIAL_PER_KM, scale);
    out.residential = r;
  }
  return out;
}
