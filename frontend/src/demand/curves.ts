/**
 * Time-of-day curves of the demand model (sim-core/README.md "Demand", #53): piecewise constant
 * factors per `interval` seconds, repeating with period `interval × factors.length`. The built-in
 * curves mirror `TimeProfile::builtin` in sim-core/src/demand.rs (kept in sync by a test).
 */

export const DAY = 86_400;
export const HOUR = 3_600;

export interface TimeCurve {
  /** Length of one factor interval in seconds. */
  interval: number;
  factors: number[];
}

const HOURLY: Readonly<Record<string, readonly number[]>> = {
  flat: [1],
  weekday: [
    0.1, 0.06, 0.05, 0.05, 0.08, 0.19, 0.48, 0.88, 0.94, 0.7, 0.63, 0.65, 0.7, 0.7, 0.73, 0.83, 0.95, 1.0, 0.83, 0.6, 0.45, 0.35, 0.28,
    0.18,
  ],
  morningPeak: [
    0.05, 0.03, 0.02, 0.02, 0.05, 0.2, 0.6, 1.0, 0.9, 0.45, 0.3, 0.3, 0.3, 0.3, 0.3, 0.35, 0.4, 0.4, 0.3, 0.2, 0.15, 0.1, 0.08, 0.06,
  ],
  eveningPeak: [
    0.06, 0.04, 0.03, 0.03, 0.04, 0.08, 0.15, 0.3, 0.35, 0.3, 0.3, 0.32, 0.35, 0.35, 0.4, 0.6, 0.9, 1.0, 0.7, 0.45, 0.3, 0.2, 0.12, 0.08,
  ],
  freight: [
    0.3, 0.25, 0.25, 0.3, 0.45, 0.7, 0.85, 0.95, 1.0, 1.0, 1.0, 0.95, 0.9, 0.95, 0.95, 0.9, 0.85, 0.75, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3,
  ],
};

const ALIASES: Readonly<Record<string, string>> = { commuterOut: 'morningPeak', commuterIn: 'eveningPeak' };

/** Names of the built-in curves, in sim-core order. */
export const BUILTIN_CURVES = ['flat', 'weekday', 'morningPeak', 'eveningPeak', 'commuterOut', 'commuterIn', 'freight'] as const;

export const isBuiltinCurve = (name: string): boolean => (BUILTIN_CURVES as readonly string[]).includes(name);

/** A built-in curve (hourly factors, peak hour = 1; `flat` is one factor per day). */
export function builtinCurve(name: string): TimeCurve | null {
  const hourly = HOURLY[ALIASES[name] ?? name];
  if (!hourly || !isBuiltinCurve(name)) return null;
  return { interval: hourly.length === 1 ? DAY : HOUR, factors: [...hourly] };
}

/** Custom curves first, then built-ins (sim-core `resolve_profile`). */
export function resolveCurve(name: string, custom: Readonly<Record<string, TimeCurve>>): TimeCurve | null {
  return Object.hasOwn(custom, name) ? custom[name]! : builtinCurve(name);
}

/** All curve names usable in the configuration: built-ins, then custom ones not shadowing a built-in. */
export function curveNames(custom: Readonly<Record<string, TimeCurve>>): string[] {
  return [...BUILTIN_CURVES, ...Object.keys(custom).filter((n) => !isBuiltinCurve(n)).sort()];
}

const period = (c: TimeCurve) => c.interval * c.factors.length;

/** Factor at time of day `tod` (seconds; wraps with the period). */
export function factorAt(curve: TimeCurve, tod: number): number {
  const p = period(curve);
  const t = ((tod % p) + p) % p;
  return curve.factors[Math.min(Math.floor(t / curve.interval), curve.factors.length - 1)]!;
}

/** Integral of the factor from 0 to `t` (seconds), for any `t ≥ 0`. */
function work(curve: TimeCurve, t: number): number {
  const p = period(curve);
  const whole = Math.floor(t / p);
  const total = curve.factors.reduce((a, f) => a + f, 0) * curve.interval;
  let rest = t - whole * p;
  let sum = whole * total;
  for (const f of curve.factors) {
    if (rest <= 0) break;
    const span = Math.min(rest, curve.interval);
    sum += f * span;
    rest -= span;
  }
  return sum;
}

/** Mean factor over `[start, start + duration)` (exact for piecewise constant curves); null = constant 1. */
export function meanFactor(curve: TimeCurve | null, start: number, duration: number): number {
  if (!curve) return 1;
  if (!(duration > 0)) return factorAt(curve, start);
  const p = period(curve);
  const s = ((start % p) + p) % p;
  return (work(curve, s + duration) - work(curve, s)) / duration;
}

/** 24 hourly values for charts: the mean factor of each hour of the day. */
export function hourlyFactors(curve: TimeCurve | null): number[] {
  return Array.from({ length: 24 }, (_, h) => meanFactor(curve, h * HOUR, HOUR));
}

/** A new custom curve: 24 hourly factors copied from `base` (default flat). */
export function newHourlyCurve(base: TimeCurve | null = null): TimeCurve {
  return { interval: HOUR, factors: hourlyFactors(base).map((f) => Math.round(f * 1000) / 1000) };
}

/** Problem of a custom curve definition, or null when the sim core accepts it. */
export function curveProblem(curve: TimeCurve): string | null {
  if (!(Number.isFinite(curve.interval) && curve.interval >= 1)) return 'interval must be at least 1 s';
  if (curve.factors.length === 0) return 'needs at least one factor';
  if (curve.factors.length > 100_000) return 'has too many factors';
  if (!curve.factors.every((f) => Number.isFinite(f) && f >= 0)) return 'factors must be non-negative numbers';
  return null;
}
