import type { ImportJob, ImportStatus } from '../api/client';
import type { BBox } from '../network/types';

/** Import orchestration (#34): submit, poll until the baseline exists, report progress. */

export type ImportPhase = 'submitting' | ImportStatus | 'loading';

export interface ImportApi {
  startImport(bbox: BBox, signal?: AbortSignal): Promise<ImportJob>;
  getImportJob(jobId: string, signal?: AbortSignal): Promise<ImportJob>;
}

export class ImportFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFailedError';
  }
}

export interface RunImportOptions {
  onPhase?: (phase: ImportPhase) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  /** Give up after this long (the backend bounds imports by area, so this is a safety net). */
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Runs an import to completion and resolves with the baseline id. */
export async function runImport(api: ImportApi, bbox: BBox, options: RunImportOptions = {}): Promise<string> {
  const { onPhase, signal, pollIntervalMs = 1000, timeoutMs = 15 * 60_000, sleep = abortableSleep, now = Date.now } = options;
  onPhase?.('submitting');
  let job = await api.startImport(bbox, signal);
  const started = now();
  for (;;) {
    onPhase?.(job.status);
    if (job.status === 'completed') {
      if (!job.baselineId) throw new ImportFailedError('Import completed without a baseline id.');
      return job.baselineId;
    }
    if (job.status === 'failed') throw new ImportFailedError(job.error || 'The import failed.');
    if (!job.jobId) throw new ImportFailedError('The server did not return an import job id.');
    if (now() - started > timeoutMs) throw new ImportFailedError('The import is taking too long; try a smaller area.');
    await sleep(pollIntervalMs, signal);
    job = await api.getImportJob(job.jobId, signal);
  }
}

const PHASES: Record<ImportPhase, { label: string; fraction: number }> = {
  submitting: { label: 'Submitting import…', fraction: 0.02 },
  queued: { label: 'Waiting in queue…', fraction: 0.05 },
  fetching: { label: 'Fetching OpenStreetMap data…', fraction: 0.25 },
  compiling: { label: 'Compiling the lane graph…', fraction: 0.6 },
  storing: { label: 'Storing the network…', fraction: 0.8 },
  loading: { label: 'Loading the network package…', fraction: 0.9 },
  completed: { label: 'Import complete', fraction: 1 },
  failed: { label: 'Import failed', fraction: 1 },
};

/** Human-readable label and approximate progress for a phase. */
export function phaseProgress(phase: ImportPhase): { label: string; fraction: number } {
  return PHASES[phase];
}
