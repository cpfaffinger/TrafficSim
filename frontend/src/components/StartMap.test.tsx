// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
});
