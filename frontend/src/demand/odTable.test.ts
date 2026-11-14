import { describe, expect, it } from 'vitest';
import { fixturePackage } from '../test/demandFixtures';
import type { OdEntry } from './model';
import { DEFAULT_OD_VIEW, odRows, toggleSort } from './odTable';
import { convexHull, zoneShapes, zonesAt } from './zones';

const od: OdEntry[] = [
  { from: 'z2', to: 'ext', vph: 5, curve: 'morningPeak' },
  { from: 'ext', to: 'z10', vph: 20 },
  { from: 'z10', to: 'z2', vph: NaN, curve: 'flat' },
  { from: 'z2', to: 'z10', vph: 5, curve: 'flat' },
];

describe('OD table', () => {
  it('keeps matrix order by default', () => {
    expect(odRows(od, DEFAULT_OD_VIEW)).toEqual([0, 1, 2, 3]);
  });

  it('filters by text and zone', () => {
    expect(odRows(od, { ...DEFAULT_OD_VIEW, query: ' FLAT ' })).toEqual([2, 3]);
    expect(odRows(od, { ...DEFAULT_OD_VIEW, query: 'constant' })).toEqual([1]);
    expect(odRows(od, { ...DEFAULT_OD_VIEW, zone: 'ext' })).toEqual([0, 1]);
  });

  it('sorts by column, stable and numeric-aware', () => {
    expect(odRows(od, { ...DEFAULT_OD_VIEW, sort: 'from' })).toEqual([1, 0, 3, 2]);
    expect(odRows(od, { ...DEFAULT_OD_VIEW, sort: 'to', descending: true })).toEqual([1, 3, 2, 0]);
    expect(odRows(od, { ...DEFAULT_OD_VIEW, sort: 'vph', descending: true })).toEqual([1, 0, 3, 2]);
    expect(odRows(od, { ...DEFAULT_OD_VIEW, sort: 'curve' })).toEqual([1, 2, 3, 0]);
    expect(odRows(od, { ...DEFAULT_OD_VIEW, sort: 'index', descending: true })).toEqual([3, 2, 1, 0]);
  });

  it('toggles the sort on header clicks', () => {
    const byVph = toggleSort(DEFAULT_OD_VIEW, 'vph');
    expect(byVph).toMatchObject({ sort: 'vph', descending: true });
    expect(toggleSort(byVph, 'vph').descending).toBe(false);
    expect(toggleSort(byVph, 'from')).toMatchObject({ sort: 'from', descending: false });
  });
});

describe('zone geometry', () => {
  it('computes convex hulls', () => {
    expect(convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2], [0, 0]])).toEqual([[0, 0], [2, 0], [2, 2], [0, 2]]);
    expect(convexHull([[0, 0], [1, 1]])).toHaveLength(2);
  });

  it('resolves zone links and nodes in the package', () => {
    const pkg = fixturePackage();
    const [a, ext, empty] = zoneShapes(
      [
        { id: 'a', nodes: [], links: ['l1', 'l99'] },
        { id: 'ext', nodes: ['n1', 'n2', 'n5'], links: [] },
        { id: 'empty', nodes: [], links: [] },
      ],
      pkg,
    );
    expect(a!.links).toHaveLength(1);
    expect(a!.missing).toEqual(['l99']);
    expect(a!.center).not.toBeNull();
    expect(ext!.nodes).toHaveLength(3);
    expect(ext!.hull).toHaveLength(3);
    expect(empty!.center).toBeNull();
  });

  it('finds the zones at a picked link or node', () => {
    const zones = [
      { id: 'a', nodes: [], links: ['l1'] },
      { id: 'ext', nodes: ['n1'], links: [] },
    ];
    expect(zonesAt(zones, { linkId: 'l1', nodeIds: ['n1', 'n0'] })).toEqual(['a', 'ext']);
    expect(zonesAt(zones, { nodeIds: ['n0'] })).toEqual([]);
    expect(zonesAt(zones, {})).toEqual([]);
  });
});
