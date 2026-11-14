import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendStatus } from '../api/client';
import { Controls } from '../components/Controls';
import { StatusPanel } from '../components/StatusPanel';
import { binSpeedRatios } from '../lib/spaceTime';
import { RingRoadScene } from '../scene/RingRoadScene';
import { SpaceTimeCanvas } from '../scene/SpaceTimeCanvas';
import { unpackSnapshot, type RingSettings } from '../sim/protocol';
import { SimClient } from '../sim/simClient';

const DEFAULT_SETTINGS: RingSettings = { vehicleCount: 22, length: 230, heterogeneity: 0.05, seed: 1 };
const SPACE_TIME_CELLS = 115;
const UI_REFRESH_MS = 250;

interface Stats {
  time: number;
  meanSpeed: number;
  vehicleCount: number;
}

export interface RingDemoProps {
  status: BackendStatus | 'unknown';
  version: string | null;
}

/** The Phase 0 ring-road experiment (phantom traffic jams) with the WASM simulation worker. */
export function RingDemo({ status, version }: RingDemoProps) {
  const sceneHost = useRef<HTMLDivElement>(null);
  const heatmapCanvas = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<SimClient | null>(null);

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [speedFactor, setSpeedFactor] = useState(5);
  const [playing, setPlaying] = useState(true);
  const [stats, setStats] = useState<Stats>({ time: 0, meanSpeed: 0, vehicleCount: 0 });
  const [error, setError] = useState<string | null>(null);

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
    <div className="ring-view">
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
      </aside>
      <div className="scene" ref={sceneHost} role="img" aria-label="3D ring road" />
      <section className="heatmap" aria-label="Space-time diagram">
        <canvas ref={heatmapCanvas} />
        <span className="caption">Space-time diagram — position ↑, time →; red stripes are stop-and-go waves</span>
      </section>
    </div>
  );
}
