import { describe, expect, it, vi } from 'vitest';
import { confirmDiscard, DISCARD_MESSAGE } from './discard';

describe('confirmDiscard', () => {
  it('only asks when there are unsaved edits', () => {
    const ask = vi.fn(() => false);
    expect(confirmDiscard(false, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(confirmDiscard(true, ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith(DISCARD_MESSAGE);
    expect(confirmDiscard(true, () => true)).toBe(true);
  });
});
