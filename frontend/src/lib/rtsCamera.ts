/**
 * City-builder / RTS camera model (#33), pure math in scene coordinates (x east, y up, z −north).
 * The camera orbits a ground target at `distance`, turned by `yaw` around the vertical axis and tilted
 * by `pitch` above the horizon. `yaw = 0` looks north.
 */

export interface RtsCameraState {
  /** Ground target `[x, z]` in scene coordinates (y = 0). */
  target: [number, number];
  distance: number;
  yaw: number;
  pitch: number;
}

export interface RtsCameraLimits {
  minDistance: number;
  maxDistance: number;
  minPitch: number;
  maxPitch: number;
  /** Optional rectangle `[minX, minZ, maxX, maxZ]` the target must stay in. */
  bounds: [number, number, number, number] | null;
}

const DEG = Math.PI / 180;

export const DEFAULT_LIMITS: RtsCameraLimits = {
  minDistance: 8,
  maxDistance: 12_000,
  minPitch: 12 * DEG,
  maxPitch: 89 * DEG,
  bounds: null,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampState(s: RtsCameraState, limits: RtsCameraLimits = DEFAULT_LIMITS): RtsCameraState {
  const b = limits.bounds;
  return {
    target: b ? [clamp(s.target[0], b[0], b[2]), clamp(s.target[1], b[1], b[3])] : [s.target[0], s.target[1]],
    distance: clamp(s.distance, limits.minDistance, limits.maxDistance),
    yaw: normaliseAngle(s.yaw),
    pitch: clamp(s.pitch, limits.minPitch, limits.maxPitch),
  };
}

export function normaliseAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Camera eye position in scene coordinates. */
export function cameraPosition(s: RtsCameraState): [number, number, number] {
  const h = s.distance * Math.cos(s.pitch);
  return [s.target[0] + h * Math.sin(s.yaw), s.distance * Math.sin(s.pitch), s.target[1] + h * Math.cos(s.yaw)];
}

/** Horizontal unit vectors `[x, z]` pointing forward (view direction) and right on screen. */
export function groundAxes(yaw: number): { forward: [number, number]; right: [number, number] } {
  return { forward: [-Math.sin(yaw), -Math.cos(yaw)], right: [Math.cos(yaw), -Math.sin(yaw)] };
}

/** Grab-style pan: the ground point under the cursor moved from `from` to `to`; keep it under the cursor. */
export function panByGroundDelta(s: RtsCameraState, from: [number, number], to: [number, number], limits = DEFAULT_LIMITS): RtsCameraState {
  return clampState({ ...s, target: [s.target[0] - (to[0] - from[0]), s.target[1] - (to[1] - from[1])] }, limits);
}

/**
 * Keyboard pan in screen-aligned directions. `forward` and `right` are in [-1, 1]; the step scales with
 * the distance so panning feels the same at every zoom level.
 */
export function panRelative(s: RtsCameraState, forward: number, right: number, dt: number, limits = DEFAULT_LIMITS): RtsCameraState {
  const { forward: f, right: r } = groundAxes(s.yaw);
  const speed = s.distance * 0.9 * dt;
  return clampState(
    { ...s, target: [s.target[0] + (f[0] * forward + r[0] * right) * speed, s.target[1] + (f[1] * forward + r[1] * right) * speed] },
    limits,
  );
}

export function rotate(s: RtsCameraState, dYaw: number, dPitch: number, limits = DEFAULT_LIMITS): RtsCameraState {
  return clampState({ ...s, yaw: s.yaw + dYaw, pitch: s.pitch + dPitch }, limits);
}

/**
 * Zoom by `factor` (< 1 = closer) towards a ground point (the point under the cursor). Scaling the eye
 * and target about that point keeps it fixed on screen.
 */
export function zoomTowards(s: RtsCameraState, factor: number, point: [number, number] | null, limits = DEFAULT_LIMITS): RtsCameraState {
  const distance = clamp(s.distance * factor, limits.minDistance, limits.maxDistance);
  const k = distance / s.distance;
  const p = point ?? s.target;
  return clampState({ ...s, distance, target: [p[0] + (s.target[0] - p[0]) * k, p[1] + (s.target[1] - p[1]) * k] }, limits);
}

/** Wheel delta (pixels) → zoom factor; one notch (≈100 px) zooms by ~15 %. */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(clamp(deltaY, -500, 500) * 0.0015);
}

/** A view that frames the rectangle `[minX, minZ, maxX, maxZ]` (scene coordinates). */
export function frameRect(rect: [number, number, number, number], fovY: number, aspect: number, limits = DEFAULT_LIMITS): RtsCameraState {
  const w = Math.max(rect[2] - rect[0], 1);
  const d = Math.max(rect[3] - rect[1], 1);
  const pitch = 55 * DEG;
  const halfV = Math.tan(fovY / 2);
  const halfH = halfV * Math.max(aspect, 0.1);
  // Distance at which both half-extents fit (approximation for a tilted view, with a 15 % margin).
  const distance = 1.15 * Math.max(w / 2 / halfH, d / 2 / halfV / Math.sin(pitch));
  return clampState({ target: [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2], distance, yaw: 0, pitch }, limits);
}

/** Near/far planes that keep depth precision usable from street level to city scale. */
export function clipPlanes(distance: number): { near: number; far: number } {
  return { near: clamp(distance * 0.01, 0.2, 50), far: Math.max(2_000, distance * 25) };
}

/** Intersection of a ray with the horizontal plane y = h, or null when parallel or behind the origin. */
export function intersectGround(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  h = 0,
): [number, number] | null {
  if (Math.abs(dir[1]) < 1e-9) return null;
  const t = (h - origin[1]) / dir[1];
  if (t < 0) return null;
  return [origin[0] + dir[0] * t, origin[2] + dir[2] * t];
}

/** True when a pointer moved less than `tolerance` pixels between press and release (a click, not a drag). */
export function isClick(down: { x: number; y: number }, up: { x: number; y: number }, tolerance = 4): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= tolerance;
}
