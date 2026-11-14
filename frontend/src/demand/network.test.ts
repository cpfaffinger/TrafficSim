import { describe, expect, it } from 'vitest';
import { fixturePackage, generatedDemand } from '../test/demandFixtures';
import { FALLBACK_BUILTINS } from './builtins';
import { meanFactor, builtinCurve } from './curves';
import { parseDemand } from './model';
import { autoEntries, boundaryEntries, effectiveProfile, residentialDemand } from './network';
import { demandTotals } from './totals';

const pkg = fixturePackage();
const b = FALLBACK_BUILTINS;

describe('boundary entries', () => {
  it('derive road-class defaults per entry node (Σ volume per lane × lanes)', () => {
    const entries = boundaryEntries(pkg, parseDemand(null), b);
    expect(entries.map((e) => e.node)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n7']);
    const n1 = entries[0]!;
    expect(n1.links).toEqual([{ id: 'l1', roadClass: 'primary', lanes: 2 }]);
    expect(n1).toMatchObject({ defaultVph: 1200, defaultCurve: 'weekday', vph: 1200, curve: 'weekday', source: 'profile' });
    expect(entries.find((e) => e.node === 'n5')).toMatchObject({ vph: 2800, source: 'profile' });
    expect(entries.find((e) => e.node === 'n3')).toMatchObject({ vph: 60 });
  });

  it('apply overrides with the sim-core precedence', () => {
    const m = parseDemand({
      entries: { n1: { vph: 300, curve: 'flat' }, n2: 50 },
      demand: { n2: 999, n3: 70 },
      profiles: { residential: { volumePerLane: 100, curve: 'freight' } },
    });
    const e = Object.fromEntries(boundaryEntries(pkg, m, b).map((x) => [x.node, x]));
    expect(e.n1).toMatchObject({ vph: 300, curve: 'flat', source: 'entry' });
    expect(e.n2).toMatchObject({ vph: 50, curve: null, source: 'entry' });
    expect(e.n3).toMatchObject({ vph: 70, source: 'legacy' });
    expect(e.n4).toMatchObject({ vph: 100, curve: 'freight', defaultVph: 100 });
    const uniform = boundaryEntries(pkg, parseDemand({ defaultDemand: 40, demandCurve: 'flat' }), b);
    expect(uniform.every((x) => x.vph === 40 && x.source === 'uniform' && x.curve === 'flat')).toBe(true);
  });

  it('are off without autoEntries when an OD matrix exists', () => {
    const withOd = parseDemand({ zones: [{ id: 'a', nodes: ['n1'] }], od: [{ from: 'a', to: 'a', vph: 1 }] });
    expect(autoEntries(withOd)).toBe(false);
    expect(boundaryEntries(pkg, withOd, b).every((x) => x.vph === 0 && x.source === 'off')).toBe(true);
    expect(autoEntries(parseDemand(generatedDemand()))).toBe(true);
  });

  it('patch road-class profiles; unknown classes use the unknown profile', () => {
    const m = parseDemand({ profiles: { unknown: { volumePerLane: 5 } } });
    expect(effectiveProfile(m, b, 'track')).toEqual({ volumePerLane: 5, curve: 'weekday' });
    expect(effectiveProfile(m, b, 'primary')).toEqual({ volumePerLane: 600, curve: 'weekday' });
  });
});

describe('residential demand and totals', () => {
  it('is off unless autoZones and sums residential link lengths', () => {
    expect(residentialDemand(pkg, parseDemand(null))).toBeNull();
    const km = pkg.links.filter((l) => l.roadClass === 'residential').reduce((a, l) => a + l.length, 0) / 1000;
    expect(residentialDemand(pkg, parseDemand({ autoZones: true }))).toEqual({
      km,
      outboundPerKm: 40,
      inboundPerKm: 40,
      outboundCurve: 'commuterOut',
      inboundCurve: 'commuterIn',
    });
    const custom = residentialDemand(pkg, parseDemand({ autoZones: true, residential: { classes: ['primary'], outboundPerKm: 10, inboundCurve: 'flat' } }))!;
    expect(custom).toMatchObject({ outboundPerKm: 10, inboundPerKm: 40, inboundCurve: 'flat' });
    expect(custom.km).toBeGreaterThan(0);
  });

  it('total vehicles per hour per process kind, at peak and over the window', () => {
    const m = parseDemand(generatedDemand('morning'));
    const totals = demandTotals(m, 3 * 3600, b, pkg);
    expect(totals.map((t) => t.kind)).toEqual(['boundary', 'od']);
    const od = totals[1]!;
    expect(od.count).toBe(13);
    expect(od.peakVph).toBeCloseTo(m.od.reduce((a, e) => a + e.vph, 0), 9);
    const boundary = totals[0]!;
    expect(boundary.peakVph).toBe(1200 * 2 + 60 * 2 + 2800 * 2);
    expect(boundary.meanVph).toBeCloseTo(boundary.peakVph * meanFactor(builtinCurve('weekday'), 23400, 3 * 3600), 6);

    const res = demandTotals(parseDemand({ autoZones: true, od: [{ from: 'a', to: 'b', vph: -1, curve: 'nope' }] }), 3600, b, pkg);
    expect(res.map((t) => t.kind)).toEqual(['boundary', 'od', 'residentialOut', 'residentialIn']);
    expect(res[1]).toMatchObject({ peakVph: 0, meanVph: 0 });
    expect(res[2]!.peakVph).toBeGreaterThan(0);
    expect(demandTotals(parseDemand({ od: [{ from: 'a', to: 'b', vph: 10 }] }), 3600, b, null)).toEqual([
      { kind: 'od', count: 1, peakVph: 10, meanVph: 10 },
    ]);
  });
});
