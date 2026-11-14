/**
 * Decoder for the sim core's `lane-cells-v1` binary format (sim-core/README.md, #57) and a bucket
 * history for the heatmap timeline (#59, #60).
 */

export const LANE_CELLS_MAGIC = 'LCV1';
const HEADER_BYTES = 48;
const LANE_ROW_BYTES = 20;

export interface LaneRow {
  /** Index into the package's `links[]`. */
  linkIndex: number;
  laneIndex: number;
  cellCount: number;
  firstCell: number;
  length: number;
  speedLimit: number;
}

export interface CellBucket {
  /** Run-wide bucket index: covers [index·T, (index+1)·T) simulated seconds. */
  index: number;
  density: Float32Array;
  meanSpeed: Float32Array;
  speedRatio: Float32Array;
  delay: Float32Array;
  queueShare: Uint16Array;
  stops: Uint16Array;
  flow: Uint16Array;
}

export interface LaneCellsBlob {
  laneCount: number;
  cellCount: number;
  cellLength: number;
  bucketDuration: number;
  startTimeOfDay: number;
  lanes: LaneRow[];
  buckets: CellBucket[];
}

const pad4 = (n: number) => (n + 3) & ~3;

export function bucketBytes(cellCount: number): number {
  return 16 * cellCount + pad4(6 * cellCount);
}

/** Decodes a blob; copies the bytes once so all typed-array views are aligned. */
export function decodeLaneCells(input: ArrayBuffer | Uint8Array): LaneCellsBlob {
  const bytes = input instanceof Uint8Array ? input.slice() : new Uint8Array(input.slice(0));
  const buffer = bytes.buffer;
  if (bytes.byteLength < HEADER_BYTES) throw new Error('lane-cells blob too short');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== LANE_CELLS_MAGIC) throw new Error(`not a lane-cells blob (magic ${magic})`);
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported lane-cells version ${version}`);
  const headerSize = view.getUint16(6, true);
  const laneCount = view.getUint32(8, true);
  const cellCount = view.getUint32(12, true);
  const bucketCount = view.getUint32(16, true);
  const firstBucket = view.getUint32(20, true);
  const cellLength = view.getFloat32(24, true);
  const bucketDuration = view.getFloat32(28, true);
  const startTimeOfDay = view.getFloat64(32, true);

  const lanes: LaneRow[] = [];
  let o = headerSize;
  for (let i = 0; i < laneCount; i++, o += LANE_ROW_BYTES) {
    lanes.push({
      linkIndex: view.getUint32(o, true),
      laneIndex: view.getUint16(o + 4, true),
      cellCount: view.getUint16(o + 6, true),
      firstCell: view.getUint32(o + 8, true),
      length: view.getFloat32(o + 12, true),
      speedLimit: view.getFloat32(o + 16, true),
    });
  }

  const size = bucketBytes(cellCount);
  if (o + bucketCount * size > bytes.byteLength) throw new Error('lane-cells blob truncated');
  const buckets: CellBucket[] = [];
  for (let b = 0; b < bucketCount; b++, o += size) {
    const C = cellCount;
    buckets.push({
      index: firstBucket + b,
      density: new Float32Array(buffer, o, C),
      meanSpeed: new Float32Array(buffer, o + 4 * C, C),
      speedRatio: new Float32Array(buffer, o + 8 * C, C),
      delay: new Float32Array(buffer, o + 12 * C, C),
      queueShare: new Uint16Array(buffer, o + 16 * C, C),
      stops: new Uint16Array(buffer, o + 18 * C, C),
      flow: new Uint16Array(buffer, o + 20 * C, C),
    });
  }
  return { laneCount, cellCount, cellLength, bucketDuration, startTimeOfDay, lanes, buckets };
}

/** Accumulates buckets streamed from the worker (or loaded from a stored run). */
export class CellHistory {
  private readonly buckets = new Map<number, CellBucket>();
  layout: Omit<LaneCellsBlob, 'buckets'> | null = null;

  constructor(private readonly maxBuckets = 2880) {}

  add(blob: LaneCellsBlob): void {
    if (!this.layout || this.layout.cellCount !== blob.cellCount || this.layout.laneCount !== blob.laneCount) {
      this.buckets.clear();
      const { buckets: _ignored, ...layout } = blob;
      void _ignored;
      this.layout = layout;
    }
    for (const b of blob.buckets) this.buckets.set(b.index, b);
    if (this.buckets.size > this.maxBuckets) {
      const keys = [...this.buckets.keys()].sort((a, b) => a - b);
      for (const k of keys.slice(0, this.buckets.size - this.maxBuckets)) this.buckets.delete(k);
    }
  }

  clear(): void {
    this.buckets.clear();
    this.layout = null;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** First and last available bucket index, or null when empty. */
  range(): [number, number] | null {
    if (this.buckets.size === 0) return null;
    const keys = [...this.buckets.keys()];
    return [Math.min(...keys), Math.max(...keys)];
  }

  get(index: number): CellBucket | undefined {
    return this.buckets.get(index);
  }

  /** Time of day at the start of a bucket, seconds. */
  timeOfDay(index: number): number {
    return this.layout ? this.layout.startTimeOfDay + index * this.layout.bucketDuration : 0;
  }
}
