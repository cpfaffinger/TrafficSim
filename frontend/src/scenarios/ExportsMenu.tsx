import { useEffect, useState } from 'react';
import { exportUrls, type RunSummary } from '../api/scenarioClient';

export interface ExportsMenuProps {
  scenarioId: string;
  listRuns: (scenarioId: string, signal?: AbortSignal) => Promise<RunSummary[]>;
}

const when = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

/** Downloads (#75): the scenario network as GeoJSON and, when runs exist, their metrics. */
export function ExportsMenu({ scenarioId, listRuns }: ExportsMenuProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    listRuns(scenarioId, controller.signal)
      .then((r) => !controller.signal.aborted && setRuns(r))
      .catch(() => !controller.signal.aborted && setRuns([]));
    return () => controller.abort();
  }, [scenarioId, listRuns]);

  return (
    <details className="exports">
      <summary>Export</summary>
      <ul>
        <li>
          <a href={exportUrls.networkGeoJson(scenarioId)} download>
            Network (GeoJSON)
          </a>
        </li>
        {runs.map((r) => (
          <li key={r.id}>
            Run {when(r.createdAt)} UTC (seed {r.seed}):{' '}
            <a href={exportUrls.runLinksCsv(r.id)} download>
              links CSV
            </a>
            {' · '}
            <a href={exportUrls.runLinksGeoJson(r.id)} download>
              links GeoJSON
            </a>
            {' · '}
            <a href={exportUrls.runSummaryCsv(r.id)} download>
              summary CSV
            </a>
          </li>
        ))}
      </ul>
      <p className="muted small">Exports of saved state. Map data © OpenStreetMap contributors (ODbL).</p>
    </details>
  );
}
