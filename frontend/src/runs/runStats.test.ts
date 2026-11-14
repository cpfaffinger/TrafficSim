import { describe, expect, it } from 'vitest';
import { aggregate, formatStat, RUN_KPIS, stat } from './runStats';

const run = (meanSpeed: number, delayHours: number, tailbacks?: number) => ({
  network: { meanSpeed, delayHours, arrived: 100, meanTravelTime: 120, vehicleKm: 50, stops: 9 },
  ...(tailbacks === undefined ? {} : { events: { tailbacks } }),
});

describe('stat', () => {
  it('computes mean and sample sd', () => {
    expect(stat([])).toBeNull();
    expect(stat([4])).toEqual({ n: 1, mean: 4, sd: 0 });
    const s = stat([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(s.mean).toBe(5);
    expect(s.sd).toBeCloseTo(2.138, 3);
  });
});

describe('aggregate', () => {
  it('aggregates KPIs over runs and converts speed to km/h', () => {
    const agg = aggregate([run(10, 1, 2), run(12, 3), 'garbage']);
    expect(agg.get('meanSpeed')).toEqual({ n: 2, mean: 39.6, sd: expect.closeTo(5.091, 3) as unknown as number });
    expect(agg.get('tailbacks')).toEqual({ n: 1, mean: 2, sd: 0 });
    const speed = RUN_KPIS.find((k) => k.key === 'meanSpeed')!;
    expect(formatStat(agg.get('meanSpeed')!, speed)).toBe('39.6 ± 5.1');
    expect(formatStat(agg.get('tailbacks')!, RUN_KPIS.find((k) => k.key === 'tailbacks')!)).toBe('2');
    expect(formatStat(null, speed)).toBe('–');
  });
});
