/// <reference lib="webworker" />
// Network simulation worker (#47): owns a sim-core NetworkSim and advances it in fixed steps.
import init, { builtinRoadClassProfilesJson, NetworkSim } from '../generated/sim-core/trafficsim_sim_core.js';
import { scaleDemand } from './demandScale';
import { stepsFor } from './protocol';
import { NETWORK_SNAPSHOT_STRIDE, type FromNetworkWorker, type SimStats, type ToNetworkWorker } from './networkProtocol';
import { sharedMemoryAvailable, SnapshotBuffer } from './snapshotBuffer';

const TICK_MS = 33;
const MAX_STEPS_PER_TICK = 600;
const STATS_EVERY_MS = 500;

let sim: NetworkSim | null = null;
let playing = false;
let speedFactor = 1;
let carry = 0;
let last = performance.now();
let lastStats = 0;
let ready: Promise<unknown> | null = null;
let shared: SnapshotBuffer | null = null;
let sentBuckets = 0;
/** The package has pedestrian crossings (ADR-0020): frames carry the pedestrian snapshot. */
let hasCrossings = false;

function postCells(): void {
  if (!sim) return;
  const finished = sim.laneCellBuckets;
  if (finished <= sentBuckets) return;
  const blob = sim.laneCellsSince(sentBuckets);
  sentBuckets = finished;
  post({ type: 'cells', blob: blob.buffer as ArrayBuffer }, [blob.buffer as ArrayBuffer]);
}
const useShared = sharedMemoryAvailable();

const post = (message: FromNetworkWorker, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

function postFrame(forceStats = false): void {
  if (!sim) return;
  const now = performance.now();
  const withStats = forceStats || now - lastStats > STATS_EVERY_MS;
  if (withStats) lastStats = now;
  const snapshot = sim.snapshot();
  const signals = sim.signalStates();
  const stats = withStats ? (JSON.parse(sim.statsJson()) as SimStats) : null;
  const vehicles = snapshot.length / NETWORK_SNAPSHOT_STRIDE;
  const pedestrians = hasCrossings ? sim.pedestrianSnapshot() : undefined;
  const extra: Transferable[] = pedestrians ? [pedestrians.buffer as ArrayBuffer] : [];
  if (useShared) {
    if (!shared || !shared.fits(snapshot)) {
      shared = SnapshotBuffer.allocate(Math.max(4096, vehicles * 2), NETWORK_SNAPSHOT_STRIDE, true);
      post({ type: 'buffer', buffer: shared.buffer as SharedArrayBuffer });
    }
    shared.publish(snapshot);
    post({ type: 'frame', time: sim.time, timeOfDay: sim.timeOfDay, snapshot: null, vehicles, signals, stats, pedestrians }, [signals.buffer, ...extra]);
    return;
  }
  post({ type: 'frame', time: sim.time, timeOfDay: sim.timeOfDay, snapshot, vehicles, signals, stats, pedestrians }, [snapshot.buffer, signals.buffer, ...extra]);
}

function tick(): void {
  const now = performance.now();
  if (sim && playing) {
    const result = stepsFor(now - last, sim.timeStep, speedFactor, carry);
    const steps = Math.min(result.steps, MAX_STEPS_PER_TICK);
    // Drop the backlog when the core cannot keep up instead of spiralling.
    carry = steps < result.steps ? 0 : result.carry;
    if (steps > 0) sim.step(steps);
    postFrame();
    postCells();
  }
  last = now;
}

setInterval(tick, TICK_MS);

self.onmessage = async (event: MessageEvent<ToNetworkWorker>) => {
  const message = event.data;
  try {
    ready ??= init();
    await ready;
    switch (message.type) {
      case 'init': {
        sim?.free();
        sim = null;
        const { packageJson, configJson, seed } = message.settings;
        const config = JSON.parse(configJson || '{}') as Record<string, unknown>;
        const scale = typeof config.demandScale === 'number' ? config.demandScale : 1;
        delete config.demandScale;
        const resolved = scaleDemand(config, scale, JSON.parse(builtinRoadClassProfilesJson()) as Record<string, { volumePerLane: number }>);
        sim = new NetworkSim(packageJson, JSON.stringify(resolved), BigInt(Math.max(0, Math.floor(seed))));
        sentBuckets = 0;
        carry = 0;
        const groups = JSON.parse(sim.signalGroupIdsJson()) as string[];
        const pkg = JSON.parse(packageJson) as { nodes: { id: string; control: string }[]; links: { from: string }[]; crossings?: unknown[] };
        hasCrossings = (pkg.crossings?.length ?? 0) > 0;
        const from = new Set(pkg.links.map((l) => l.from));
        const entries = pkg.nodes.filter((n) => n.control === 'boundary' && from.has(n.id)).map((n) => n.id);
        post({ type: 'ready', timeStep: sim.timeStep, signalGroupIds: groups, entries });
        postFrame(true);
        break;
      }
      case 'play':
        playing = true;
        last = performance.now();
        break;
      case 'pause':
        playing = false;
        postFrame(true);
        break;
      case 'speed':
        speedFactor = message.factor;
        break;
      case 'demand':
        sim?.setDemand(message.node, message.vehiclesPerHour);
        break;
      case 'results': {
        if (!sim) break;
        const cells = sim.laneCellsHistory();
        post({ type: 'results', summaryJson: sim.summaryJson(), cells: cells.buffer as ArrayBuffer, time: sim.time }, [cells.buffer as ArrayBuffer]);
        break;
      }
      case 'dispose':
        sim?.free();
        sim = null;
        playing = false;
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
