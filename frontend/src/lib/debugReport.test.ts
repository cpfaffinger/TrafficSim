import { describe, expect, it } from 'vitest';
import { loadGoldenFixture } from '../test/goldenFixture';
import { PackageIndex } from '../network/inspect';
import { debugFileName, debugReport, debugSelection, packageExcerpt } from './debugReport';

const index = new PackageIndex(loadGoldenFixture());

describe('debug reports (#129)', () => {
  it('maps the selection to a debug request', () => {
    expect(debugSelection(7, { kind: 'lane', linkId: 'l1', laneIndex: 0 }, index)).toEqual({ kind: 'vehicle', id: '7', lane: -1 });
    expect(debugSelection(null, { kind: 'lane', linkId: 'l1', laneIndex: 1 }, index)).toEqual({ kind: 'lane', id: 'l1', lane: 1 });
    expect(debugSelection(null, { kind: 'link', linkId: 'l1' }, index)).toEqual({ kind: 'link', id: 'l1', lane: -1 });
    const connector = [...index.connectors.values()][0]!;
    expect(debugSelection(null, { kind: 'connector', connectorId: connector.id }, index)).toEqual({ kind: 'node', id: connector.node, lane: -1 });
    expect(debugSelection(null, null, index)).toBeNull();
  });

  it('adds context and the package excerpt', () => {
    const link = [...index.links.values()][0]!;
    const selection = { kind: 'link' as const, id: link.id, lane: -1 };
    const report = debugReport(selection, '{"kind":"link","time":12}', { build: 'abc', baselineId: 'b1', scenario: null, settings: { seed: 1 } }, index);
    expect(report.format).toBe('trafficsim-debug-v1');
    expect(report.simulation).toEqual({ kind: 'link', time: 12 });
    expect((report.package as { link: { id: string } }).link.id).toBe(link.id);
    const node = packageExcerpt({ kind: 'node', id: link.to, lane: -1 }, index) as { connectors: unknown[] };
    expect(node.connectors.length).toBeGreaterThan(0);
    expect(debugFileName({ kind: 'lane', id: 'l3', lane: 1 }, 61.4)).toBe('trafficsim-debug-lane-l3-1-t61.json');
  });
});
