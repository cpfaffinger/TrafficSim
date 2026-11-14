import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BatchJob, RunSummary, Scenario, ScenarioClient } from '../api/scenarioClient';
import { TRANSIT_KPIS } from '../transit/kpis';
import { aggregate, asSummary, formatStat, formatValue, RUN_KPIS } from './runStats';

export type RunsApi = Pick<ScenarioClient, 'listRuns' | 'saveRun' | 'batchRunner' | 'startBatch' | 'getBatch'>;

/** Results of the browser simulation (worker `results` message). */
export interface SimResults {
  summaryJson: string;
  cells: ArrayBuffer;
  time: number;
}

export interface RunsPanelProps {
  api: RunsApi;
  scenario: Pick<Scenario, 'id' | 'name' | 'durationSeconds'>;
  /** Seed of the browser simulation. */
  seed: number;
  /** Collects the browser run; null while no simulation is loaded. */
  collectResults: (() => Promise<SimResults>) | null;
  /** Called after runs were added (e.g. to refresh comparisons). */
  onRunsChanged?: () => void;
  pollMs?: number;
  /** Larger lane-cell histories are stored without buckets (request size). */
  maxUploadBytes?: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error');
const when = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');
const speedKpi = RUN_KPIS[0]!;

/** Stored runs of a scenario (#73): save the browser run, run seeds on the server (#84), KPI mean ± sd. */
export function RunsPanel({ api, scenario, seed, collectResults, onRunsChanged, pollMs = 2000, maxUploadBytes = 24 * 1024 * 1024 }: RunsPanelProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runner, setRunner] = useState<{ available: boolean; maxSeeds: number } | null>(null);
  const [seeds, setSeeds] = useState('5');
  const [minutes, setMinutes] = useState(String(Math.max(1, Math.round(scenario.durationSeconds / 60))));
  const [job, setJob] = useState<BatchJob | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    (signal?: AbortSignal) =>
      api
        .listRuns(scenario.id, signal)
        .then((r) => !signal?.aborted && setRuns(r))
        .catch(() => undefined),
    [api, scenario.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setJob(null);
    setStatus(null);
    setError(null);
    void refresh(controller.signal);
    api
      .batchRunner(controller.signal)
      .then((r) => !controller.signal.aborted && setRunner(r))
      .catch(() => !controller.signal.aborted && setRunner({ available: false, maxSeeds: 0 }));
    return () => controller.abort();
  }, [api, refresh]);

  // Poll a queued / running batch.
  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    const id = setTimeout(() => {
      api
        .getBatch(job.jobId)
        .then((next) => {
          setJob(next);
          if (next.status === 'completed') {
            setStatus(`Batch finished: ${next.runIds.length} run${next.runIds.length === 1 ? '' : 's'} stored.`);
            void refresh().then(() => onRunsChanged?.());
          } else if (next.status === 'failed') {
            setError(`Batch failed: ${next.error ?? 'unknown error'}`);
          }
        })
        .catch((e: unknown) => {
          setError(errorText(e));
          setJob(null);
        });
    }, pollMs);
    return () => clearTimeout(id);
  }, [api, job, pollMs, refresh, onRunsChanged]);

  const save = async () => {
    if (!collectResults) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const results = await collectResults();
      const summary: unknown = JSON.parse(results.summaryJson);
      const tooLarge = results.cells.byteLength > maxUploadBytes;
      await api.saveRun(scenario.id, {
        seed,
        simulatedSeconds: results.time,
        summary,
        buckets: tooLarge || results.cells.byteLength === 0 ? null : new Uint8Array(results.cells),
      });
      setStatus(tooLarge ? 'Run saved (summary only: the heatmap history is too large to upload).' : 'Run saved.');
      await refresh();
      onRunsChanged?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const startBatch = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(seeds);
    const m = Number(minutes);
    const max = runner?.maxSeeds || 20;
    if (!Number.isInteger(n) || n < 1 || n > max) {
      setError(`Seeds must be a whole number between 1 and ${max}.`);
      return;
    }
    if (!Number.isFinite(m) || m <= 0 || m > 360) {
      setError('Duration must be between 1 and 360 minutes.');
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setJob(await api.startBatch(scenario.id, { seeds: n, durationSeconds: Math.round(m * 60) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const agg = aggregate(runs.map((r) => r.summary));
  const transitAgg = aggregate(
    runs.map((r) => r.summary),
    TRANSIT_KPIS,
  );
  const active = job !== null && (job.status === 'queued' || job.status === 'running');

  return (
    <section aria-label="Runs" className="runs-panel">
      <h2>Runs of “{scenario.name}”</h2>
      <div className="buttons">
        <button type="button" onClick={() => void save()} disabled={busy || !collectResults}>
          Save current run
        </button>
      </div>
      <form className="batch-form" noValidate onSubmit={(e) => void startBatch(e)}>
        <label>
          Seeds <input type="number" min={1} max={runner?.maxSeeds || 20} value={seeds} onChange={(e) => setSeeds(e.target.value)} />
        </label>
        <label>
          Minutes <input type="number" min={1} max={360} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
        <button type="submit" disabled={busy || active || !runner?.available}>
          Run batch on server
        </button>
      </form>
      {runner && !runner.available && <p className="muted small">The server-side batch runner is not available here.</p>}
      {active && (
        <p className="small" role="status">
          Batch {job.status}: {job.seeds.length} seed{job.seeds.length === 1 ? '' : 's'} × {Math.round(job.durationSeconds / 60)} min…
        </p>
      )}
      {runs.length > 0 ? (
        <>
          <table className="kpi-table">
            <caption className="small muted">
              Mean{runs.length > 1 ? ' ± sd' : ''} over {runs.length} run{runs.length === 1 ? '' : 's'}
            </caption>
            <tbody>
              {RUN_KPIS.map((k) => (
                <tr key={k.key}>
                  <th scope="row">{k.label}</th>
                  <td>
                    {formatStat(agg.get(k.key) ?? null, k)} {k.unit}
                  </td>
                </tr>
              ))}
              {TRANSIT_KPIS.filter((k) => transitAgg.get(k.key)).map((k) => (
                <tr key={k.key}>
                  <th scope="row">{k.label}</th>
                  <td>
                    {formatStat(transitAgg.get(k.key) ?? null, k)} {k.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>{runs.length} stored run{runs.length === 1 ? '' : 's'}</summary>
            <ul className="run-list small">
              {runs.map((r) => (
                <li key={r.id}>
                  {when(r.createdAt)} · seed {r.seed} · {Math.round(r.simulatedSeconds / 60)} min · {formatValue(speedKpi.get(asSummary(r.summary)), speedKpi)} km/h
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="muted small">No stored runs yet. Save the browser run or start a batch.</p>
      )}
      {status && (
        <p className="small" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
