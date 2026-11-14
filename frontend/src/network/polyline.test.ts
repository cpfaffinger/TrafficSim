import { describe, expect, it } from 'vitest';
import {
  convexHull,
  cumulativeLengths,
  dashIntervals,
  lift,
  distanceToSegmentSq,
  offsetPolyline,
  polylineLength,
  slicePolyline,
  stationAt,
  withSolidTail,
} from './polyline';
import type { Polyline } from './types';

const east: Polyline = [
  [0, 0, 0],
  [10, 0, 0],
];
const corner: Polyline = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 10, 0],
];

describe('lengths', () => {
  it('accumulates 3D distances', () => {
    expect(cumulativeLengths(corner)).toEqual([0, 10, 20]);
    expect(polylineLength([[0, 0, 0], [3, 0, 4]])).toBe(5);
    expect(polylineLength([])).toBe(0);
  });
});

describe('offsetPolyline', () => {
  it('offsets to the right of the driving direction', () => {
    expect(offsetPolyline(east, 2)).toEqual([
      [0, -2, 0],
      [10, -2, 0],
    ]);
    expect(offsetPolyline(east, -2)[0]).toEqual([0, 2, 0]);
  });

  it('mitres interior vertices so offsets stay parallel', () => {
    // Left turn (east then north): the right side is the outside of the bend.
    const out = offsetPolyline(corner, 1);
    expect(out[1]![0]).toBeCloseTo(11);
    expect(out[1]![1]).toBeCloseTo(-1);
    expect(out[2]).toEqual([11, 10, 0]);
  });

  it('clamps extreme mitres and handles reversals and zero offsets', () => {
    const hairpin: Polyline = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 0.001, 0],
    ];
    const out = offsetPolyline(hairpin, 1);
    expect(Math.hypot(out[1]![0] - 10, out[1]![1])).toBeLessThanOrEqual(4.0001);
    const back: Polyline = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 0, 0],
    ];
    expect(offsetPolyline(back, 1)[1]).toEqual([10, -1, 0]);
    expect(offsetPolyline(east, 0)).toEqual(east);
  });

  it('tapers per vertex and lifts', () => {
    expect(offsetPolyline(east, [1, 3])).toEqual([
      [0, -1, 0],
      [10, -3, 0],
    ]);
    expect(lift(east, 0.5)[1]).toEqual([10, 0, 0.5]);
  });

  it('keeps elevation', () => {
    expect(offsetPolyline([[0, 0, 6], [10, 0, 6]], 1)[0]![2]).toBe(6);
  });
});

describe('stationAt and slicePolyline', () => {
  it('interpolates points and tangents', () => {
    const s = stationAt(corner, 15);
    expect(s.point).toEqual([10, 5, 0]);
    expect(s.dir).toEqual([0, 1]);
    expect(stationAt(corner, -5).point).toEqual([0, 0, 0]);
    expect(stationAt(corner, 99).point).toEqual([10, 10, 0]);
  });

  it('returns degenerate-safe directions', () => {
    expect(stationAt([[1, 1, 0], [1, 1, 0]], 0).dir).toEqual([1, 0]);
  });

  it('slices across vertices', () => {
    expect(slicePolyline(corner, 5, 15)).toEqual([
      [5, 0, 0],
      [10, 0, 0],
      [10, 5, 0],
    ]);
    expect(slicePolyline(corner, 2, 4)).toEqual([
      [2, 0, 0],
      [4, 0, 0],
    ]);
    expect(slicePolyline(corner, 30, 40)).toEqual([]);
  });
});

describe('dash patterns', () => {
  it('produces dash intervals that end at the line end', () => {
    expect(dashIntervals(20, 3, 6)).toEqual([
      [0, 3],
      [9, 12],
      [18, 20],
    ]);
    expect(dashIntervals(0, 3, 6)).toEqual([]);
    expect(dashIntervals(5, 3, 0)).toEqual([[0, 5]]);
  });

  it('honours a phase offset', () => {
    expect(dashIntervals(10, 3, 6, 2)).toEqual([
      [0, 1],
      [7, 10],
    ]);
  });

  it('turns the tail solid (no-lane-change zone)', () => {
    const dashes = dashIntervals(40, 3, 6); // 0-3, 9-12, 18-21, 27-30, 36-39
    expect(withSolidTail(dashes, 40, 20)).toEqual([
      [0, 3],
      [9, 12],
      [18, 40],
    ]);
    expect(withSolidTail(dashes, 40, 40)).toBe(dashes);
    expect(withSolidTail(dashes, 40, -5)).toEqual([[0, 40]]);
  });
});

describe('geometry utilities', () => {
  it('computes convex hulls counter-clockwise', () => {
    const hull = convexHull([
      [0, 0],
      [2, 0],
      [1, 1],
      [2, 2],
      [0, 2],
      [1, 0],
    ]);
    expect(hull).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
    expect(convexHull([[0, 0], [1, 1]])).toHaveLength(2);
  });

  it('measures distance to segments', () => {
    expect(distanceToSegmentSq([5, 3], [0, 0, 0], [10, 0, 0])).toBe(9);
    expect(distanceToSegmentSq([-3, 4], [0, 0, 0], [10, 0, 0])).toBe(25);
    expect(distanceToSegmentSq([1, 1], [0, 0, 0], [0, 0, 0])).toBe(2);
  });
});
