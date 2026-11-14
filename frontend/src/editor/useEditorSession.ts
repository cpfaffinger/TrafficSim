import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChangesetRejectedError, type EditIssue, type Scenario, type ScenarioClient } from '../api/scenarioClient';
import { parseNetworkPackage } from '../network/parse';
import type { NetworkPackage } from '../network/types';
import { commit as commitHistory, createHistory, redo as redoHistory, sameChangeset, undo as undoHistory, type EditHistory } from './history';
import { EditError, type Changeset, type EditResult } from './ops';
import { historyShortcut, isTextInput } from './shortcuts';

export type EditorClient = Pick<ScenarioClient, 'preview' | 'getScenarioPackage' | 'createScenario' | 'updateScenario'>;

export type PreviewStatus = 'idle' | 'pending' | 'loading' | 'error';

export interface EditorSession {
  baselineId: string | null;
  scenario: Scenario | null;
  history: EditHistory;
  changeset: Changeset;
  /** Edits differ from the saved scenario (or exist without a scenario). */
  dirty: boolean;
  preview: PreviewStatus;
  /** Edits the backend skipped in the displayed package. */
  issues: EditIssue[];
  /** Last error (preview, save or an action that cannot be expressed as an edit). */
  error: string | null;
  saving: boolean;
  /** Starts editing a freshly loaded baseline (its package is already displayed). */
  startBaseline: (pkg: NetworkPackage, baselineId: string) => void;
  /** Loads a scenario: its changeset becomes the edit state and its package is displayed. */
  openScenario: (scenario: Scenario) => Promise<void>;
  /** Updates scenario metadata after rename/settings changes, or detaches (null) keeping the edits. */
  setScenario: (scenario: Scenario | null) => void;
  /** Runs an edit builder; `EditError`s are reported instead of thrown. */
  apply: (build: () => EditResult) => boolean;
  /** Replaces the changeset as one undo step (e.g. lifting a turn ban). */
  replace: (label: string, changeset: Changeset) => void;
  undo: () => void;
  redo: () => void;
  /** Saves the changeset to the scenario, creating one if needed. */
  save: (newName?: string) => Promise<Scenario | null>;
  clearError: () => void;
}

export interface EditorSessionOptions {
  client: EditorClient;
  /** Shows a package in the scene; `keepCamera` is true for edits of the same area. */
  onDisplay: (pkg: NetworkPackage, keepCamera: boolean) => void;
  debounceMs?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'Unexpected error');

/**
 * Editor state (#70): undo/redo over the changeset, debounced live preview through the backend
 * compiler (camera kept), skipped-edit issues and saving to the scenario.
 */
export function useEditorSession({ client, onDisplay, debounceMs = 400 }: EditorSessionOptions): EditorSession {
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [scenario, setScenarioState] = useState<Scenario | null>(null);
  const [history, setHistory] = useState<EditHistory>(() => createHistory());
  const [saved, setSaved] = useState<Changeset>([]);
  const [preview, setPreview] = useState<PreviewStatus>('idle');
  const [issues, setIssues] = useState<EditIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const basePkg = useRef<NetworkPackage | null>(null);
  const displayed = useRef<Changeset | null>(null);
  const display = useRef(onDisplay);
  useEffect(() => {
    display.current = onDisplay;
  }, [onDisplay]);

  const changeset = history.present.changeset;

  // Live preview: recompile after edits (debounced); the newest request wins.
  useEffect(() => {
    if (!baselineId || (displayed.current && sameChangeset(displayed.current, changeset))) return;
    if (changeset.length === 0 && basePkg.current) {
      displayed.current = changeset;
      setIssues([]);
      setPreview('idle');
      display.current(basePkg.current, true);
      return;
    }
    const controller = new AbortController();
    setPreview('pending');
    const timer = setTimeout(() => {
      setPreview('loading');
      client
        .preview(baselineId, changeset, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          const pkg = parseNetworkPackage(result.pkg);
          displayed.current = changeset;
          setIssues(result.issues);
          setPreview('idle');
          display.current(pkg, true);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setPreview('error');
          setError(`Preview failed: ${message(e)}`);
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [baselineId, changeset, client, debounceMs]);

  const startBaseline = useCallback((pkg: NetworkPackage, id: string) => {
    basePkg.current = pkg;
    displayed.current = [];
    setBaselineId(id);
    setScenarioState(null);
    setHistory(createHistory());
    setSaved([]);
    setIssues([]);
    setError(null);
    setPreview('idle');
  }, []);

  const openScenario = useCallback(
    async (s: Scenario) => {
      setPreview('loading');
      setError(null);
      try {
        const result = await client.getScenarioPackage(s.id);
        const pkg = parseNetworkPackage(result.pkg);
        displayed.current = s.changeset;
        setBaselineId(s.baselineId);
        setScenarioState(s);
        setHistory(createHistory(s.changeset, `Opened “${s.name}”`));
        setSaved(s.changeset);
        setIssues(result.issues);
        setPreview('idle');
        display.current(pkg, true);
      } catch (e) {
        setPreview('error');
        setError(`Could not open “${s.name}”: ${message(e)}`);
      }
    },
    [client],
  );

  const setScenario = useCallback((s: Scenario | null) => {
    setScenarioState(s);
    if (!s) setSaved([]);
  }, []);

  const apply = useCallback((build: () => EditResult) => {
    try {
      const result = build();
      setHistory((h) => commitHistory(h, result.label, [...h.present.changeset, ...result.ops]));
      setError(null);
      return true;
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      setError(e.message);
      return false;
    }
  }, []);

  const replace = useCallback((label: string, next: Changeset) => setHistory((h) => commitHistory(h, label, next)), []);
  const undo = useCallback(() => setHistory(undoHistory), []);
  const redo = useCallback(() => setHistory(redoHistory), []);
  const clearError = useCallback(() => setError(null), []);

  const save = useCallback(
    async (newName?: string) => {
      if (!baselineId) return null;
      setSaving(true);
      setError(null);
      try {
        const s = scenario
          ? await client.updateScenario(scenario.id, { changeset })
          : await client.createScenario({ name: newName?.trim() || 'Scenario', baselineId, changeset });
        setScenarioState(s);
        setSaved(changeset);
        return s;
      } catch (e) {
        if (e instanceof ChangesetRejectedError) setIssues(e.issues);
        setError(`Not saved: ${message(e)}`);
        return null;
      } finally {
        setSaving(false);
      }
    },
    [baselineId, scenario, changeset, client],
  );

  const dirty = useMemo(() => !sameChangeset(changeset, saved), [changeset, saved]);

  return {
    baselineId,
    scenario,
    history,
    changeset,
    dirty,
    preview,
    issues,
    error,
    saving,
    startBaseline,
    openScenario,
    setScenario,
    apply,
    replace,
    undo,
    redo,
    save,
    clearError,
  };
}

/** Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y on the whole page, except while typing in a field. */
export function useHistoryShortcuts(enabled: boolean, onUndo: () => void, onRedo: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return;
      const action = historyShortcut(e);
      if (!action) return;
      e.preventDefault();
      if (action === 'undo') onUndo();
      else onRedo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onUndo, onRedo]);
}
