import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SimulationSettings } from '../components/SimulationPanel';
import type { NetworkPackage } from '../network/types';
import type { NetworkScene } from '../scene/NetworkScene';
import { buildConfig, NETWORK_SNAPSHOT_STRIDE, type DebugKind, type SimStats, type VehicleInfo } from '../sim/networkProtocol';
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
  /** Watched vehicle (#125): its latest state; `left` once it reached its destination. */
  const [vehicle, setVehicle] = useState<{ info: VehicleInfo; left: boolean } | null>(null);
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
    setVehicle(null);
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
          if (message.pedestrians) sceneRef.current?.updatePedestrians(message.pedestrians);
          setTime(message.time);
          setTimeOfDay(message.timeOfDay);
          setVehicles(message.vehicles);
          if (message.stats) setStats(message.stats);
          if (message.vehicle !== undefined) {
            const info = message.vehicle;
            setVehicle((v) => (info ? { info, left: false } : v ? { info: v.info, left: true } : null));
          }
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
  const watchVehicle = useCallback((id: number | null) => {
    if (id === null) setVehicle(null);
    clientRef.current?.watchVehicle(id);
  }, []);

  const requestDebug = useCallback(
    (kind: DebugKind, id: string, lane?: number) =>
      clientRef.current ? clientRef.current.requestDebug(kind, id, lane) : Promise.reject(new Error('The simulation is not running.')),
    [],
  );

  return {
    ready,
    running,
    speed,
    time,
    timeOfDay,
    vehicles,
    stats,
    error,
    play,
    pause,
    restart,
    setSpeed,
    requestResults,
    generation,
    vehicle,
    watchVehicle,
    requestDebug,
  };
}
