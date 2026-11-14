import { useEffect, useState } from 'react';
import type { EditIssue, Scenario, ScenarioClient } from '../api/scenarioClient';
import { IssueList } from '../editor/components/common';
import { parseNetworkPackage } from '../network/parse';
import type { NetworkPackage } from '../network/types';
import { ExportsMenu } from './ExportsMenu';
import { editorUrl } from './shareUrl';

export type SharedApi = Pick<ScenarioClient, 'getShared' | 'getSharedPackage' | 'listRuns'>;

export interface SharedScenarioPanelProps {
  api: SharedApi;
  token: string;
  onPackage: (pkg: NetworkPackage) => void;
  location?: { origin: string; pathname: string };
}

/** Read-only viewer mode (#76): loads a shared scenario and its network; no edit tools. */
export function SharedScenarioPanel({ api, token, onPackage, location = window.location }: SharedScenarioPanelProps) {
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [issues, setIssues] = useState<EditIssue[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.getShared(token, controller.signal), api.getSharedPackage(token, controller.signal)])
      .then(([s, result]) => {
        if (controller.signal.aborted) return;
        setScenario(s);
        setIssues(result.issues);
        onPackage(parseNetworkPackage(result.pkg));
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Unexpected error');
      });
    return () => controller.abort();
  }, [api, token, onPackage]);

  return (
    <section aria-label="Shared scenario" className="scenario-panel">
      <h2>Shared scenario</h2>
      <p className="badge">Read-only</p>
      {!scenario && !error && <p className="muted">Loading…</p>}
      {error && (
        <p className="error" role="alert">
          This share link could not be opened: {error}
        </p>
      )}
      {scenario && (
        <>
          <dl className="stats">
            <dt>Name</dt>
            <dd>{scenario.name}</dd>
            <dt>Edits</dt>
            <dd>{scenario.changeset.length}</dd>
            <dt>Seed</dt>
            <dd>{scenario.seed}</dd>
            <dt>Duration</dt>
            <dd>{Math.round(scenario.durationSeconds / 60)} min</dd>
          </dl>
          <IssueList issues={issues} />
          <ExportsMenu scenarioId={scenario.id} listRuns={api.listRuns.bind(api)} />
        </>
      )}
      <p className="small">
        <a href={editorUrl(location)}>Open the editor</a>
      </p>
    </section>
  );
}
