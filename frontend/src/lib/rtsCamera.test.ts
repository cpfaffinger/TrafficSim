import { describe, expect, it } from 'vitest';
import {
  cameraPosition,
  classifyTwoFingerGesture,
  clampState,
  clipPlanes,
  DEFAULT_LIMITS,
  frameRect,
  limitsFor,
  groundAxes,
  intersectGround,
  isClick,
  normaliseAngle,
  orbitStep,
  panByGroundDelta,
  panRelative,
  rotate,
  wheelZoomFactor,
  zoomTowards,
  type RtsCameraState,
} from './rtsCamera';

const DEG = Math.PI / 180;
const base: RtsCameraState = { target: [0, 0], distance: 100, yaw: 0, pitch: 45 * DEG };

describe('camera placement', () => {
  it('puts the camera south of the target at yaw 0 (looking north = −z)', () => {
    const [x, y, z] = cameraPosition(base);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(70.71, 1);
    expect(z).toBeCloseTo(70.71, 1);
  });

  it('turns clockwise seen from above as yaw grows', () => {
    const [x, , z] = cameraPosition({ ...base, yaw: 90 * DEG });
    expect(x).toBeCloseTo(70.71, 1);
    expect(z).toBeCloseTo(0);
  });

  it('provides screen-aligned ground axes', () => {
    const { forward, right } = groundAxes(0);
    expect(forward[0]).toBeCloseTo(0);
    expect(forward[1]).toBeCloseTo(-1);
    expect(right).toEqual([1, -0]);
  });
});

describe('limits', () => {
  it('clamps pitch, distance and bounds', () => {
    const s = clampState({ target: [500, -500], distance: 1, yaw: 0, pitch: 2 }, { ...DEFAULT_LIMITS, bounds: [-100, -100, 100, 100] });
    expect(s.target).toEqual([100, -100]);
    expect(s.distance).toBe(DEFAULT_LIMITS.minDistance);
    expect(s.pitch).toBe(DEFAULT_LIMITS.maxPitch);
    expect(rotate(base, 0, -2).pitch).toBe(DEFAULT_LIMITS.minPitch);
  });

  it('normalises yaw into (−π, π]', () => {
    expect(normaliseAngle(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(normaliseAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    expect(normaliseAngle(2 * Math.PI + 0.5)).toBeCloseTo(0.5);
  });
});

describe('pan', () => {
  it('keeps the grabbed ground point under the cursor', () => {
    expect(panByGroundDelta(base, [10, 10], [15, 5]).target).toEqual([-5, 5]);
  });

  it('moves along the view direction with the keyboard, scaled by distance', () => {
    const s = panRelative(base, 1, 0, 1);
    expect(s.target[0]).toBeCloseTo(0);
    expect(s.target[1]).toBeCloseTo(-90);
    const turned = panRelative({ ...base, yaw: 90 * DEG }, 0, 1, 0.5);
    expect(turned.target[0]).toBeCloseTo(0);
    expect(turned.target[1]).toBeCloseTo(-45);
  });
});

describe('zoom to cursor', () => {
  it('keeps the point under the cursor fixed', () => {
    const s = zoomTowards(base, 0.5, [40, 20]);
    expect(s.distance).toBe(50);
    expect(s.target).toEqual([20, 10]);
  });

  it('zooms about the target without a cursor point and respects limits', () => {
    expect(zoomTowards(base, 2, null).target).toEqual([0, 0]);
    const s = zoomTowards(base, 1e-6, [40, 20]);
    expect(s.distance).toBe(DEFAULT_LIMITS.minDistance);
    expect(s.target[0]).toBeCloseTo(40 * (1 - DEFAULT_LIMITS.minDistance / 100));
  });

  it('maps wheel deltas to factors', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(100)).toBeGreaterThan(1.1);
    expect(wheelZoomFactor(-100)).toBeLessThan(0.9);
    expect(wheelZoomFactor(1e6)).toBe(wheelZoomFactor(500));
  });
});

describe('framing and projection helpers', () => {
  it('frames a rectangle around its centre', () => {
    const s = frameRect([-150, -150, 150, 150], 45 * DEG, 16 / 9);
    expect(s.target).toEqual([0, 0]);
    expect(s.distance).toBeGreaterThan(300);
    expect(s.distance).toBeLessThan(1000);
    expect(frameRect([0, 0, 3000, 300], 45 * DEG, 1).distance).toBeGreaterThan(frameRect([0, 0, 300, 300], 45 * DEG, 1).distance);
  });

  it('scales clip planes with distance', () => {
    expect(clipPlanes(10)).toEqual({ near: 0.2, far: 2000 });
    expect(clipPlanes(1000).near).toBe(10);
    expect(clipPlanes(1000).far).toBe(25_000);
  });

  it('intersects rays with the ground', () => {
    expect(intersectGround([0, 10, 0], [0, -1, -1])).toEqual([0, -10]);
    expect(intersectGround([0, 10, 0], [1, 0, 0])).toBeNull();
    expect(intersectGround([0, 10, 0], [0, 1, 0])).toBeNull();
  });

  it('tells clicks from drags', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(true);
    expect(isClick({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(false);
  });
});

describe('two-finger gestures', () => {
  const sample = (distance: number, angle: number, x: number, y: number) => ({ distance, angle, mid: { x, y } });

  it('detects a vertical two-finger drag as tilt', () => {
    expect(classifyTwoFingerGesture(sample(200, 0, 100, 300), sample(201, 0.01, 101, 280))).toBe('tilt');
  });

  it('treats spreading, twisting or sideways moves as pinch/pan', () => {
    expect(classifyTwoFingerGesture(sample(200, 0, 100, 300), sample(260, 0, 100, 290))).toBe('pinch');
    expect(classifyTwoFingerGesture(sample(200, 0, 100, 300), sample(200, 0.3, 100, 280))).toBe('pinch');
    expect(classifyTwoFingerGesture(sample(200, 0, 100, 300), sample(200, 0, 140, 290))).toBe('pinch');
    expect(classifyTwoFingerGesture(sample(200, Math.PI / 2, 100, 300), sample(200, Math.PI / 2, 100, 280))).toBe('pinch');
    expect(classifyTwoFingerGesture(sample(200, 3.1, 100, 300), sample(200, -3.1, 100, 280))).toBe('pinch');
  });
});

describe('limitsFor (#122)', () => {
  it('lets a wide area be framed in a portrait view and panned beyond', () => {
    // Krems: 6.6 km wide, 3.2 km deep, on a portrait tablet (aspect 0.55).
    const rect: [number, number, number, number] = [-3300, -1600, 3300, 1600];
    const limits = limitsFor(rect);
    const s = frameRect(rect, 45 * DEG, 0.55, limits);
    const halfWidth = s.distance * Math.tan((45 * DEG) / 2) * 0.55;
    expect(halfWidth).toBeGreaterThanOrEqual(3300);
    expect(limits.bounds).toEqual([-6600, -4900, 6600, 4900]);
    expect(limitsFor([0, 0, 200, 200]).bounds).toEqual([-1500, -1500, 1700, 1700]);
  });
});

describe('orbitStep (#144)', () => {
  const from = { target: [0, 0] as [number, number], distance: 500, yaw: 0.1, pitch: 1.2 };
  it('eases yaw and pitch, keeps the current target and distance, and turns the short way', () => {
    const to = { ...from, yaw: 2 * Math.PI - 0.1, pitch: 0.6 };
    const current = { ...from, target: [10, 20] as [number, number], distance: 300 };
    const end = orbitStep(from, to, current, 1);
    expect(end.target).toEqual([10, 20]);
    expect(end.distance).toBe(300);
    expect(end.pitch).toBeCloseTo(0.6);
    expect(end.yaw).toBeCloseTo(-0.1); // through north, not all the way round
    const mid = orbitStep(from, to, current, 0.5);
    expect(mid.pitch).toBeCloseTo(0.9);
  });
});
