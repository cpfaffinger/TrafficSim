import { describe, expect, it } from 'vitest';
import { decodeLaneCells } from '../metrics/laneCells';
import { buildBlob } from '../metrics/testBlob';
import type { NetworkPackage } from '../network/types';
import { cellDelta, layoutFits, linkDeltas, linkKey, meanValues, networkDeltas, sameLayout } from './compare';

const blob = (cells = 3, buckets = 3) => decodeLaneCells(buildBlob({ cells, buckets, first: 0 }));

const link = (id: string, osmWayId: number | null, extra: Record<string, unknown> = {}) =>
  ({ id, osmWayId, name: `Road ${id}`, osmAfterFrom: 1, osmBeforeTo: 2, osmForward: true, lanes: [{ index: 1 }], ...extra }) as never;
const pkg = (links: unknown[]) => ({ links }) as unknown as NetworkPackage;

describe('cell diff', () => {
  it('compares layouts and lane fit', () => {
    expect(sameLayout(blob(), blob())).toBe(true);
    expect(sameLayout(blob(3), blob(4))).toBe(false);
    const b = blob();
    const shifted = { ...b, lanes: [{ ...b.lanes[0]!, laneIndex: 0 }] };
    expect(sameLayout(b, shifted)).toBe(false);
    expect(layoutFits(pkg([link('a', 1), link('b', 2), link('c', 3)]), b.lanes)).toBe(true);
    expect(layoutFits(pkg([link('a', 1)]), b.lanes)).toBe(false);
  });

  it('averages buckets ignoring empty cells and subtracts A from B', () => {
    const b = blob();
    // density 0, 10, 20 → 10; speed ratio NaN, 0.5, 0.5 → 0.5
    expect(meanValues(b, 'density')[0]).toBe(10);
    expect(meanValues(b, 'speedRatio')[1]).toBe(0.5);
    const empty = { ...b, buckets: [] };
    expect(Number.isNaN(meanValues(empty, 'density')[0]!)).toBe(true);
    const later = { ...b, buckets: b.buckets.slice(2) };
    expect(cellDelta(b, later, 'density')[2]).toBe(10);
  });
});

describe('link diff', () => {
  it('matches links by OSM key across differently numbered packages', () => {
    const a = pkg([link('l0', 10), link('l1', 11), link('l2', null)]);
    const b = pkg([link('x', 20), link('l9', 11), link('l7', 10)]);
    const sa = { links: [{ id: 'l0', meanSpeed: 10 }, { id: 'l1', meanSpeed: 5 }, { id: 'l2', meanSpeed: 1 }] };
    const sb = { links: [{ id: 'l7', meanSpeed: 11 }, { id: 'l9', meanSpeed: 2 }, { id: 'x', meanSpeed: 3 }, { id: 'l9', meanSpeed: null }] };
    const d = linkDeltas(a, sa, b, sb, 'meanSpeed');
    expect(d.map((x) => x.name)).toEqual(['Road l9', 'Road l7']);
    expect(d[0]!.delta).toBeCloseTo(-10.8);
    expect(linkKey(link('q', 5, { osmForward: false }))).toBe('5:1:2:b');
  });

  it('reports network KPI changes with a verdict', () => {
    const d = networkDeltas({ network: { meanSpeed: 10, delayHours: 2, stops: 0 } }, { network: { meanSpeed: 12, delayHours: 3, stops: 0 } });
    const by = Object.fromEntries(d.map((k) => [k.key, k]));
    expect(by.meanSpeed!.pct).toBeCloseTo(20);
    expect(by.meanSpeed!.verdict).toBe(1);
    expect(by.delayHours!.verdict).toBe(-1);
    expect(by.stops!.pct).toBeNull();
    expect(by.arrived!.a).toBeNull();
  });
});
