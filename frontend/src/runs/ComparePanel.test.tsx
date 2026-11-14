// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary, Scenario } from '../api/scenarioClient';
import { buildBlob } from '../metrics/testBlob';
import { parseNetworkPackage } from '../network/parse';
import { ComparePanel, pickPair, type CompareApi } from './ComparePanel';

afterEach(cleanup);

const raw: unknown = JSON.parse(readFileSync(path.resolve(process.cwd(), '../docs/architecture/fixtures/network-package-v1.json'), 'utf8'));
const pkg = parseNetworkPackage(raw);
const firstLink = pkg.links[0]!;

const scenario = (id: string, name: string) => ({ id, name }) as Scenario;
const run = (id: string, scenarioId: string, meanSpeed: number, linkSpeed: number): RunSummary => ({
  id,
  scenarioId,
  seed: 1,
  simulatedSeconds: 600,
  summary: { network: { meanSpeed, delayHours: 2 }, links: [{ id: firstLink.id, meanSpeed: linkSpeed }] },
  bucketFormat: 'lane-cells-v1',
  createdAt: '2026-11-14T10:00:00Z',
});

const api = (over: Partial<CompareApi> = {}): CompareApi => ({
  listScenarios: vi.fn().mockResolvedValue([scenario('s1', 'Base'), scenario('s2', 'Variant')]),
  listRuns: vi.fn((id: string) => Promise.resolve(id === 's1' ? [run('ra', 's1', 10, 10)] : [run('rb', 's2', 12, 8)])),
  getRunBuckets: vi.fn().mockResolvedValue(buildBlob({ cells: 3, buckets: 2, first: 0 })),
  getScenarioPackage: vi.fn().mockResolvedValue({ pkg: raw, issues: [] }),
  ...over,
});

describe('ComparePanel', () => {
  it('draws a cell diff when both runs share the lane layout', async () => {
    const onDiff = vi.fn();
    render(<ComparePanel api={api()} baselineId="b1" pkg={pkg} onDiff={onDiff} />);
    fireEvent.click(await screen.findByText('Compare'));
    await screen.findByText(/blue = better in B/);
    const diff = onDiff.mock.calls.map((c) => c[0] as { label: string } | null).find((d) => d !== null)!;
    expect(diff.label).toMatch(/^Variant · seed 1 .* vs Base/);
    expect(screen.getByText(/36.0 → 43.2 km\/h \(\+20.0 %\)/)).toBeTruthy();
    expect(screen.getByText('Mean speed').closest('tr')!.className).toBe('better');
  });

  it('falls back to per-link deltas when the layouts differ', async () => {
    let n = 0;
    const a = api({ getRunBuckets: vi.fn(() => Promise.resolve(buildBlob({ cells: 3 + n++, buckets: 1, first: 0 }))) });
    render(<ComparePanel api={a} baselineId="b1" pkg={pkg} onDiff={vi.fn()} />);
    fireEvent.click(await screen.findByText('Compare'));
    expect(await screen.findByText(/lane layouts differ/)).toBeTruthy();
    expect(screen.getByText('36.0 → 28.8')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Link metric/), { target: { value: 'delay' } });
    expect(screen.getByText(/No matching links/)).toBeTruthy();
    expect(a.getScenarioPackage).toHaveBeenCalledWith('s2');
  });

  it('compares runs without history per link and reports errors', async () => {
    const noCells = api({ getRunBuckets: vi.fn().mockResolvedValue(new ArrayBuffer(0)) });
    render(<ComparePanel api={noCells} baselineId="b1" pkg={pkg} onDiff={vi.fn()} />);
    fireEvent.click(await screen.findByText('Compare'));
    expect(await screen.findByText(/no heatmap history/)).toBeTruthy();
    cleanup();
    render(<ComparePanel api={api({ getRunBuckets: vi.fn().mockRejectedValue(new Error('gone')) })} baselineId="b1" pkg={pkg} onDiff={vi.fn()} />);
    fireEvent.click(await screen.findByText('Compare'));
    expect((await screen.findByRole('alert')).textContent).toBe('gone');
  });

  it('keeps A and B on different runs as runs are added', () => {
    expect(pickPair([], '', '')).toEqual(['', '']);
    expect(pickPair(['r1'], '', '')).toEqual(['r1', 'r1']);
    expect(pickPair(['r2', 'r1'], 'r1', 'r1')).toEqual(['r1', 'r2']);
    expect(pickPair(['r2', 'r1'], 'r1', 'r2')).toEqual(['r1', 'r2']);
    expect(pickPair(['r3'], 'r1', 'r2')).toEqual(['r3', 'r3']);
  });

  it('asks for two runs first', async () => {
    const a = api({ listScenarios: vi.fn().mockResolvedValue([scenario('s1', 'Base')]) });
    render(<ComparePanel api={a} baselineId="b1" pkg={pkg} onDiff={vi.fn()} />);
    await waitFor(() => expect(a.listRuns).toHaveBeenCalled());
    expect(screen.getByText(/at least two runs/)).toBeTruthy();
  });
});
