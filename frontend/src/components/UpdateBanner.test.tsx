// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './UpdateBanner';

afterEach(cleanup);

describe('UpdateBanner', () => {
  it('offers a reload', () => {
    const onReload = vi.fn();
    render(<UpdateBanner onReload={onReload} />);
    fireEvent.click(screen.getByText('Reload'));
    expect(onReload).toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('new version');
  });
});
