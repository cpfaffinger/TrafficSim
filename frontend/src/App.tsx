import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClient, type BackendStatus } from './api/client';
import { Controls } from './components/Controls';
import { StatusPanel } from './components/StatusPanel';
import { binSpeedRatios } from './lib/spaceTime';
import { RingRoadScene } from './scene/RingRoadScene';
import { SpaceTimeCanvas } from './scene/SpaceTimeCanvas';
import { unpackSnapshot, type RingSettings } from './sim/protocol';
import { SimClient } from './sim/simClient';

const DEFAULT_SETTINGS: RingSettings = { vehicleCount: 22, length: 230, heterogeneity: 0.05, seed: 1 };
const SPACE_TIME_CELLS = 115;
const UI_REFRESH_MS = 250;

interface Stats {
  time: number;
  meanSpeed: number;
  vehicleCount: number;
}

export function App() {
  const sceneHost = useRef<HTMLDivElement>(null);
  const heatmapCanvas = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<SimClient | null>(null);

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [speedFactor, setSpeedFactor] = useState(5);
  const [playing, setPlaying] = useState(true);
  const [stats, setStats] = useState<Stats>({ time: 0, meanSpeed: 0, vehicleCount: 0 });
  const [status, setStatus] = useState<BackendStatus | 'unknown'>('unknown');
  const [version, setVersion] = useState<string | null>(null);
  const [attributions, setAttributions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Backend status and metadata.
  useEffect(() => {
    const api = new ApiClient();
    const controller = new AbortController();
    const refresh = () =>
      api
        .getStatus(controller.signal)
        .then(setStatus)
        .catch(() => undefined);
    refresh();
    api
      .getMeta(controller.signal)
      .then((meta) => {
        setVersion(meta.version);
        setAttributions(meta.attributions);
      })
      .catch(() => undefined);
    const interval = setInterval(refresh, 15_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  // Scene, heatmap and simulation worker lifecycle.
  useEffect(() => {
    if (!sceneHost.current || !heatmapCanvas.current) return;
    const scene = new RingRoadScene(sceneHost.current);
    const spaceTime = new SpaceTimeCanvas(heatmapCanvas.current, SPACE_TIME_CELLS);
    const sim = SimClient.create();
    simRef.current = sim;
    let lastUi = 0;

    const unsubscribe = sim.subscribe((message) => {
      switch (message.type) {
        case 'frame': {
          scene.setRing(message.length);
          scene.update(message.snapshot, message.desiredSpeed);
          const vehicles = unpackSnapshot(message.snapshot);
          spaceTime.push(binSpeedRatios(vehicles, message.length, SPACE_TIME_CELLS, message.desiredSpeed));
          const now = performance.now();
          if (now - lastUi > UI_REFRESH_MS) {
            lastUi = now;
            setStats({ time: message.time, meanSpeed: message.meanSpeed, vehicleCount: vehicles.length });
          }
          break;
        }
        case 'error':
          setError(message.message);
          break;
        case 'ready':
          setError(null);
          spaceTime.clear();
          break;
      }
    });

    return () => {
      unsubscribe();
      sim.dispose();
      scene.dispose();
      simRef.current = null;
    };
  }, []);

  useEffect(() => {
    simRef.current?.init(settings);
  }, [settings]);

  useEffect(() => {
    simRef.current?.setSpeed(speedFactor);
  }, [speedFactor]);

  useEffect(() => {
    if (playing) simRef.current?.play();
    else simRef.current?.pause();
  }, [playing]);

  const restart = useCallback(() => setSettings((s) => ({ ...s, seed: s.seed + 1 })), []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>TrafficSim</h1>
        <span className="badge">Phase 0 · walking skeleton</span>
      </header>
      <aside className="panel">
        <Controls
          settings={settings}
          speedFactor={speedFactor}
          playing={playing}
          onSettingsChange={setSettings}
          onSpeedChange={setSpeedFactor}
          onTogglePlay={() => setPlaying((p) => !p)}
          onPerturb={() => simRef.current?.perturb(0, 0.2)}
          onRestart={restart}
        />
        <section aria-label="Legend">
          <h2>Speed</h2>
          <div className="legend" />
          <div className="legend-labels">
            <span>standing</span>
            <span>free flow</span>
          </div>
        </section>
        <StatusPanel
          status={status}
          version={version}
          simTime={stats.time}
          meanSpeed={stats.meanSpeed}
          vehicleCount={stats.vehicleCount}
        />
        {error && <p className="error">Simulation error: {error}</p>}
        <footer className="attribution">
          {(attributions.length ? attributions : ['Map data © OpenStreetMap contributors (ODbL)']).map((a) => (
            <div key={a}>{a}</div>
          ))}
        </footer>
      </aside>
      <main className="scene" ref={sceneHost} aria-label="3D ring road" />
      <section className="heatmap" aria-label="Space-time diagram">
        <canvas ref={heatmapCanvas} />
        <span className="caption">Space-time diagram — position ↑, time →; red stripes are stop-and-go waves</span>
      </section>
    </div>
  );
}
