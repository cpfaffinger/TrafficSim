// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BatchJob, RunSummary } from '../api/scenarioClient';
import { RunsPanel, type RunsApi } from './RunsPanel';

afterEach(cleanup);

const run = (id: string, meanSpeed: number): RunSummary => ({
  id,
  scenarioId: 's1',
  seed: 1,
  simulatedSeconds: 600,
  summary: { network: { meanSpeed, delayHours: 1 } },
  bucketFormat: 'lane-cells-v1',
  createdAt: '2026-11-14T10:00:00Z',
});
const job = (over: Partial<BatchJob> = {}): BatchJob => ({ jobId: 'j1', scenarioId: 's1', status: 'queued', seeds: [1, 2], durationSeconds: 600, runIds: [], mean: null, error: null, ...over });

const api = (over: Partial<RunsApi> = {}): RunsApi => ({
  listRuns: vi.fn().mockResolvedValue([run('r1', 10), run('r2', 12)]),
  saveRun: vi.fn().mockResolvedValue(run('r3', 11)),
  batchRunner: vi.fn().mockResolvedValue({ available: true, maxSeeds: 20 }),
  startBatch: vi.fn().mockResolvedValue(job()),
  getBatch: vi.fn().mockResolvedValue(job({ status: 'completed', runIds: ['r4', 'r5'] })),
  ...over,
});
const scenario = { id: 's1', name: 'Base', durationSeconds: 1800 };

describe('RunsPanel', () => {
  it('shows KPI mean ± sd and saves the browser run with its cells', async () => {
    const a = api();
    const onRunsChanged = vi.fn();
    const collect = vi.fn().mockResolvedValue({ summaryJson: '{"network":{"meanSpeed":9}}', cells: new Uint8Array([1, 2]).buffer, time: 300 });
    render(<RunsPanel api={a} scenario={scenario} seed={4} collectResults={collect} onRunsChanged={onRunsChanged} />);
    expect(await screen.findByText(/39.6 ± 5.1/)).toBeTruthy();
    expect(screen.getByText('Mean ± sd over 2 runs')).toBeTruthy();
    fireEvent.click(screen.getByText('Save current run'));
    await screen.findByText('Run saved.');
    expect(a.saveRun).toHaveBeenCalledWith('s1', { seed: 4, simulatedSeconds: 300, summary: { network: { meanSpeed: 9 } }, buckets: new Uint8Array([1, 2]) });
    expect(onRunsChanged).toHaveBeenCalled();
  });

  it('stores oversized histories as summary only and reports errors', async () => {
    const a = api({ listRuns: vi.fn().mockResolvedValue([]) });
    const collect = vi.fn().mockResolvedValueOnce({ summaryJson: '{}', cells: new ArrayBuffer(10), time: 60 }).mockRejectedValueOnce(new Error('no sim'));
    render(<RunsPanel api={a} scenario={scenario} seed={1} collectResults={collect} maxUploadBytes={5} />);
    expect(await screen.findByText(/No stored runs yet/)).toBeTruthy();
    fireEvent.click(screen.getByText('Save current run'));
    await screen.findByText(/summary only/);
    expect((a.saveRun as ReturnType<typeof vi.fn>).mock.calls[0]![1].buckets).toBeNull();
    fireEvent.click(screen.getByText('Save current run'));
    expect((await screen.findByRole('alert')).textContent).toBe('no sim');
  });

  it('starts a server batch, polls it and refreshes the runs', async () => {
    const a = api();
    const onRunsChanged = vi.fn();
    render(<RunsPanel api={a} scenario={scenario} seed={1} collectResults={null} pollMs={5} onRunsChanged={onRunsChanged} />);
    expect((screen.getByText('Save current run') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByText('Run batch on server') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(/Seeds/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Minutes/), { target: { value: '10' } });
    fireEvent.click(screen.getByText('Run batch on server'));
    expect(await screen.findByText(/Batch queued: 2 seeds × 10 min/)).toBeTruthy();
    expect(a.startBatch).toHaveBeenCalledWith('s1', { seeds: 2, durationSeconds: 600 });
    expect(await screen.findByText('Batch finished: 2 runs stored.')).toBeTruthy();
    await waitFor(() => expect(onRunsChanged).toHaveBeenCalled());
    expect((a.listRuns as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('validates the batch form, reports failed batches and an unavailable runner', async () => {
    const a = api({ getBatch: vi.fn().mockResolvedValue(job({ status: 'failed', error: 'timeout' })) });
    render(<RunsPanel api={a} scenario={scenario} seed={1} collectResults={null} pollMs={5} />);
    await waitFor(() => expect((screen.getByText('Run batch on server') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(/Seeds/), { target: { value: '99' } });
    fireEvent.click(screen.getByText('Run batch on server'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/between 1 and 20/);
    fireEvent.change(screen.getByLabelText(/Seeds/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Minutes/), { target: { value: '0' } });
    fireEvent.click(screen.getByText('Run batch on server'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Duration/);
    fireEvent.change(screen.getByLabelText(/Minutes/), { target: { value: '5' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Run batch on server'));
    });
    expect((await screen.findByRole('alert')).textContent).toBe('Batch failed: timeout');
    cleanup();
    render(<RunsPanel api={api({ batchRunner: vi.fn().mockRejectedValue(new Error('x')) })} scenario={scenario} seed={1} collectResults={null} />);
    expect(await screen.findByText(/not available here/)).toBeTruthy();
  });
});
