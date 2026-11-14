import type { SimStats } from '../sim/networkProtocol';

export interface SimulationSettings {
  /** Demand level in percent of the scenario / road-class profiles (#115). */
  demandScale: number;
  truckShare: number;
  seed: number;
}

export interface SimulationPanelProps {
  running: boolean;
  ready: boolean;
  speed: number;
  settings: SimulationSettings;
  stats: SimStats | null;
  time: number;
  /** Time of day in seconds, when known. */
  timeOfDay?: number | null;
  /** Name of the scenario whose demand is simulated, if any. */
  scenarioName?: string | null;
  vehicles: number;
  error: string | null;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSpeed: (factor: number) => void;
  onSettings: (settings: SimulationSettings) => void;
}

const SPEEDS = [1, 2, 5, 10, 20];

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Playback controls and live statistics of the network simulation (#47). */
export function SimulationPanel(props: SimulationPanelProps) {
  const { settings, stats } = props;
  return (
    <section className="sim-panel" aria-label="Simulation">
      <h2>Simulation</h2>
      <div className="sim-buttons">
        {props.running ? (
          <button type="button" onClick={props.onPause} disabled={!props.ready}>
            Pause
          </button>
        ) : (
          <button type="button" onClick={props.onPlay} disabled={!props.ready}>
            Play
          </button>
        )}
        <button type="button" onClick={props.onReset}>
          Restart
        </button>
        <label>
          Speed{' '}
          <select value={props.speed} onChange={(e) => props.onSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="sim-settings">
        <label>
          Demand level (%)
          <input
            type="number"
            min={0}
            max={500}
            step={10}
            value={settings.demandScale}
            onChange={(e) => props.onSettings({ ...settings, demandScale: Number(e.target.value) })}
          />
        </label>
        <label>
          Truck share (%)
          <input
            type="number"
            min={0}
            max={50}
            value={Math.round(settings.truckShare * 100)}
            onChange={(e) => props.onSettings({ ...settings, truckShare: Number(e.target.value) / 100 })}
          />
        </label>
        <label>
          Seed
          <input type="number" min={0} value={settings.seed} onChange={(e) => props.onSettings({ ...settings, seed: Number(e.target.value) })} />
        </label>
      </div>
      <p className="muted sim-demand-source">
        {props.scenarioName ? `Demand: scenario “${props.scenarioName}”` : 'Demand: road-class profiles (open a scenario for full demand)'}
      </p>
      {props.error && <p className="error">{props.error}</p>}
      <dl className="stats">
        <dt>Time</dt>
        <dd>{formatClock(props.time)}</dd>
        {props.timeOfDay !== undefined && props.timeOfDay !== null && (
          <>
            <dt>Time of day</dt>
            <dd>{formatClock(props.timeOfDay % 86400)}</dd>
          </>
        )}
        <dt>Vehicles</dt>
        <dd>{props.vehicles}</dd>
        {stats && (
          <>
            <dt>Spawned / arrived</dt>
            <dd>
              {stats.spawned} / {stats.arrived}
            </dd>
            <dt>Waiting to enter</dt>
            <dd>{stats.waitingToEnter}</dd>
            <dt>Mean speed</dt>
            <dd>{(stats.meanSpeed * 3.6).toFixed(1)} km/h</dd>
            <dt>Mean travel time</dt>
            <dd>{stats.meanTravelTime.toFixed(0)} s</dd>
          </>
        )}
      </dl>
    </section>
  );
}
