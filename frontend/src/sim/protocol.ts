/** Message protocol between the UI thread and the simulation worker. */

export interface RingSettings {
  vehicleCount: number;
  length: number;
  heterogeneity: number;
  seed: number;
}

export type ToWorker =
  | { type: 'init'; settings: RingSettings }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; factor: number }
  | { type: 'perturb'; vehicle: number; speedFactor: number };

export interface FrameMessage {
  type: 'frame';
  time: number;
  meanSpeed: number;
  desiredSpeed: number;
  length: number;
  /** Packed [position, speed] per vehicle, see SNAPSHOT_STRIDE. */
  snapshot: Float32Array;
}

export type FromWorker =
  | { type: 'ready'; vehicleCount: number; timeStep: number }
  | FrameMessage
  | { type: 'error'; message: string };

export const SNAPSHOT_STRIDE = 2;

export interface VehicleState {
  position: number;
  speed: number;
}

export function unpackSnapshot(snapshot: Float32Array): VehicleState[] {
  if (snapshot.length % SNAPSHOT_STRIDE !== 0) {
    throw new Error(`Snapshot length ${snapshot.length} is not a multiple of ${SNAPSHOT_STRIDE}`);
  }
  const vehicles: VehicleState[] = [];
  for (let i = 0; i < snapshot.length; i += SNAPSHOT_STRIDE) {
    vehicles.push({ position: snapshot[i]!, speed: snapshot[i + 1]! });
  }
  return vehicles;
}

/** Number of fixed simulation steps to run for a wall-clock interval at a given speed-up. */
export function stepsFor(elapsedMs: number, timeStep: number, speedFactor: number, carry = 0): { steps: number; carry: number } {
  const simSeconds = (Math.max(0, elapsedMs) / 1000) * Math.max(0, speedFactor) + carry;
  const steps = Math.floor(simSeconds / timeStep + 1e-9);
  return { steps, carry: simSeconds - steps * timeStep };
}
