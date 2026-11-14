import { describe, expect, it } from 'vitest';
import { bufferBytes, HEADER_INTS, sharedMemoryAvailable, SnapshotBuffer } from './snapshotBuffer';

describe('SnapshotBuffer', () => {
  it('publishes into alternating halves and reads the latest', () => {
    const writer = SnapshotBuffer.allocate(4, 3, false);
    const reader = new SnapshotBuffer(writer.buffer, 3);
    expect(writer.buffer.byteLength).toBe(bufferBytes(4, 3));
    expect(reader.capacity).toBe(4);
    expect(reader.read()).toHaveLength(0);

    writer.publish(new Float32Array([1, 2, 3]));
    expect(reader.sequence).toBe(1);
    expect(Array.from(reader.read())).toEqual([1, 2, 3]);

    writer.publish(new Float32Array([4, 5, 6, 7, 8, 9]));
    expect(reader.sequence).toBe(2);
    expect(Array.from(reader.read())).toEqual([4, 5, 6, 7, 8, 9]);
    expect(HEADER_INTS).toBe(6);
  });

  it('rejects snapshots beyond capacity', () => {
    const writer = SnapshotBuffer.allocate(1, 3, false);
    expect(writer.fits(new Float32Array(6))).toBe(false);
    expect(() => writer.publish(new Float32Array(6))).toThrow(RangeError);
  });

  it('detects shared memory availability', () => {
    expect(typeof sharedMemoryAvailable()).toBe('boolean');
  });
});
