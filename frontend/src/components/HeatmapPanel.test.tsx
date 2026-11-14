// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeatmapPanel, type HeatmapPanelProps } from './HeatmapPanel';

afterEach(cleanup);

const props = (over: Partial<HeatmapPanelProps> = {}): HeatmapPanelProps => ({
  enabled: true,
  metric: 'speedRatio',
  smooth: false,
  range: [0, 10],
  bucket: null,
  live: true,
  replaying: false,
  timeOfDay: (b) => 25200 + b * 30,
  onEnabled: vi.fn(),
  onMetric: vi.fn(),
  onSmooth: vi.fn(),
  onBucket: vi.fn(),
  onLive: vi.fn(),
  onReplay: vi.fn(),
  ...over,
});

describe('HeatmapPanel', () => {
  it('wires metric, smoothing, timeline, replay and live', () => {
    const p = props();
    render(<HeatmapPanel {...p} />);
    expect(screen.getByText('7:05:00')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'density' } });
    fireEvent.click(screen.getByLabelText(/Smooth/));
    fireEvent.click(screen.getByLabelText(/Show heatmap/));
    fireEvent.change(screen.getByLabelText('Timeline'), { target: { value: '4' } });
    fireEvent.click(screen.getByText('Replay'));
    expect(p.onMetric).toHaveBeenCalledWith('density');
    expect(p.onSmooth).toHaveBeenCalledWith(true);
    expect(p.onEnabled).toHaveBeenCalledWith(false);
    expect(p.onBucket).toHaveBeenCalledWith(4);
    expect(p.onReplay).toHaveBeenCalledWith(true);
    expect((screen.getByText('Live') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the waiting hint without buckets and stop/live while replaying a past bucket', () => {
    const { rerender } = render(<HeatmapPanel {...props({ range: null })} />);
    expect(screen.getByText(/first 30 s bucket/)).toBeTruthy();
    const p = props({ bucket: 2, live: false, replaying: true, metric: 'density' });
    rerender(<HeatmapPanel {...p} />);
    fireEvent.click(screen.getByText('Live'));
    fireEvent.click(screen.getByText('Stop replay'));
    expect(p.onLive).toHaveBeenCalled();
    expect(p.onReplay).toHaveBeenCalledWith(false);
    expect(screen.getByText('120 veh/km+')).toBeTruthy();
  });

  it('shows the diverging legend and exit button while comparing runs (#74)', () => {
    const p = props({ comparing: 'B vs A', onExitCompare: vi.fn() });
    render(<HeatmapPanel {...p} />);
    expect(screen.getByText(/Comparing B vs A/)).toBeTruthy();
    expect(screen.queryByLabelText('Timeline')).toBeNull();
    fireEvent.click(screen.getByText('Exit comparison'));
    expect(p.onExitCompare).toHaveBeenCalled();
  });
});
