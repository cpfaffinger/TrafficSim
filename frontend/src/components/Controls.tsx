import type { RingSettings } from '../sim/protocol';

export interface ControlsProps {
  settings: RingSettings;
  speedFactor: number;
  playing: boolean;
  onSettingsChange: (settings: RingSettings) => void;
  onSpeedChange: (factor: number) => void;
  onTogglePlay: () => void;
  onPerturb: () => void;
  onRestart: () => void;
}

export const SPEED_FACTORS = [1, 2, 5, 10, 20] as const;

export function Controls(props: ControlsProps) {
  const { settings, speedFactor, playing } = props;
  const update = (patch: Partial<RingSettings>) => props.onSettingsChange({ ...settings, ...patch });

  return (
    <section aria-label="Simulation controls">
      <h2>Ring road experiment</h2>
      <div className="field">
        <label htmlFor="vehicles">
          Vehicles <span>{settings.vehicleCount}</span>
        </label>
        <input
          id="vehicles"
          type="range"
          min={5}
          max={40}
          value={settings.vehicleCount}
          onChange={(e) => update({ vehicleCount: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label htmlFor="heterogeneity">
          Driver diversity <span>{Math.round(settings.heterogeneity * 100)} %</span>
        </label>
        <input
          id="heterogeneity"
          type="range"
          min={0}
          max={0.3}
          step={0.01}
          value={settings.heterogeneity}
          onChange={(e) => update({ heterogeneity: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label htmlFor="speed">
          Simulation speed <span>{speedFactor}×</span>
        </label>
        <select id="speed" value={speedFactor} onChange={(e) => props.onSpeedChange(Number(e.target.value))}>
          {SPEED_FACTORS.map((f) => (
            <option key={f} value={f}>
              {f}×
            </option>
          ))}
        </select>
      </div>
      <div className="buttons">
        <button type="button" className="primary" onClick={props.onTogglePlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" onClick={props.onPerturb} title="One driver brakes sharply">
          Brake one car
        </button>
        <button type="button" onClick={props.onRestart}>
          Restart
        </button>
      </div>
    </section>
  );
}
