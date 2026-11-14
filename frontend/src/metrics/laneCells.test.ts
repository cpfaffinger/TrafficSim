import { describe, expect, it } from 'vitest';
import { bucketBytes, CellHistory, decodeLaneCells } from './laneCells';
import { buildBlob } from './testBlob';

describe('lane-cells-v1 decoding (#57, #59)', () => {
  it('decodes header, lane table and buckets', () => {
    const blob = decodeLaneCells(buildBlob({ cells: 3, buckets: 2, first: 5 }));

    expect(blob.laneCount).toBe(1);
    expect(blob.cellCount).toBe(3);
    expect(blob.cellLength).toBe(10);
    expect(blob.bucketDuration).toBe(30);
    expect(blob.startTimeOfDay).toBe(25200);
    expect(blob.lanes[0]).toEqual({ linkIndex: 2, laneIndex: 1, cellCount: 3, firstCell: 0, length: 25, speedLimit: 13.5 });
    expect(blob.buckets.map((b) => b.index)).toEqual([5, 6]);
    expect(Array.from(blob.buckets[1]!.speedRatio)).toEqual([Math.fround(0.5), Math.fround(0.5), Math.fround(0.5)]);
    expect(Array.from(blob.buckets[0]!.flow)).toEqual([1, 1, 1]);
    expect(bucketBytes(3)).toBe(48 + 20);
  });

  it('accepts unaligned Uint8Array views', () => {
    const raw = buildBlob({ cells: 2, buckets: 1, first: 0 });
    const shifted = new Uint8Array(raw.byteLength + 1);
    shifted.set(new Uint8Array(raw), 1);
    expect(decodeLaneCells(shifted.subarray(1)).buckets).toHaveLength(1);
  });

  it('rejects invalid blobs', () => {
    expect(() => decodeLaneCells(new Uint8Array(10))).toThrow(/short/);
    const bad = new Uint8Array(buildBlob({ cells: 1, buckets: 1, first: 0 }));
    bad[0] = 88;
    expect(() => decodeLaneCells(bad)).toThrow(/magic/);
    const version = new Uint8Array(buildBlob({ cells: 1, buckets: 1, first: 0 }));
    version[4] = 2;
    expect(() => decodeLaneCells(version)).toThrow(/version/);
    expect(() => decodeLaneCells(new Uint8Array(buildBlob({ cells: 4, buckets: 2, first: 0 })).subarray(0, 120))).toThrow(/truncated/);
  });

  it('keeps a bounded history and resets on layout changes', () => {
    const history = new CellHistory(3);
    expect(history.range()).toBeNull();
    history.add(decodeLaneCells(buildBlob({ cells: 2, buckets: 2, first: 0 })));
    history.add(decodeLaneCells(buildBlob({ cells: 2, buckets: 2, first: 2 })));
    expect(history.size).toBe(3);
    expect(history.range()).toEqual([1, 3]);
    expect(history.get(3)?.index).toBe(3);
    expect(history.timeOfDay(2)).toBe(25200 + 60);
    history.add(decodeLaneCells(buildBlob({ cells: 5, buckets: 1, first: 9 })));
    expect(history.range()).toEqual([9, 9]);
    history.clear();
    expect(history.size).toBe(0);
    expect(history.timeOfDay(1)).toBe(0);
  });
});
