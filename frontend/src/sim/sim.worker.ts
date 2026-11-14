/// <reference lib="webworker" />
// Simulation worker: owns the WASM core and advances it in fixed steps (ADR-0006).
import init, { RingRoadSim } from '../generated/sim-core/trafficsim_sim_core.js';
import { stepsFor, type FromWorker, type ToWorker } from './protocol';

const TICK_MS = 33;
const MAX_STEPS_PER_TICK = 2_000;

let sim: RingRoadSim | null = null;
let playing = false;
let speedFactor = 1;
let carry = 0;
let last = performance.now();
let ready: Promise<unknown> | null = null;

const post = (message: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message, transfer);

function postFrame(): void {
  if (!sim) return;
  const snapshot = sim.snapshot();
  post(
    {
      type: 'frame',
      time: sim.time,
      meanSpeed: sim.meanSpeed,
      desiredSpeed: sim.desiredSpeed,
      length: sim.length,
      snapshot,
    },
    [snapshot.buffer],
  );
}

function tick(): void {
  const now = performance.now();
  if (sim && playing) {
    const result = stepsFor(now - last, sim.timeStep, speedFactor, carry);
    carry = result.carry;
    const steps = Math.min(result.steps, MAX_STEPS_PER_TICK);
    if (steps > 0) sim.step(steps);
    postFrame();
  }
  last = now;
}

setInterval(tick, TICK_MS);

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    ready ??= init();
    await ready;
    switch (message.type) {
      case 'init': {
        sim?.free();
        const { vehicleCount, length, heterogeneity, seed } = message.settings;
        sim = new RingRoadSim(vehicleCount, length, heterogeneity, seed);
        carry = 0;
        post({ type: 'ready', vehicleCount: sim.vehicleCount, timeStep: sim.timeStep });
        postFrame();
        break;
      }
      case 'play':
        playing = true;
        last = performance.now();
        break;
      case 'pause':
        playing = false;
        break;
      case 'speed':
        speedFactor = message.factor;
        break;
      case 'perturb':
        sim?.perturb(message.vehicle, message.speedFactor);
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
