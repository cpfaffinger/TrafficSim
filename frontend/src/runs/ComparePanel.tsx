import { useEffect, useState } from 'react';
import type { RunSummary, Scenario, ScenarioClient } from '../api/scenarioClient';
import { decodeLaneCells, type LaneCellsBlob } from '../metrics/laneCells';
import { parseNetworkPackage } from '../network/parse';
import type { NetworkPackage } from '../network/types';
import { layoutFits, LINK_METRICS, linkDeltas, networkDeltas, sameLayout, type KpiDelta, type LinkDelta, type LinkMetric } from './compare';

export type CompareApi = Pick<ScenarioClient, 'listScenarios' | 'listRuns' | 'getRunBuckets' | 'getScenarioPackage'>;

export interface CellDiff {
  a: LaneCellsBlob;
  b: LaneCellsBlob;
  label: string;
}

export interface ComparePanelProps {
  api: CompareApi;
  baselineId: string;
  /** The displayed package: the cell diff is drawn on it when the lanes fit. */
  pkg: NetworkPackage;
  onDiff: (diff: CellDiff | null) => void;
  /** Changes when runs were added, to reload the run list. */
  refreshKey?: number;
}

interface RunOption {
  run: RunSummary;
  scenario: Scenario;
  label: string;
}

interface Result {
  kpis: KpiDelta[];
  cells: boolean;
  links: { pkgA: NetworkPackage; pkgB: NetworkPackage; a: unknown; b: unknown } | null;
  note: string | null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error');
const when = (iso: string) => (iso ? iso.slice(5, 16).replace('T', ' ') : '');

/** Keeps the chosen runs while they exist and makes A and B differ whenever two runs are available. */
export function pickPair(ids: readonly string[], a: string, b: string): [string, string] {
  const nextA = ids.includes(a) ? a : (ids[0] ?? '');
  let nextB = ids.includes(b) ? b : '';
  if (!nextB || nextB === nextA) nextB = ids.find((id) => id !== nextA) ?? nextA;
  return [nextA, nextB];
}

async function cellsOf(api: CompareApi, run: RunSummary): Promise<LaneCellsBlob | null> {
  if (run.bucketFormat !== 'lane-cells-v1') return null;
  const bytes = await api.getRunBuckets(run.id);
  if (bytes.byteLength === 0) return null;
  const blob = decodeLaneCells(bytes);
  return blob.buckets.length > 0 ? blob : null;
}

/** A/B comparison of two stored runs (#74): diff heatmap on matching lanes, KPI and per-link deltas otherwise. */
export function ComparePanel({ api, baselineId, pkg, onDiff, refreshKey = 0 }: ComparePanelProps) {
  const [options, setOptions] = useState<RunOption[]>([]);
  const [[aId, bId], setPair] = useState<[string, string]>(['', '']);
  const setAId = (id: string) => setPair(([, b]) => [id, b]);
  const setBId = (id: string) => setPair(([a]) => [a, id]);
  const [metric, setMetric] = useState<LinkMetric>('meanSpeed');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    api
      .listScenarios(baselineId, signal)
      .then((scenarios) => Promise.all(scenarios.map((s) => api.listRuns(s.id, signal).then((runs) => runs.map((run) => ({ run, scenario: s }))))))
      .then((lists) => {
        if (signal.aborted) return;
        const all = lists.flat().map(({ run, scenario }) => ({ run, scenario, label: `${scenario.name} · seed ${run.seed} · ${when(run.createdAt)}` }));
        setOptions(all);
        setPair(([a, b]) => pickPair(all.map((o) => o.run.id), a, b));
      })
      .catch(() => !signal.aborted && setOptions([]));
    return () => controller.abort();
  }, [api, baselineId, refreshKey]);

  useEffect(() => () => onDiff(null), [onDiff]);

  const compare = async () => {
    const a = options.find((o) => o.run.id === aId);
    const b = options.find((o) => o.run.id === bId);
    if (!a || !b) return;
    setBusy(true);
    setError(null);
    onDiff(null);
    try {
      const kpis = networkDeltas(a.run.summary, b.run.summary);
      const [ca, cb] = await Promise.all([cellsOf(api, a.run), cellsOf(api, b.run)]);
      if (ca && cb && sameLayout(ca, cb) && layoutFits(pkg, cb.lanes)) {
        onDiff({ a: ca, b: cb, label: `${b.label} vs ${a.label}` });
        setResult({ kpis, cells: true, links: null, note: null });
        return;
      }
      const [pa, pb] = await Promise.all([api.getScenarioPackage(a.scenario.id), api.getScenarioPackage(b.scenario.id)]);
      const note =
        ca && cb
          ? 'The lane layouts differ (edited network): links are matched by their OSM ways instead of drawing a cell diff.'
          : 'At least one run has no heatmap history: comparing per link.';
      setResult({ kpis, cells: false, links: { pkgA: parseNetworkPackage(pa.pkg), pkgB: parseNetworkPackage(pb.pkg), a: a.run.summary, b: b.run.summary }, note });
    } catch (e) {
      setError(errorText(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  if (options.length < 2) {
    return (
      <section aria-label="Compare runs" className="compare-panel">
        <h2>Compare runs</h2>
        <p className="muted small">Store at least two runs (of this or another scenario) to compare them.</p>
      </section>
    );
  }

  const deltas: LinkDelta[] = result?.links ? linkDeltas(result.links.pkgA, result.links.a, result.links.pkgB, result.links.b, metric).slice(0, 10) : [];
  const info = LINK_METRICS[metric];

  return (
    <section aria-label="Compare runs" className="compare-panel">
      <h2>Compare runs</h2>
      <label className="field">
        A (reference){' '}
        <select value={aId} onChange={(e) => setAId(e.target.value)}>
          {options.map((o) => (
            <option key={o.run.id} value={o.run.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        B (variant){' '}
        <select value={bId} onChange={(e) => setBId(e.target.value)}>
          {options.map((o) => (
            <option key={o.run.id} value={o.run.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="buttons">
        <button type="button" onClick={() => void compare()} disabled={busy || aId === bId}>
          Compare
        </button>
      </div>
      {result && (
        <>
          <table className="kpi-table">
            <caption className="small muted">Network KPIs, B vs A</caption>
            <tbody>
              {result.kpis.map((k) => (
                <tr key={k.key} className={k.verdict > 0 ? 'better' : k.verdict < 0 ? 'worse' : undefined}>
                  <th scope="row">{k.label}</th>
                  <td>
                    {k.a === null || k.b === null
                      ? '–'
                      : `${k.a.toFixed(k.digits)} → ${k.b.toFixed(k.digits)} ${k.unit}${k.pct === null ? '' : ` (${k.pct >= 0 ? '+' : ''}${k.pct.toFixed(1)} %)`}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.cells && <p className="small">The heatmap shows B − A per lane cell: blue = better in B, red = worse.</p>}
          {result.note && <p className="muted small">{result.note}</p>}
          {result.links && (
            <>
              <label className="field">
                Link metric{' '}
                <select value={metric} onChange={(e) => setMetric(e.target.value as LinkMetric)}>
                  {(Object.keys(LINK_METRICS) as LinkMetric[]).map((m) => (
                    <option key={m} value={m}>
                      {LINK_METRICS[m].label}
                    </option>
                  ))}
                </select>
              </label>
              {deltas.length === 0 ? (
                <p className="muted small">No matching links with data in both runs.</p>
              ) : (
                <table className="kpi-table">
                  <caption className="small muted">Largest changes ({info.unit})</caption>
                  <tbody>
                    {deltas.map((d) => (
                      <tr key={d.key} className={d.delta === 0 ? undefined : (d.delta > 0) === info.higherIsBetter ? 'better' : 'worse'}>
                        <th scope="row">{d.name}</th>
                        <td>
                          {d.a.toFixed(1)} → {d.b.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
