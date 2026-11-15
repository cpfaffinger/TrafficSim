// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartMap } from './StartMap';

const sources = () => Array.from(document.querySelectorAll('.start-map img')).map((i) => i.getAttribute('src'));

describe('StartMap', () => {
  afterEach(cleanup);

  it('starts on the OSM map at zoom 7 with Austria in the middle', () => {
    render(<StartMap />);
    // Austria's centre (47.6 N, 13.35 E) lies in tile 7/68/44.
    expect(sources()).toContain('https://tile.openstreetmap.org/7/68/44.png');
    expect(sources().every((s) => s?.startsWith('https://tile.openstreetmap.org/7/'))).toBe(true);
    expect(screen.getByRole('link', { name: 'OpenStreetMap' }).getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
  });

  it('zooms by whole levels with the buttons', () => {
    render(<StartMap />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(sources().every((s) => s?.includes('/8/'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(sources().every((s) => s?.includes('/6/'))).toBe(true);
  });

  it('adds a corner where the map is clicked while drawing, but not when it is dragged (#142)', () => {
    const onPick = vi.fn();
    render(<StartMap ring={[]} onPick={onPick} />);
    const map = document.querySelector('.start-map')!;
    // jsdom: the map is 1024 x 768 at (0, 0); its centre is the start view's centre.
    fireEvent.pointerDown(map, { pointerId: 1, clientX: 512, clientY: 384 });
    fireEvent.pointerUp(map, { pointerId: 1, clientX: 512, clientY: 384 });
    expect(onPick).toHaveBeenCalledTimes(1);
    const [lon, lat] = onPick.mock.calls[0]![0] as [number, number];
    expect(lon).toBeCloseTo(13.35, 3);
    expect(lat).toBeCloseTo(47.6, 3);
    fireEvent.pointerDown(map, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(map, { pointerId: 2, clientX: 160, clientY: 120 });
    fireEvent.pointerUp(map, { pointerId: 2, clientX: 160, clientY: 120 });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('draws the outline, closed from three corners', () => {
    const { rerender } = render(
      <StartMap
        ring={[
          [13.3, 47.6],
          [13.4, 47.6],
        ]}
        onPick={vi.fn()}
      />,
    );
    expect(document.querySelector('.start-map-outline polyline')).not.toBeNull();
    rerender(
      <StartMap
        ring={[
          [13.3, 47.6],
          [13.4, 47.6],
          [13.35, 47.7],
        ]}
        onPick={vi.fn()}
      />,
    );
    expect(document.querySelector('.start-map-outline polygon')).not.toBeNull();
    expect(document.querySelectorAll('.start-map-outline circle')).toHaveLength(3);
  });
});
