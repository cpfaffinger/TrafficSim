import { describe, expect, it } from 'vitest';
import { scaleDemand } from './demandScale';

const builtin = { motorway: { volumePerLane: 1400, curve: 'weekday' }, residential: { volumePerLane: 60, curve: 'weekday' } };

describe('scaleDemand (#115)', () => {
  it('scales OD, entries, legacy rates, profiles and residential generation', () => {
    const config = {
      startTimeOfDay: 25200,
      od: [{ from: 'a', to: 'b', vph: 10 }, 'odd'],
      entries: { n1: { vph: 100 }, n2: 50 },
      demand: { n3: 20 },
      defaultDemand: 300,
      profiles: { motorway: { volumePerLane: 1000, curve: 'flat' } },
      autoZones: true,
    };

    const out = scaleDemand(config, 1.5, builtin);

    expect(out.od).toEqual([{ from: 'a', to: 'b', vph: 15 }, 'odd']);
    expect(out.entries).toEqual({ n1: { vph: 150 }, n2: 75 });
    expect(out.demand).toEqual({ n3: 30 });
    expect(out.defaultDemand).toBe(450);
    expect(out.profiles).toEqual({ motorway: { volumePerLane: 1500, curve: 'flat' }, residential: { volumePerLane: 90, curve: 'weekday' } });
    expect(out.residential).toEqual({ outboundPerKm: 60, inboundPerKm: 60 });
    expect(out.startTimeOfDay).toBe(25200);
    expect(config.od[0]).toEqual({ from: 'a', to: 'b', vph: 10 }); // input untouched
  });

  it('is the identity for scale 1 and rejects invalid scales', () => {
    expect(scaleDemand({ od: [] }, 1, builtin)).toEqual({ od: [] });
    expect(() => scaleDemand({}, -1, builtin)).toThrow();
    expect(scaleDemand({}, 0.5, builtin).residential).toBeUndefined();
  });
});
