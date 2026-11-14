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
  closed: false,
  busy: false,
  onUndo: vi.fn(),
  onClear: vi.fn(),
  onFinish: vi.fn(),
  onRectangle: vi.fn(),
  onImport: vi.fn(),
  onCancel: vi.fn(),
  ...over,
});

describe('PolygonDrawer', () => {
  it('finishes, edits and imports a valid shape', () => {
    const p = props();
    const { rerender } = render(<PolygonDrawer {...p} />);
    expect((screen.getByText('Import this area') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Finish shape'));
    fireEvent.click(screen.getByText('Undo corner'));
    fireEvent.click(screen.getByText('Clear'));
    fireEvent.click(screen.getByText('Use a rectangle'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(p.onFinish).toHaveBeenCalled();
    expect(p.onUndo).toHaveBeenCalled();
    expect(p.onClear).toHaveBeenCalled();
    expect(p.onRectangle).toHaveBeenCalled();
    expect(p.onCancel).toHaveBeenCalled();
    expect(screen.getByText('3')).toBeTruthy();

    rerender(<PolygonDrawer {...p} closed />);
    fireEvent.click(screen.getByText('Import this area'));
    expect(p.onImport).toHaveBeenCalled();
  });

  it('explains invalid shapes', () => {
    const bowtie: Ring = [
      [16.36, 48.2],
      [16.37, 48.21],
      [16.36, 48.21],
      [16.37, 48.2],
    ];
    render(<PolygonDrawer {...props({ ring: bowtie })} />);
    expect(screen.getByText(/must not cross/)).toBeTruthy();
    expect((screen.getByText('Finish shape') as HTMLButtonElement).disabled).toBe(true);
  });
});
