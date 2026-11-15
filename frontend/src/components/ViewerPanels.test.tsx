// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect, PackageIndex } from '../network/inspect';
import { loadGoldenFixture } from '../test/goldenFixture';
import { AboutDialog } from './AboutDialog';
import { SceneCredit } from './SceneCredit';
import { ImportProgress } from './ImportProgress';
import { InspectorPanel } from './InspectorPanel';
import { ModeTabs } from './ModeTabs';
import { NetworkSummaryPanel } from './NetworkSummaryPanel';
import { ViewToolbar } from './ViewToolbar';

afterEach(cleanup);

const pkg = loadGoldenFixture();

describe('InspectorPanel', () => {
  it('keeps the scene clear without selection (#128)', () => {
    const { container } = render(<InspectorPanel model={null} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders sections, values and assumed markers', () => {
    const onClose = vi.fn();
    const model = inspect(new PackageIndex(pkg), { kind: 'lane', linkId: 'l1', laneIndex: 0 });
    render(<InspectorPanel model={model} onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'Lane l1:0' })).toBeTruthy();
    expect(screen.getByText('through, right')).toBeTruthy();
    expect(screen.getAllByTitle(/Assumed/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('attribution and legal', () => {
  it('credits OpenStreetMap on the map and links the sources page (#128)', () => {
    const onSources = vi.fn();
    render(<SceneCredit onSources={onSources} />);
    expect(screen.getByRole('link', { name: '© OpenStreetMap' }).getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    expect(onSources).toHaveBeenCalled();
  });

  it('shows licence and ODbL notice, closes on Escape and backdrop click', () => {
    const onClose = vi.fn();
    const { rerender } = render(<AboutDialog open={false} version="1.0" attributions={[]} onClose={onClose} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<AboutDialog open version="1.0" attributions={['OpenFreeMap © OpenMapTiles']} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'About TrafficSim' });
    expect(dialog.textContent).toContain('MIT License');
    expect(dialog.textContent).toContain('Open Database License (ODbL)');
    expect(dialog.textContent).toContain('version 1.0');
    expect(screen.getByText('OpenFreeMap © OpenMapTiles')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Close');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ModeTabs', () => {
  it('switches modes by click and arrow keys', () => {
    const onChange = vi.fn();
    render(<ModeTabs mode="network" onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'Network viewer' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Ring road demo' }));
    expect(onChange).toHaveBeenLastCalledWith('ring');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Network viewer' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('ring');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Network viewer' }), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('ViewToolbar', () => {
  it('toggles layers, resets and reports basemap status', () => {
    const props = {
      showBasemap: true,
      showTunnels: true,
      basemapStatus: 'unavailable' as const,
      canReset: true,
      onShowBasemap: vi.fn(),
      onShowTunnels: vi.fn(),
      onReset: vi.fn(),
    };
    render(<ViewToolbar {...props} />);
    fireEvent.click(screen.getByLabelText('Basemap'));
    fireEvent.click(screen.getByLabelText('Tunnels'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(props.onShowBasemap).toHaveBeenCalledWith(false);
    expect(props.onShowTunnels).toHaveBeenCalledWith(false);
    expect(props.onReset).toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('plain ground');
  });

});

describe('summaries', () => {
  it('shows import progress and failures', () => {
    const { rerender } = render(<ImportProgress phase="compiling" error={null} />);
    expect(screen.getByText('Compiling the lane graph…')).toBeTruthy();
    rerender(<ImportProgress phase="failed" error="Overpass timed out" />);
    expect(screen.getByText('Import failed: Overpass timed out')).toBeTruthy();
  });

  it('shows the loaded network figures', () => {
    render(<NetworkSummaryPanel pkg={pkg} />);
    expect(screen.getByText('2026-11-14')).toBeTruthy();
    expect(screen.getByText('16')).toBeTruthy();
  });
});
