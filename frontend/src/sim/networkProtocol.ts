/** Message protocol between the UI thread and the network simulation worker (#47). */

export interface NetworkSimSettings {
  /** Network package v1 as JSON text. */
  packageJson: string;
  /** Simulation config (sim-core/README.md), JSON text. */
  configJson: string;
  seed: number;
}

export type ToNetworkWorker =
  | { type: 'init'; settings: NetworkSimSettings }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'speed'; factor: number }
  | { type: 'demand'; node: string; vehiclesPerHour: number }
  /** Requests the run results (summary + all retained lane-cell buckets) for saving (#61, #73). */
  | { type: 'results' }
  | { type: 'dispose' };

/** Statistics reported by sim-core `statsJson()`. */
export interface SimStats {
  time: number;
  spawned: number;
  arrived: number;
  active: number;
  waitingToEnter: number;
  rerouted: number;
  stranded: number;
  unroutable: number;
  laneChanges: number;
  forcedEntries: number;
  meanTravelTime: number;
  meanSpeed: number;
  /** Present when pedestrians run (ADR-0020). */
  pedestrians?: { served: number; waiting: number; crossing: number; meanDelay: number };
  [key: string]: unknown;
}

export interface NetworkFrame {
  type: 'frame';
  time: number;
  /** Simulated time of day in seconds (start time of the scenario + elapsed). */
  timeOfDay: number;
  /** Packed vehicles, NETWORK_SNAPSHOT_STRIDE floats each; null when shared memory is used (#79). */
  snapshot: Float32Array | null;
  vehicles: number;
  /** One aspect per signal group (0 red, 1 amber, 2 green), order of `ready.signalGroupIds`. */
  signals: Uint8Array;
  stats: SimStats | null;
  /** Pedestrians at crossings (`pedestrianSnapshot()`, 5 floats each, ADR-0020); absent without crossings. */
  pedestrians?: Float32Array;
}

export type FromNetworkWorker =
  | { type: 'ready'; timeStep: number; signalGroupIds: string[]; entries: string[] }
  | NetworkFrame
  /** Newly finished lane-cell buckets (`lane-cells-v1`, #59/#60). */
  | { type: 'cells'; blob: ArrayBuffer }
  /** Run results: sim-core summary JSON and the lane-cell history. */
  | { type: 'results'; summaryJson: string; cells: ArrayBuffer; time: number }
  /** A (new) shared snapshot buffer; frames then carry no snapshot copy (see snapshotBuffer.ts). */
  | { type: 'buffer'; buffer: SharedArrayBuffer }
  | { type: 'error'; message: string };

export const NETWORK_SNAPSHOT_STRIDE = 9;

export const VEHICLE_FLAGS = { braking: 1, waiting: 2, changingLane: 4, inJunction: 8, holding: 16, dwelling: 32 } as const;

export const VEHICLE_CLASSES = ['car', 'van', 'truck', 'bus', 'motorcycle'] as const;
export type VehicleClassName = (typeof VEHICLE_CLASSES)[number];

/** Rendered width and height per class id (length comes from the snapshot). */
export const VEHICLE_DIMENSIONS: Record<VehicleClassName, { width: number; height: number }> = {
  car: { width: 1.8, height: 1.45 },
  van: { width: 2.0, height: 2.2 },
  truck: { width: 2.5, height: 3.4 },
  bus: { width: 2.55, height: 3.1 },
  motorcycle: { width: 0.8, height: 1.4 },
};

export interface VehicleView {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  length: number;
  vehicleClass: VehicleClassName;
  flags: number;
  id: number;
}

export function vehicleCount(snapshot: Float32Array): number {
  if (snapshot.length % NETWORK_SNAPSHOT_STRIDE !== 0) {
    throw new Error(`Snapshot length ${snapshot.length} is not a multiple of ${NETWORK_SNAPSHOT_STRIDE}`);
  }
  return snapshot.length / NETWORK_SNAPSHOT_STRIDE;
}

export function readVehicle(snapshot: Float32Array, index: number): VehicleView {
  const o = index * NETWORK_SNAPSHOT_STRIDE;
  const classId = Math.round(snapshot[o + 6]!);
  return {
    x: snapshot[o]!,
    y: snapshot[o + 1]!,
    z: snapshot[o + 2]!,
    heading: snapshot[o + 3]!,
    speed: snapshot[o + 4]!,
    length: snapshot[o + 5]!,
    vehicleClass: VEHICLE_CLASSES[classId] ?? 'car',
    flags: Math.round(snapshot[o + 7]!),
    id: Math.round(snapshot[o + 8]!),
  };
}

/** Colour of a bus (#85): violet, lighter while dwelling at a stop, so buses stand out from traffic. */
export function busColor(flags: number): [number, number, number] {
  return flags & VEHICLE_FLAGS.dwelling ? [0.8, 0.6, 0.95] : [0.55, 0.27, 0.78];
}

/** Colour of a vehicle: red when braking or holding, otherwise green→yellow by speed (km/h bands). */
export function vehicleColor(v: Pick<VehicleView, 'speed' | 'flags'>): [number, number, number] {
  if (v.flags & (VEHICLE_FLAGS.braking | VEHICLE_FLAGS.holding)) return [0.86, 0.18, 0.16];
  const kmh = v.speed * 3.6;
  if (kmh < 10) return [0.93, 0.45, 0.13];
  if (kmh < 30) return [0.96, 0.78, 0.2];
  return [0.2, 0.62, 0.86];
}

/**
 * Simulation config from UI settings and an optional scenario demand (#115). Without a scenario the
 * sim core's road-class profiles drive the boundary demand. `demandScale` is resolved by the worker.
 */
export function buildConfig(options: { demandScale: number; truckShare: number; heterogeneity: number }, scenarioDemand?: unknown): string {
  const base: Record<string, unknown> =
    scenarioDemand && typeof scenarioDemand === 'object' && !Array.isArray(scenarioDemand) ? structuredClone(scenarioDemand as Record<string, unknown>) : {};
  if (!('vehicleMix' in base)) {
    const truck = clamp(options.truckShare, 0, 0.5);
    base.vehicleMix = { car: Math.max(0, 0.9 - truck), van: 0.07, truck, motorcycle: 0.03 };
    base.heterogeneity = clamp(options.heterogeneity, 0, 0.5);
  }
  base.demandScale = clamp(options.demandScale, 0, 500) / 100;
  return JSON.stringify(base);
}

/** Entry nodes of a package: boundary nodes with at least one outgoing link. */
export function entryNodes(pkg: { nodes: readonly { id: string; control: string }[]; links: readonly { from: string }[] }): string[] {
  const from = new Set(pkg.links.map((l) => l.from));
  return pkg.nodes.filter((n) => n.control === 'boundary' && from.has(n.id)).map((n) => n.id);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
