/**
 * Double-buffered vehicle snapshot shared between the simulation worker and the UI thread (#79).
 *
 * Layout: an Int32 header `[sequence, capacity, active, count0, count1, reserved]` followed by two Float32 halves of
 * `capacity × stride` floats. The writer fills the inactive half, then publishes it by flipping
 * `active` and incrementing `sequence` (Atomics, release order). The reader copies nothing: it reads
 * the active half directly. Works on a plain ArrayBuffer too (tests, no cross-origin isolation).
 */
export const HEADER_INTS = 6;
const SEQ = 0;
const CAPACITY = 1;
const ACTIVE = 2;
const COUNT = 3; // + half index

export function sharedMemoryAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

export function bufferBytes(capacity: number, stride: number): number {
  return HEADER_INTS * 4 + capacity * stride * 4 * 2;
}

export class SnapshotBuffer {
  readonly header: Int32Array;
  private readonly halves: [Float32Array, Float32Array];

  constructor(
    readonly buffer: SharedArrayBuffer | ArrayBuffer,
    readonly stride: number,
  ) {
    this.header = new Int32Array(buffer, 0, HEADER_INTS);
    const capacity = this.header[CAPACITY] || Math.floor((buffer.byteLength - HEADER_INTS * 4) / (stride * 4 * 2));
    this.header[CAPACITY] = capacity;
    const offset = HEADER_INTS * 4;
    const floats = capacity * stride;
    this.halves = [new Float32Array(buffer, offset, floats), new Float32Array(buffer, offset + floats * 4, floats)];
  }

  static allocate(capacity: number, stride: number, shared = sharedMemoryAvailable()): SnapshotBuffer {
    const bytes = bufferBytes(capacity, stride);
    const buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    const header = new Int32Array(buffer, 0, HEADER_INTS);
    header[CAPACITY] = capacity;
    return new SnapshotBuffer(buffer, stride);
  }

  get capacity(): number {
    return this.header[CAPACITY]!;
  }

  get sequence(): number {
    return Atomics.load(this.header, SEQ);
  }

  /** True when `vehicles` floats fit; otherwise the writer must allocate a bigger buffer. */
  fits(snapshot: Float32Array): boolean {
    return snapshot.length <= this.capacity * this.stride;
  }

  /** Writer side: copies the snapshot into the inactive half and publishes it. */
  publish(snapshot: Float32Array): void {
    if (!this.fits(snapshot)) throw new RangeError('snapshot exceeds buffer capacity');
    const next = 1 - Atomics.load(this.header, ACTIVE);
    this.halves[next]!.set(snapshot);
    Atomics.store(this.header, COUNT + next, snapshot.length / this.stride);
    Atomics.store(this.header, ACTIVE, next);
    Atomics.add(this.header, SEQ, 1);
  }

  /** Reader side: view on the latest published vehicles (valid until the writer publishes twice more). */
  read(): Float32Array {
    const active = Atomics.load(this.header, ACTIVE);
    const count = Atomics.load(this.header, COUNT + active);
    return this.halves[active]!.subarray(0, count * this.stride);
  }
}
