// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ring } from '../lib/polygonArea';
import { PolygonDrawer, type PolygonDrawerProps } from './PolygonDrawer';

afterEach(cleanup);

const triangle: Ring = [
  [16.36, 48.2],
  [16.37, 48.2],
  [16.365, 48.21],
];

const props = (over: Partial<PolygonDrawerProps> = {}): PolygonDrawerProps => ({
  ring: triangle,
  busy: false,
  onUndo: vi.fn(),
  onClear: vi.fn(),
  onRectangle: vi.fn(),
  onImport: vi.fn(),
  onCancel: vi.fn(),
  ...over,
});

describe('PolygonDrawer', () => {
  it('is importable as soon as three corners close the outline', () => {
    const p = props();
    render(<PolygonDrawer {...p} />);
    expect(screen.getByText(/closes automatically/)).toBeTruthy();
    fireEvent.click(screen.getByText('Import this area'));
    fireEvent.click(screen.getByText('Undo corner'));
    fireEvent.click(screen.getByText('Clear'));
    fireEvent.click(screen.getByText('Use a rectangle'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(p.onImport).toHaveBeenCalled();
    expect(p.onUndo).toHaveBeenCalled();
    expect(p.onClear).toHaveBeenCalled();
    expect(p.onRectangle).toHaveBeenCalled();
    expect(p.onCancel).toHaveBeenCalled();
  });

  it('needs three corners and a valid outline', () => {
    const { rerender } = render(<PolygonDrawer {...props({ ring: triangle.slice(0, 1) })} />);
    expect(screen.getByText(/2 more to close/)).toBeTruthy();
    expect((screen.getByText('Import this area') as HTMLButtonElement).disabled).toBe(true);
    const bowtie: Ring = [
      [16.36, 48.2],
      [16.37, 48.21],
      [16.36, 48.21],
      [16.37, 48.2],
    ];
    rerender(<PolygonDrawer {...props({ ring: bowtie })} />);
    expect(screen.getByText(/must not cross/)).toBeTruthy();
  });
});
