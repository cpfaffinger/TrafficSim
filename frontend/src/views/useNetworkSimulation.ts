import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SimulationSettings } from '../components/SimulationPanel';
import type { NetworkPackage } from '../network/types';
import type { NetworkScene } from '../scene/NetworkScene';
import { buildConfig, NETWORK_SNAPSHOT_STRIDE, type SimStats } from '../sim/networkProtocol';
import { NetworkSimClient } from '../sim/networkSimClient';
import { SnapshotBuffer } from '../sim/snapshotBuffer';

/** Glue between the network simulation worker and the scene (#47). */
export function useNetworkSimulation(pkg: NetworkPackage | null, settings: SimulationSettings, sceneRef: RefObject<NetworkScene | null>) {
  const clientRef = useRef<NetworkSimClient | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [speed, setSpeedState] = useState(5);
  const [time, setTime] = useState(0);
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
          setVehicles(message.vehicles);
          if (message.stats) setStats(message.stats);
          break;
        }
        case 'error':
          setError(message.message);
          setRunning(false);
          break;
      }
    });
    client.setSpeed(speedRef.current);
    client.init({
      packageJson: JSON.stringify(pkg),
      configJson: buildConfig({ vehiclesPerHour: settings.vehiclesPerHour, truckShare: settings.truckShare, heterogeneity: 0.1 }),
      seed: settings.seed,
    });
    return () => {
      unsubscribe();
      client.dispose();
      clientRef.current = null;
    };
    // Restart on a new package, new settings or an explicit restart.
  }, [pkg, settings.vehiclesPerHour, settings.truckShare, settings.seed, generation, sceneRef]);

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

  return { ready, running, speed, time, vehicles, stats, error, play, pause, restart, setSpeed };
}
