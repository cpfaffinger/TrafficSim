// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneCameraPad } from './SceneCameraPad';

const STEP = (15 * Math.PI) / 180;

describe('SceneCameraPad', () => {
  afterEach(cleanup);

  it('tilts, rotates, turns north up and switches between 2D and 3D', () => {
    const scene = { orbitBy: vi.fn(), setViewMode: vi.fn(), northUp: vi.fn() };
    render(<SceneCameraPad scene={() => scene} />);
    fireEvent.click(screen.getByLabelText('Tilt more (3D)'));
    expect(scene.orbitBy).toHaveBeenLastCalledWith(0, -STEP);
    fireEvent.click(screen.getByLabelText('Tilt less (towards top view)'));
    expect(scene.orbitBy).toHaveBeenLastCalledWith(0, STEP);
    fireEvent.click(screen.getByLabelText('Rotate right'));
    expect(scene.orbitBy).toHaveBeenLastCalledWith(STEP, 0);
    fireEvent.click(screen.getByLabelText('North up'));
    expect(scene.northUp).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Switch to 2D top view'));
    expect(scene.setViewMode).toHaveBeenLastCalledWith('2d', true);
    fireEvent.click(screen.getByLabelText('Switch to tilted 3D view'));
    expect(scene.setViewMode).toHaveBeenLastCalledWith('3d', false);
  });
});
