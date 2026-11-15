// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneCompass } from './SceneCompass';

describe('SceneCompass', () => {
  afterEach(cleanup);

  it('turns the view north up when clicked', () => {
    const scene = { cameraYaw: vi.fn(() => 0.5), northUp: vi.fn() };
    render(<SceneCompass scene={() => scene} />);
    fireEvent.click(screen.getByRole('button', { name: 'North up' }));
    expect(scene.northUp).toHaveBeenCalled();
  });
});
