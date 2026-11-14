import type { Changeset, EditOperation } from './ops';

/**
 * Undo/redo over the changeset (#70). Every entry is a full changeset state, so appending edits
 * ("push"), undoing ("pop") and non-append changes such as lifting a turn ban are uniform.
 */
export interface HistoryEntry {
  label: string;
  changeset: Changeset;
}

export interface EditHistory {
  past: readonly HistoryEntry[];
  present: HistoryEntry;
  future: readonly HistoryEntry[];
}

export const MAX_HISTORY = 200;

export function createHistory(changeset: Changeset = [], label = 'Start'): EditHistory {
  return { past: [], present: { label, changeset }, future: [] };
}

/** Replaces the current changeset as a new undoable step. */
export function commit(history: EditHistory, label: string, changeset: Changeset): EditHistory {
  if (changeset === history.present.changeset) return history;
  const past = [...history.past, history.present].slice(-MAX_HISTORY);
  return { past, present: { label, changeset }, future: [] };
}

/** Appends the operations of one user action as one undo step. */
export function pushEdit(history: EditHistory, label: string, ops: readonly EditOperation[]): EditHistory {
  if (ops.length === 0) return history;
  return commit(history, label, [...history.present.changeset, ...ops]);
}

export function undo(history: EditHistory): EditHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: EditHistory): EditHistory {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Label of the step that undo would revert, or null. */
export function undoLabel(history: EditHistory): string | null {
  return history.past.length > 0 ? history.present.label : null;
}

export function redoLabel(history: EditHistory): string | null {
  return history.future[0]?.label ?? null;
}

/** Structural equality of two changesets (dirty check against the saved state). */
export function sameChangeset(a: Changeset, b: Changeset): boolean {
  return a === b || (a.length === b.length && JSON.stringify(a) === JSON.stringify(b));
}
