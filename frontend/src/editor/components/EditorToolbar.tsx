import { redoLabel, undoLabel } from '../history';
import type { EditorSession } from '../useEditorSession';
import { IssueList } from './common';

export type EditorMode = 'select' | 'draw';

export interface EditorToolbarProps {
  session: EditorSession;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  /** Saves; creating a scenario when none is open. */
  onSave: () => void;
}

const PREVIEW_TEXT = { idle: null, pending: 'Edit pending…', loading: 'Recompiling…', error: 'Preview failed' } as const;

/** Tool mode, undo/redo, save and preview status (#70). */
export function EditorToolbar({ session, mode, onMode, onSave }: EditorToolbarProps) {
  const u = undoLabel(session.history);
  const r = redoLabel(session.history);
  const status = PREVIEW_TEXT[session.preview];
  const edits = session.changeset.length;
  return (
    <section aria-label="Editing" className="editor-toolbar">
      <h2>Edit network</h2>
      <div className="segmented" role="radiogroup" aria-label="Tool">
        <button type="button" role="radio" aria-checked={mode === 'select'} onClick={() => onMode('select')}>
          Select
        </button>
        <button type="button" role="radio" aria-checked={mode === 'draw'} onClick={() => onMode('draw')}>
          Draw road
        </button>
      </div>
      <div className="buttons">
        <button type="button" onClick={session.undo} disabled={!u} title={u ? `Undo: ${u} (Ctrl+Z)` : 'Nothing to undo'} aria-label={u ? `Undo: ${u}` : 'Undo'}>
          ↶ Undo
        </button>
        <button
          type="button"
          onClick={session.redo}
          disabled={!r}
          title={r ? `Redo: ${r} (Ctrl+Shift+Z)` : 'Nothing to redo'}
          aria-label={r ? `Redo: ${r}` : 'Redo'}
        >
          ↷ Redo
        </button>
        <button type="button" className={session.dirty ? 'primary' : undefined} onClick={onSave} disabled={!session.dirty || session.saving}>
          {session.saving ? 'Saving…' : session.scenario ? 'Save' : 'Save as scenario'}
        </button>
      </div>
      <p className="muted small" role="status">
        {edits} edit{edits === 1 ? '' : 's'}
        {session.scenario ? ` · ${session.scenario.name}` : ' · unsaved draft'}
        {session.dirty && session.scenario ? ' · unsaved changes' : ''}
        {status ? ` · ${status}` : ''}
      </p>
      {session.error && (
        <p className="error small" role="alert">
          {session.error}{' '}
          <button type="button" className="link-button" onClick={session.clearError}>
            Dismiss
          </button>
        </p>
      )}
      <IssueList issues={session.issues} />
    </section>
  );
}
