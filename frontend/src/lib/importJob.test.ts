import { describe, expect, it, vi } from 'vitest';
import type { ImportJob } from '../api/client';
import { abortableSleep, ImportFailedError, phaseProgress, runImport, type ImportApi, type ImportPhase } from './importJob';

const BBOX = [16.37, 48.2, 16.38, 48.21] as const;
const job = (status: ImportJob['status'], extra: Partial<ImportJob> = {}): ImportJob => ({
  jobId: 'j1',
  status,
  baselineId: null,
  error: null,
  ...extra,
});

function fakeApi(start: ImportJob, polls: ImportJob[]): ImportApi & { getImportJob: ReturnType<typeof vi.fn> } {
  return {
    startImport: vi.fn().mockResolvedValue(start),
    getImportJob: vi.fn().mockImplementation(() => Promise.resolve(polls.shift())),
  };
}

const noSleep = () => Promise.resolve();

describe('runImport', () => {
  it('polls through the phases and resolves with the baseline id', async () => {
    const api = fakeApi(job('queued'), [job('fetching'), job('compiling'), job('storing'), job('completed', { baselineId: 'b42' })]);
    const phases: ImportPhase[] = [];
    const id = await runImport(api, BBOX, { onPhase: (p) => phases.push(p), sleep: noSleep });
    expect(id).toBe('b42');
    expect(phases).toEqual(['submitting', 'queued', 'fetching', 'compiling', 'storing', 'completed']);
    expect(api.getImportJob).toHaveBeenCalledWith('j1', undefined);
  });

  it('returns immediately when an identical import exists', async () => {
    const api = fakeApi(job('completed', { jobId: null, baselineId: 'b7' }), []);
    expect(await runImport(api, BBOX, { sleep: noSleep })).toBe('b7');
    expect(api.getImportJob).not.toHaveBeenCalled();
  });

  it('reports server-side failures', async () => {
    const api = fakeApi(job('queued'), [job('failed', { error: 'Overpass timed out' })]);
    await expect(runImport(api, BBOX, { sleep: noSleep })).rejects.toEqual(new ImportFailedError('Overpass timed out'));
    const api2 = fakeApi(job('failed'), []);
    await expect(runImport(api2, BBOX, { sleep: noSleep })).rejects.toThrow('The import failed.');
  });

  it('rejects inconsistent responses', async () => {
    await expect(runImport(fakeApi(job('completed'), []), BBOX, { sleep: noSleep })).rejects.toThrow('without a baseline id');
    await expect(runImport(fakeApi(job('queued', { jobId: null }), []), BBOX, { sleep: noSleep })).rejects.toThrow('job id');
  });

  it('times out', async () => {
    let t = 0;
    const api = fakeApi(job('queued'), [job('fetching'), job('fetching')]);
    const run = runImport(api, BBOX, { sleep: noSleep, now: () => (t += 1000), timeoutMs: 1500 });
    await expect(run).rejects.toThrow('taking too long');
  });

  it('propagates start errors (e.g. area too large)', async () => {
    const api: ImportApi = { startImport: vi.fn().mockRejectedValue(new Error('Area exceeds 25 km²')), getImportJob: vi.fn() };
    await expect(runImport(api, BBOX)).rejects.toThrow('25 km²');
  });
});

describe('abortableSleep', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers();
    const p = abortableSleep(100);
    vi.advanceTimersByTime(100);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('rejects on abort, also when already aborted', async () => {
    const c = new AbortController();
    const p = abortableSleep(10_000, c.signal);
    c.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow('cancelled');
    await expect(abortableSleep(1, c.signal)).rejects.toThrow('cancelled');
  });
});

describe('phaseProgress', () => {
  it('increases monotonically through the pipeline', () => {
    const order: ImportPhase[] = ['submitting', 'queued', 'fetching', 'compiling', 'storing', 'loading', 'completed'];
    const fractions = order.map((p) => phaseProgress(p).fraction);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
    expect(phaseProgress('failed').label).toBe('Import failed');
  });
});
