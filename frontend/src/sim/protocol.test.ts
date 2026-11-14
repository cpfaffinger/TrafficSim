import { describe, expect, it } from 'vitest';
import { stepsFor, unpackSnapshot } from './protocol';

describe('unpackSnapshot', () => {
  it('unpacks position/speed pairs', () => {
    expect(unpackSnapshot(new Float32Array([1, 2, 3, 4]))).toEqual([
      { position: 1, speed: 2 },
      { position: 3, speed: 4 },
    ]);
  });

  it('rejects malformed buffers', () => {
    expect(() => unpackSnapshot(new Float32Array([1, 2, 3]))).toThrow(/multiple/);
  });
});

describe('stepsFor', () => {
  it('converts wall-clock time into fixed steps at real time', () => {
    expect(stepsFor(1000, 0.1, 1)).toEqual({ steps: 10, carry: expect.closeTo(0, 9) });
  });

  it('scales with the speed factor and carries the remainder', () => {
    const first = stepsFor(25, 0.1, 10); // 0.25 s simulated
    expect(first.steps).toBe(2);
    expect(first.carry).toBeCloseTo(0.05);

    const second = stepsFor(25, 0.1, 10, first.carry);
    expect(second.steps).toBe(3);
    expect(second.carry).toBeCloseTo(0);
  });

  it('never runs backwards', () => {
    expect(stepsFor(-50, 0.1, 1).steps).toBe(0);
    expect(stepsFor(50, 0.1, -1).steps).toBe(0);
  });
});
