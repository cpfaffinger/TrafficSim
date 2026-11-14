// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClock, SimulationPanel, type SimulationPanelProps } from './SimulationPanel';

afterEach(cleanup);

const base = (over: Partial<SimulationPanelProps> = {}): SimulationPanelProps => ({
  running: false,
  ready: true,
  speed: 1,
  settings: { demandScale: 100, truckShare: 0.1, seed: 1 },
  stats: null,
  time: 3725,
  vehicles: 12,
  error: null,
  onPlay: vi.fn(),
  onPause: vi.fn(),
  onReset: vi.fn(),
  onSpeed: vi.fn(),
  onSettings: vi.fn(),
  ...over,
});

describe('SimulationPanel', () => {
  it('formats the clock', () => {
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00:00');
  });

  it('wires controls and shows stats', () => {
    const props = base({
      stats: { time: 1, spawned: 5, arrived: 2, active: 3, waitingToEnter: 1, rerouted: 0, stranded: 0, unroutable: 0, laneChanges: 0, forcedEntries: 0, meanTravelTime: 61.4, meanSpeed: 10 },
      error: 'boom',
    });
    render(<SimulationPanel {...props} />);
    fireEvent.click(screen.getByText('Play'));
    fireEvent.click(screen.getByText('Restart'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Demand level (%)'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText('Truck share (%)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '7' } });

    expect(props.onPlay).toHaveBeenCalled();
    expect(props.onReset).toHaveBeenCalled();
    expect(props.onSpeed).toHaveBeenCalledWith(5);
    expect(props.onSettings).toHaveBeenCalledWith({ demandScale: 150, truckShare: 0.1, seed: 1 });
    expect(props.onSettings).toHaveBeenCalledWith({ demandScale: 100, truckShare: 0.2, seed: 1 });
    expect(props.onSettings).toHaveBeenCalledWith({ demandScale: 100, truckShare: 0.1, seed: 7 });
    expect(screen.getByText('36.0 km/h')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('1:02:05')).toBeTruthy();
  });

  it('shows pause while running', () => {
    const props = base({ running: true });
    render(<SimulationPanel {...props} />);
    fireEvent.click(screen.getByText('Pause'));
    expect(props.onPause).toHaveBeenCalled();
  });
});
