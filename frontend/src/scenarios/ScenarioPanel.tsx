import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Scenario, ScenarioClient } from '../api/scenarioClient';
import type { EditorSession } from '../editor/useEditorSession';
import { ExportsMenu } from './ExportsMenu';
import { formOf, nextScenarioName, validateForm, type ScenarioForm } from './scenarioForm';
import { shareUrl } from './shareUrl';

export type ScenarioApi = Pick<ScenarioClient, 'listScenarios' | 'createScenario' | 'updateScenario' | 'deleteScenario' | 'cloneScenario' | 'listRuns'>;
type SessionPart = Pick<EditorSession, 'baselineId' | 'scenario' | 'dirty' | 'changeset' | 'openScenario' | 'setScenario'>;

export interface ScenarioPanelProps {
  api: ScenarioApi;
  session: SessionPart;
  confirm?: (message: string) => boolean;
  copy?: (text: string) => Promise<void>;
  location?: { origin: string; pathname: string };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error');
const defaultConfirm = (m: string) => window.confirm(m);
const defaultCopy = (text: string) => navigator.clipboard.writeText(text);

/** Scenario management for the loaded baseline (#72): list, create, open, settings, clone, delete, share (#76), export (#75). */
export function ScenarioPanel({ api, session, confirm = defaultConfirm, copy = defaultCopy, location = window.location }: ScenarioPanelProps) {
  const { baselineId, scenario } = session;
  const [list, setList] = useState<Scenario[]>([]);
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const refresh = useCallback(
    (signal?: AbortSignal) => {
      if (!baselineId) return Promise.resolve();
      return api
        .listScenarios(baselineId, signal)
        .then((l) => !signal?.aborted && setList(l))
        .catch(() => undefined);
    },
    [api, baselineId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, scenario?.id, scenario?.updatedAt]);

  useEffect(() => setLink(null), [scenario?.id]);

  const guard = (message: string) => !session.dirty || confirm(message);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      setStatus(await work());
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const open = (s: Scenario) => {
    if (s.id === scenario?.id || !guard(`Discard unsaved edits and open “${s.name}”?`)) return;
    void run(async () => {
      await session.openScenario(s);
      return null;
    });
  };

  const adoptDraft = !scenario && session.changeset.length > 0;

  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!baselineId) return;
    if (scenario && !guard('Discard unsaved edits and start a new scenario?')) return;
    const name = newName.trim() || nextScenarioName(list);
    void run(async () => {
      const created = await api.createScenario({ name, baselineId, changeset: adoptDraft ? session.changeset : [] });
      setNewName('');
      await session.openScenario(created);
      return `Created “${created.name}”.`;
    });
  };

  const clone = () => {
    if (!scenario || !guard('The variant copies the saved state; discard unsaved edits?')) return;
    void run(async () => {
      const copyOf = await api.cloneScenario(scenario.id, `${scenario.name} (variant)`);
      await session.openScenario(copyOf);
      return `Created variant “${copyOf.name}”.`;
    });
  };

  const remove = () => {
    if (!scenario || !confirm(`Delete scenario “${scenario.name}”? This cannot be undone; your current edits stay as an unsaved draft.`)) return;
    void run(async () => {
      await api.deleteScenario(scenario.id);
      session.setScenario(null);
      return `Deleted “${scenario.name}”.`;
    });
  };

  const share = () => {
    if (!scenario?.shareToken) return;
    const url = shareUrl(scenario.shareToken, location);
    setLink(url);
    copy(url).then(
      () => setStatus(session.dirty ? 'Link copied. It shows the saved state; save to include your latest edits.' : 'Read-only link copied.'),
      () => setStatus('Copy the read-only link below.'),
    );
  };

  if (!baselineId) return null;

  return (
    <section aria-label="Scenarios" className="scenario-panel">
      <h2>Scenarios</h2>
      {list.length === 0 ? (
        <p className="muted small">No scenarios for this network yet.</p>
      ) : (
        <ul className="result-list">
          {list.map((s) => (
            <li key={s.id}>
              <button type="button" aria-current={s.id === scenario?.id ? 'true' : undefined} disabled={busy} onClick={() => open(s)}>
                <span className="result-label">
                  {s.name}
                  {s.id === scenario?.id ? ' (open)' : ''}
                </span>
                <span className="result-category">
                  {s.changeset.length} edit{s.changeset.length === 1 ? '' : 's'} · seed {s.seed} · {Math.round(s.durationSeconds / 60)} min
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="search-form" onSubmit={create}>
        <label htmlFor="new-scenario" className="visually-hidden">
          New scenario name
        </label>
        <input id="new-scenario" type="text" placeholder={nextScenarioName(list)} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" disabled={busy}>
          {adoptDraft ? 'Save draft as scenario' : 'New scenario'}
        </button>
      </form>

      {scenario && (
        <>
          <ScenarioSettings
            key={`${scenario.id}:${scenario.updatedAt}`}
            scenario={scenario}
            busy={busy}
            onSave={(input) =>
              run(async () => {
                session.setScenario(await api.updateScenario(scenario.id, input));
                return 'Settings saved.';
              })
            }
          />
          <div className="buttons">
            <button type="button" onClick={clone} disabled={busy}>
              Clone as variant
            </button>
            <button type="button" onClick={share} disabled={busy || !scenario.shareToken}>
              Copy share link
            </button>
            <button type="button" className="danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          </div>
          {link && (
            <input className="share-link" type="text" readOnly value={link} aria-label="Read-only share link" onFocus={(e) => e.target.select()} />
          )}
          <ExportsMenu scenarioId={scenario.id} listRuns={api.listRuns.bind(api)} />
        </>
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

interface ScenarioSettingsProps {
  scenario: Scenario;
  busy: boolean;
  onSave: (input: Exclude<ReturnType<typeof validateForm>, { ok: false }>['input']) => void;
}

function ScenarioSettings({ scenario, busy, onSave }: ScenarioSettingsProps) {
  const [form, setForm] = useState<ScenarioForm>(() => formOf(scenario));
  const [errors, setErrors] = useState<Partial<Record<keyof ScenarioForm, string>>>({});
  const field = (key: keyof ScenarioForm) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `err-${key}` : undefined,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const result = validateForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSave(result.input);
  };
  const err = (key: keyof ScenarioForm) =>
    errors[key] && (
      <span id={`err-${key}`} className="error small">
        {errors[key]}
      </span>
    );
  return (
    <details className="scenario-settings">
      <summary>Settings of “{scenario.name}”</summary>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="sc-name">Name</label>
          <input id="sc-name" type="text" {...field('name')} />
          {err('name')}
        </div>
        <div className="area-fields">
          <div className="field">
            <label htmlFor="sc-seed">Seed</label>
            <input id="sc-seed" type="number" step={1} {...field('seed')} />
            {err('seed')}
          </div>
          <div className="field">
            <label htmlFor="sc-duration">Duration (min)</label>
            <input id="sc-duration" type="number" min={1} {...field('durationMinutes')} />
            {err('durationMinutes')}
          </div>
        </div>
        <div className="field">
          <label htmlFor="sc-demand">Demand (JSON, optional)</label>
          <textarea id="sc-demand" rows={3} spellCheck={false} {...field('demand')} />
          {err('demand')}
        </div>
        <button type="submit" disabled={busy}>
          Save settings
        </button>
      </form>
    </details>
  );
}
