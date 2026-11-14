import { describe, expect, it } from 'vitest';
import { isRing, ringAreaKm2, ringBounds, ringProblem, ringSelfIntersects, roundRing, type Ring } from './polygonArea';
import { bboxAreaKm2 } from './area';

const L: Ring = [
  [16.36, 48.2],
  [16.37, 48.2],
  [16.37, 48.205],
  [16.365, 48.205],
  [16.365, 48.21],
  [16.36, 48.21],
];

describe('polygon areas (#110)', () => {
  it('computes bounds and area', () => {
    expect(ringBounds(L)).toEqual([16.36, 48.2, 16.37, 48.21]);
    expect(ringAreaKm2(L) / bboxAreaKm2([16.36, 48.2, 16.37, 48.21])).toBeCloseTo(0.75, 2);
    expect(ringAreaKm2(L.slice(0, 2))).toBe(0);
  });

  it('detects self-intersections and other problems', () => {
    expect(ringSelfIntersects(L)).toBe(false);
    const bowtie: Ring = [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
    ];
    expect(ringSelfIntersects(bowtie)).toBe(true);
    expect(ringProblem(bowtie)).toMatch(/cross/);
    expect(ringProblem(L.slice(0, 2))).toMatch(/three/);
    expect(ringProblem([[16, 48], [16.0001, 48], [16, 48.0001]])).toMatch(/small/);
    expect(ringProblem(L)).toBeNull();
    expect(ringProblem(Array.from({ length: 501 }, (_, i) => [Math.cos(i), Math.sin(i)] as const))).toMatch(/at most/);
  });

  it('rounds rings and tells rings from boxes', () => {
    expect(roundRing([[16.1234567, 48.7654321]])).toEqual([[16.123457, 48.765432]]);
    expect(isRing(L)).toBe(true);
    expect(isRing([16, 48, 17, 49])).toBe(false);
  });
});
