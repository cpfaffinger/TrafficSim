import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SimulationSettings } from '../components/SimulationPanel';
import type { NetworkPackage } from '../network/types';
import type { NetworkScene } from '../scene/NetworkScene';
import { buildConfig, NETWORK_SNAPSHOT_STRIDE, type SimStats } from '../sim/networkProtocol';
import { NetworkSimClient } from '../sim/networkSimClient';
import { SnapshotBuffer } from '../sim/snapshotBuffer';

/** Glue between the network simulation worker and the scene (#47). */
export function useNetworkSimulation(
  pkg: NetworkPackage | null,
  settings: SimulationSettings,
  sceneRef: RefObject<NetworkScene | null>,
  scenarioDemand?: unknown,
  onCells?: (blob: ArrayBuffer) => void,
  onResults?: (results: { summaryJson: string; cells: ArrayBuffer; time: number }) => void,
) {
  const onCellsRef = useRef(onCells);
  onCellsRef.current = onCells;
  const onResultsRef = useRef(onResults);
  onResultsRef.current = onResults;
  const clientRef = useRef<NetworkSimClient | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [speed, setSpeedState] = useState(5);
  const [time, setTime] = useState(0);
  const [timeOfDay, setTimeOfDay] = useState<number | null>(null);
  const demandKey = scenarioDemand === undefined ? '' : JSON.stringify(scenarioDemand);
  const [vehicles, setVehicles] = useState(0);
  const [stats, setStats] = useState<SimStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    if (!pkg) return;
    const client = NetworkSimClient.create();
    clientRef.current = client;
    setReady(false);
    setRunning(false);
    setStats(null);
    setError(null);
    sceneRef.current?.clearSimulation();
    let shared: SnapshotBuffer | null = null;
    const unsubscribe = client.subscribe((message) => {
      switch (message.type) {
        case 'ready':
          sceneRef.current?.prepareSimulation(pkg, message.signalGroupIds);
          setReady(true);
          break;
        case 'buffer':
          shared = new SnapshotBuffer(message.buffer, NETWORK_SNAPSHOT_STRIDE);
          break;
        case 'frame': {
          const snapshot = message.snapshot ?? shared?.read();
          if (snapshot) sceneRef.current?.updateSimulation(snapshot, message.signals);
          setTime(message.time);
          setTimeOfDay(message.timeOfDay);
          setVehicles(message.vehicles);
          if (message.stats) setStats(message.stats);
          break;
        }
        case 'cells':
          onCellsRef.current?.(message.blob);
          break;
        case 'results':
          onResultsRef.current?.(message);
          break;
        case 'error':
          setError(message.message);
          setRunning(false);
          break;
      }
    });
    client.setSpeed(speedRef.current);
    client.init({
      packageJson: JSON.stringify(pkg),
      configJson: buildConfig(
        { demandScale: settings.demandScale, truckShare: settings.truckShare, heterogeneity: 0.1 },
        demandKey ? (JSON.parse(demandKey) as unknown) : undefined,
      ),
      seed: settings.seed,
    });
    return () => {
      unsubscribe();
      client.dispose();
      clientRef.current = null;
    };
    // Restart on a new package, new settings or an explicit restart.
  }, [pkg, settings.demandScale, settings.truckShare, settings.seed, generation, sceneRef, demandKey]);

  const play = useCallback(() => {
    clientRef.current?.play();
    setRunning(true);
  }, []);
  const pause = useCallback(() => {
    clientRef.current?.pause();
    setRunning(false);
  }, []);
  const restart = useCallback(() => setGeneration((g) => g + 1), []);
  const setSpeed = useCallback((factor: number) => {
    setSpeedState(factor);
    clientRef.current?.setSpeed(factor);
  }, []);

  const requestResults = useCallback(() => clientRef.current?.requestResults(), []);

  return { ready, running, speed, time, timeOfDay, vehicles, stats, error, play, pause, restart, setSpeed, requestResults, generation };
}
