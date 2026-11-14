export const DISCARD_MESSAGE = 'You have unsaved edits. Load another network and discard them?';

/** Asks before replacing a network with unsaved edits (#107); true when it is safe to continue. */
export function confirmDiscard(dirty: boolean, confirm: (message: string) => boolean): boolean {
  return !dirty || confirm(DISCARD_MESSAGE);
}
