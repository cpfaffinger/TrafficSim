// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkSummary } from '../api/client';
import { networkTitle, RecentNetworks } from './RecentNetworks';

afterEach(cleanup);

const named: NetworkSummary = {
  id: 'a',
  name: 'Schwedenplatz',
  bbox: [16.36, 48.19, 16.38, 48.21],
  createdAt: '2026-11-13T08:00:00Z',
  source: 'overpass',
  stats: { nodes: 1, links: 2, lanes: 3, connectors: 4, signals: 5 },
};
const unnamed: NetworkSummary = { ...named, id: 'b', name: null, polygon: [[16.36, 48.19], [16.38, 48.19], [16.37, 48.21]] };

describe('RecentNetworks (#114)', () => {
  it('shows names, loads, renames and deletes with confirmation', () => {
    const onLoad = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<RecentNetworks networks={[named, unnamed]} disabled={false} onLoad={onLoad} onRename={onRename} onDelete={onDelete} confirm={confirm} />);

    expect(screen.getByText('Unnamed import')).toBeTruthy();
    expect(screen.getByText(/custom shape/)).toBeTruthy();
    fireEvent.click(screen.getByText('Schwedenplatz'));
    expect(onLoad).toHaveBeenCalledWith('a');

    fireEvent.click(screen.getByLabelText('Rename Schwedenplatz'));
    fireEvent.change(screen.getByLabelText('Import name'), { target: { value: ' Donaukanal ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onRename).toHaveBeenCalledWith('a', 'Donaukanal');

    fireEvent.click(screen.getByLabelText('Delete Unnamed import'));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Delete Unnamed import'));
    expect(onDelete).toHaveBeenCalledWith('b');
  });

  it('cancels renaming with Escape and ignores empty names', () => {
    const onRename = vi.fn();
    render(<RecentNetworks networks={[named]} disabled={false} onLoad={vi.fn()} onRename={onRename} />);
    fireEvent.click(screen.getByLabelText('Rename Schwedenplatz'));
    fireEvent.keyDown(screen.getByLabelText('Import name'), { key: 'Escape' });
    expect(screen.queryByLabelText('Import name')).toBeNull();
    fireEvent.click(screen.getByLabelText('Rename Schwedenplatz'));
    fireEvent.change(screen.getByLabelText('Import name'), { target: { value: '  ' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onRename).not.toHaveBeenCalled();
    expect(networkTitle({ ...named, name: undefined })).toBe('Unnamed import');
  });

  it('renders nothing without networks', () => {
    const { container } = render(<RecentNetworks networks={[]} disabled={false} onLoad={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
