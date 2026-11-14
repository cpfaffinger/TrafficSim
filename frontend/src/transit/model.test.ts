import { describe, expect, it } from 'vitest';
import { parseNetworkPackage } from '../network/parse';
import { aggregate } from '../runs/runStats';
import { loadGoldenFixture } from '../test/goldenFixture';
import { loadTransitFixture, readTransitFixtureJson } from '../test/transitFixture';
import { TRANSIT_KPIS } from './kpis';
import { effectiveHeadway, lineLabel, patchTransit, readTransit, stopPlacements, summaryTransit, transitIssues, transitKpis, TRANSIT_DEFAULTS } from './model';

describe('transit lines in the network package (#85)', () => {
  it('parses the transit fixture', () => {
    const pkg = loadTransitFixture();
    expect(pkg.transitLines).toHaveLength(1);
    const line = pkg.transitLines![0]!;
    expect([line.id, line.ref, line.mode, line.colour, line.headway, line.links]).toEqual(['t0', '13A', 'bus', '#e2001a', 300, ['up', 'down']]);
    expect(line.stops.map((s) => [s.id, s.link, s.pos, s.bay, s.name])).toEqual([
      ['t0s0', 'up', 150, false, 'Kerb stop'],
      ['t0s1', 'down', 200, true, 'Bay stop'],
    ]);
    expect(lineLabel(line)).toBe('13A');
  });

  it('is absent for packages without lines and drops malformed lines and stops', () => {
    expect(loadGoldenFixture().transitLines).toBeUndefined();
    const json = readTransitFixtureJson();
    const raw = (json.transitLines as Record<string, unknown>[])[0]!;
    json.transitLines = [
      { ...raw, id: 'ok', stops: [...(raw.stops as unknown[]), { id: 'x', link: 'elsewhere', pos: 1 }, { id: 'y', link: 'up' }] },
      { ...raw, id: 'unknown-link', links: ['up', 'nowhere'] },
      { ...raw, id: 'no-links', links: [] },
      { links: ['up'] },
      'garbage',
    ];
    const pkg = parseNetworkPackage(json);
    expect(pkg.transitLines!.map((l) => l.id)).toEqual(['ok']);
    expect(pkg.transitLines![0]!.stops.map((s) => s.id)).toEqual(['t0s0', 't0s1']);
  });

  it('places stop markers beside the kerb lane, bays further out', () => {
    const [kerb, bay] = stopPlacements(loadTransitFixture());
    // Eastbound corridor: lane 0 centre at y = -4.875, width 3.25; right of it is south (−y).
    expect(kerb!.base[0]).toBeCloseTo(150);
    expect(kerb!.base[1]).toBeCloseTo(-4.875 - 1.625 - 1.2);
    expect(kerb!.heading).toBeCloseTo(0);
    expect(bay!.base[0]).toBeCloseTo(500);
    expect(bay!.base[1]).toBeCloseTo(-4.875 - 1.625 - 1.2 - 3);
    expect([kerb!.bay, bay!.bay, bay!.name]).toEqual([false, true, 'Bay stop']);
  });
});

describe('transit config keys', () => {
  const line = loadTransitFixture().transitLines![0]!;

  it('reads defaults and merges edits, keeping unknown keys', () => {
    expect(readTransit(undefined)).toEqual(TRANSIT_DEFAULTS);
    const value = { vehicleType: 'articulatedBus', dwellTime: 30, headways: { t0: 120, gone: 60 } };
    const s = readTransit(value);
    expect([s.dwellTime, s.dwellTimeRandom, s.headways]).toEqual([30, 10, { t0: 120, gone: 60 }]);
    const next = patchTransit(value, { enabled: false, headways: { gone: null, t1: 0 } });
    expect(next).toEqual({ vehicleType: 'articulatedBus', dwellTime: 30, enabled: false, headways: { t0: 120, t1: 0 } });
    expect(patchTransit({ headways: { t0: 1 } }, { headways: { t0: null } })).toEqual({});
  });

  it('computes effective headways like sim-core', () => {
    const s = readTransit({});
    expect(effectiveHeadway(line, s)).toBe(300);
    expect(effectiveHeadway(line, readTransit({ headwayFactor: 0.5 }))).toBe(150);
    expect(effectiveHeadway(line, readTransit({ headways: { t0: 90 } }))).toBe(90);
    expect(effectiveHeadway(line, readTransit({ headways: { t0: 0 } }))).toBeNull();
    expect(effectiveHeadway(line, readTransit({ enabled: false }))).toBeNull();
    expect(effectiveHeadway({ ...line, headway: null }, readTransit({ defaultHeadway: 480 }))).toBe(480);
  });

  it('reports what sim-core rejects', () => {
    expect(transitIssues(readTransit({}), [line])).toEqual([]);
    const bad = readTransit({ dwellTime: -1, headwayFactor: 0, defaultHeadway: 0, headways: { t0: -5, t9: 60 } });
    expect(transitIssues(bad, [line])).toHaveLength(5);
    expect(transitIssues(readTransit({ headways: { t9: 60 } }), null)).toEqual([]);
  });
});

describe('transit KPIs of run summaries', () => {
  const summary = {
    transit: [
      { id: 't0', label: '13A', headway: 300, buses: 5, completed: 4, active: 1, meanTravelTime: 100, stops: 2, stopsServed: 8, stopsMissed: 1, meanDwell: 20, observedHeadway: 290, headwayCv: 0.2 },
      { id: 't1', label: null, headway: 600, buses: 1, completed: 1, active: 0, meanTravelTime: 200, stops: 1, stopsServed: 2, stopsMissed: 0, meanDwell: 10, observedHeadway: null, headwayCv: null },
    ],
  };

  it('aggregates over lines', () => {
    expect(summaryTransit(summary)).toHaveLength(2);
    expect(transitKpis(summary)).toEqual({ trips: 5, travelTime: 120, dwell: 18, headwayCv: 0.2, missedStops: 1 });
    expect(transitKpis({ network: {} })).toEqual({ trips: null, travelTime: null, dwell: null, headwayCv: null, missedStops: null });
  });

  it('feeds the runs table only for runs with lines', () => {
    const agg = aggregate([summary, { transit: [] }], TRANSIT_KPIS);
    expect(agg.get('busTrips')).toEqual({ n: 1, mean: 5, sd: 0 });
    expect(aggregate([{ network: {} }], TRANSIT_KPIS).get('busTrips')).toBeNull();
  });
});
