/// <reference lib="webworker" />
// Network simulation worker (#47): owns a sim-core NetworkSim and advances it in fixed steps.
import init, { NetworkSim } from '../generated/sim-core/trafficsim_sim_core.js';
import { stepsFor } from './protocol';
import type { FromNetworkWorker, SimStats, ToNetworkWorker } from './networkProtocol';

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

const post = (message: FromNetworkWorker, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

function postFrame(forceStats = false): void {
  if (!sim) return;
  const now = performance.now();
  const withStats = forceStats || now - lastStats > STATS_EVERY_MS;
  if (withStats) lastStats = now;
  const snapshot = sim.snapshot();
  const signals = sim.signalStates();
  post(
    {
      type: 'frame',
      time: sim.time,
      snapshot,
      signals,
      stats: withStats ? (JSON.parse(sim.statsJson()) as SimStats) : null,
    },
    [snapshot.buffer, signals.buffer],
  );
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
        sim = new NetworkSim(packageJson, configJson, BigInt(Math.max(0, Math.floor(seed))));
        carry = 0;
        const groups = JSON.parse(sim.signalGroupIdsJson()) as string[];
        const pkg = JSON.parse(packageJson) as { nodes: { id: string; control: string }[]; links: { from: string }[] };
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
