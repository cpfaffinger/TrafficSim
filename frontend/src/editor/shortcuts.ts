/** Keyboard shortcuts of the editor (#70). */

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. */
export function historyShortcut(e: KeyLike): 'undo' | 'redo' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !e.shiftKey) return 'redo';
  return null;
}

/** Road drawing: Enter finishes, Escape cancels, Backspace removes the last point. */
export function drawShortcut(e: KeyLike): 'finish' | 'cancel' | 'back' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Enter') return 'finish';
  if (e.key === 'Escape') return 'cancel';
  if (e.key === 'Backspace') return 'back';
  return null;
}

/** Shortcuts must not hijack typing in form fields. */
export function isTextInput(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type);
}
