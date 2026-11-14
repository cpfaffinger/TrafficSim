// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controls, type ControlsProps } from './Controls';

afterEach(cleanup);

function setup(overrides: Partial<ControlsProps> = {}) {
  const props: ControlsProps = {
    settings: { vehicleCount: 22, length: 230, heterogeneity: 0, seed: 1 },
    speedFactor: 1,
    playing: false,
    onSettingsChange: vi.fn(),
    onSpeedChange: vi.fn(),
    onTogglePlay: vi.fn(),
    onPerturb: vi.fn(),
    onRestart: vi.fn(),
    ...overrides,
  };
  render(<Controls {...props} />);
  return props;
}

describe('Controls', () => {
  it('emits changed settings', () => {
    const props = setup();

    fireEvent.change(screen.getByLabelText(/Vehicles/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/Driver diversity/), { target: { value: '0.2' } });

    expect(props.onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ vehicleCount: 30 }));
    expect(props.onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ heterogeneity: 0.2 }));
  });

  it('emits speed, play, perturb and restart actions', () => {
    const props = setup({ playing: true });

    fireEvent.change(screen.getByLabelText(/Simulation speed/), { target: { value: '10' } });
    fireEvent.click(screen.getByText('Pause'));
    fireEvent.click(screen.getByText('Brake one car'));
    fireEvent.click(screen.getByText('Restart'));

    expect(props.onSpeedChange).toHaveBeenCalledWith(10);
    expect(props.onTogglePlay).toHaveBeenCalled();
    expect(props.onPerturb).toHaveBeenCalled();
    expect(props.onRestart).toHaveBeenCalled();
  });
});
