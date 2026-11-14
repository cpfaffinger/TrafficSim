import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CURVES,
  builtinCurve,
  curveNames,
  curveProblem,
  DAY,
  factorAt,
  HOUR,
  hourlyFactors,
  meanFactor,
  newHourlyCurve,
  resolveCurve,
} from './curves';

const repo = (p: string) => readFileSync(path.resolve(process.cwd(), '..', p), 'utf8');

/** Hourly arrays of `TimeProfile::builtin` in sim-core/src/demand.rs, by curve name. */
function rustCurves(): Record<string, number[]> {
  const src = repo('sim-core/src/demand.rs');
  const body = src.slice(src.indexOf('pub fn builtin(name: &str) -> Option<Self>'));
  const out: Record<string, number[]> = {};
  for (const m of body.matchAll(/((?:"\w+"\s*\|?\s*)+)=>\s*&\[([^\]]*)\]/g)) {
    const values = m[2]!.split(',').map((v) => v.trim()).filter(Boolean).map(Number);
    for (const name of m[1]!.matchAll(/"(\w+)"/g)) out[name[1]!] = values;
  }
  return out;
}

describe('built-in curves', () => {
  it('mirror TimeProfile::builtin of the sim core', () => {
    const rust = rustCurves();
    expect(Object.keys(rust).sort()).toEqual([...BUILTIN_CURVES].sort());
    for (const name of BUILTIN_CURVES) expect(builtinCurve(name)!.factors, name).toEqual(rust[name]);
  });

  it('are the curves named in the sim-core README', () => {
    const readme = repo('sim-core/README.md');
    const line = readme.slice(readme.indexOf('Built-in curves (hourly)'), readme.indexOf('Built-in road-class profiles'));
    const named = [...line.matchAll(/`(\w+)`/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(BUILTIN_CURVES));
  });

  it('peak at one and use hourly intervals (flat: one per day)', () => {
    for (const name of BUILTIN_CURVES) expect(Math.max(...builtinCurve(name)!.factors)).toBe(1);
    expect(builtinCurve('flat')).toEqual({ interval: DAY, factors: [1] });
    expect(builtinCurve('weekday')!.interval).toBe(HOUR);
    expect(builtinCurve('commuterIn')).toEqual(builtinCurve('eveningPeak'));
    expect(builtinCurve('rush')).toBeNull();
    expect(builtinCurve('toString')).toBeNull();
  });
});

describe('curve math', () => {
  const twoStep = { interval: 1800, factors: [0, 1] };

  it('resolves custom curves before built-ins', () => {
    const custom = { weekday: { interval: 60, factors: [2] }, mine: twoStep };
    expect(resolveCurve('weekday', custom)!.factors).toEqual([2]);
    expect(resolveCurve('freight', custom)!.interval).toBe(HOUR);
    expect(resolveCurve('mine', custom)).toBe(twoStep);
    expect(resolveCurve('nope', custom)).toBeNull();
    expect(curveNames({ zeta: twoStep, alpha: twoStep, flat: twoStep })).toEqual([...BUILTIN_CURVES, 'alpha', 'zeta']);
  });

  it('reads factors with wrap-around', () => {
    const w = builtinCurve('weekday')!;
    expect(factorAt(w, 7.5 * HOUR)).toBe(0.88);
    expect(factorAt(w, DAY + 17 * HOUR)).toBe(1);
    expect(factorAt(w, -0.5 * HOUR)).toBe(0.18);
    expect(factorAt(twoStep, 2700)).toBe(1);
  });

  it('integrates the mean factor over a window exactly', () => {
    expect(meanFactor(null, 0, 100)).toBe(1);
    expect(meanFactor(twoStep, 0, 3600)).toBe(0.5);
    expect(meanFactor(twoStep, 900, 1800)).toBe(0.5);
    expect(meanFactor(twoStep, 1800, 1800)).toBe(1);
    expect(meanFactor(twoStep, 0, 3600 * 6 + 1800)).toBeCloseTo(6 / 13, 10);
    expect(meanFactor(twoStep, 2000, 0)).toBe(1);
    const w = builtinCurve('weekday')!;
    expect(meanFactor(w, 7 * HOUR, 2 * HOUR)).toBeCloseTo((0.88 + 0.94) / 2, 10);
    expect(meanFactor(w, 23 * HOUR, 2 * HOUR)).toBeCloseTo((0.18 + 0.1) / 2, 10);
  });

  it('gives hourly chart values and new hourly curves', () => {
    expect(hourlyFactors(builtinCurve('morningPeak'))[7]).toBe(1);
    expect(hourlyFactors(twoStep)).toEqual(Array(24).fill(0.5));
    expect(hourlyFactors(null)).toEqual(Array(24).fill(1));
    expect(newHourlyCurve()).toEqual({ interval: HOUR, factors: Array(24).fill(1) });
    expect(newHourlyCurve({ interval: 1800, factors: [0.3333, 0] }).factors[0]).toBe(0.167);
  });

  it('reports invalid custom curves', () => {
    expect(curveProblem(twoStep)).toBeNull();
    expect(curveProblem({ interval: 0, factors: [1] })).toMatch(/interval/);
    expect(curveProblem({ interval: 60, factors: [] })).toMatch(/at least one/);
    expect(curveProblem({ interval: 60, factors: [-1] })).toMatch(/non-negative/);
    expect(curveProblem({ interval: 60, factors: [NaN] })).toMatch(/non-negative/);
    expect(curveProblem({ interval: 60, factors: new Array<number>(100_001).fill(1) })).toMatch(/too many/);
  });
});
