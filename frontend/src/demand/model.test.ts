import { describe, expect, it } from 'vitest';
import { generatedDemand } from '../test/demandFixtures';
import { DEFAULT_START, formatClock, parseClock, parseDemand, serializeDemand, zoneUsage } from './model';

describe('clock times', () => {
  it('parse HH:MM and HH:MM:SS', () => {
    expect(parseClock('07:00')).toBe(25200);
    expect(parseClock(' 6:30:15 ')).toBe(23415);
    for (const bad of ['24:00', '7', '07:60', 'a:b', '07:00:60', '1:2:3:4', '']) expect(parseClock(bad), bad).toBeNull();
  });

  it('format seconds of the day', () => {
    expect(formatClock(23400)).toBe('06:30');
    expect(formatClock(23415)).toBe('06:30:15');
    expect(formatClock(86400 + 60)).toBe('00:01');
    expect(formatClock(-60)).toBe('23:59');
  });
});

describe('parseDemand / serializeDemand', () => {
  it('reads the generated scenario demand', () => {
    const m = parseDemand(generatedDemand('morning'));
    expect(m.startTimeOfDay).toBe(23400);
    expect(m.zones.map((z) => z.id)).toEqual(['z-1_-1', 'z-1_0', 'z0_-1', 'z0_0', 'ext']);
    expect(m.zones[4]!.nodes).toHaveLength(8);
    expect(m.od).toHaveLength(13);
    expect(m.od[0]).toMatchObject({ from: 'z-1_-1', to: 'ext', vph: 2.69, curve: 'morningPeak' });
    expect(m.od[0]!.driverMix).toEqual({ commuter: 5, average: 3, attentive: 1, distracted: 0.5, aggressive: 0.5 });
    expect(m.vehicleMix).toMatchObject({ car: 0.85 });
    expect(m.rest).toEqual({ autoEntries: true, autoZones: false });
    expect(zoneUsage(m, 'ext')).toBeGreaterThan(0);
    expect(zoneUsage(m, 'nope')).toBe(0);
  });

  it('round-trips generated scenarios unchanged', () => {
    for (const key of ['morning', 'saturday', 'stress', 'freight']) {
      const raw = generatedDemand(key);
      expect(serializeDemand(parseDemand(raw)), key).toEqual(raw);
    }
  });

  it('defaults an empty demand and writes only what is set', () => {
    for (const raw of [null, undefined, 'x', []]) {
      const m = parseDemand(raw);
      expect(m.startTimeOfDay).toBe(DEFAULT_START);
      expect(serializeDemand(m)).toEqual({ startTimeOfDay: DEFAULT_START });
    }
  });

  it('keeps emptied keys that were present', () => {
    const m = parseDemand({ od: [], zones: [], entries: {}, profiles: {}, curves: {} });
    expect(serializeDemand(m)).toEqual({ startTimeOfDay: DEFAULT_START, od: [], zones: [], entries: {}, profiles: {}, curves: {} });
  });

  it('accepts every sim-core input shape', () => {
    const m = parseDemand({
      startTimeOfDay: '08:15',
      zones: { west: { nodes: ['n1'] }, east: { links: ['l2'] }, odd: 5 },
      od: [{ from: 'west', to: 'east', vph: '12', curve: '' }, 7],
      entries: { n1: 900, n3: { vph: 200, curve: 'morningPeak' }, n5: { vph: 10 } },
      profiles: { motorway: { volumePerLane: 1000 }, primary: { curve: 'flat' }, bad: 1 },
      curves: { mine: { interval: 900, factors: [1, '2'] }, broken: 3 },
      vehicleMix: { car: 1 },
      driverMix: 'x',
    });
    expect(m.startTimeOfDay).toBe(29700);
    expect(m.zones).toEqual([
      { id: 'west', nodes: ['n1'], links: [] },
      { id: 'east', nodes: [], links: ['l2'] },
      { id: 'odd', nodes: [], links: [] },
    ]);
    expect(m.od[0]).toEqual({ from: 'west', to: 'east', vph: 12 });
    expect(m.od[1]).toEqual({ from: '', to: '', vph: NaN });
    expect(m.entries).toEqual({ n1: { vph: 900 }, n3: { vph: 200, curve: 'morningPeak' }, n5: { vph: 10 } });
    expect(m.profiles).toEqual({ motorway: { volumePerLane: 1000 }, primary: { curve: 'flat' }, bad: {} });
    expect(m.curves).toEqual({ mine: { interval: 900, factors: [1, 2] }, broken: { interval: NaN, factors: [] } });
    expect(m.driverMix).toBeNull();
    const out = serializeDemand(m);
    expect(out.entries).toEqual({ n1: 900, n3: { vph: 200, curve: 'morningPeak' }, n5: 10 });
    expect(out.zones).toEqual([{ id: 'west', nodes: ['n1'] }, { id: 'east', links: ['l2'] }, { id: 'odd' }]);
    expect(out).not.toHaveProperty('driverMix');
    expect(parseDemand({ startTimeOfDay: 'noon' }).startTimeOfDay).toBeNaN();
    expect(parseDemand({ startTimeOfDay: null }).startTimeOfDay).toBe(DEFAULT_START);
  });
});
