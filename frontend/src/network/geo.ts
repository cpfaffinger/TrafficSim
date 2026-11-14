import type { GeoOrigin, Vec3 } from './types';

const SEMI_MAJOR_AXIS = 6_378_137.0;
const FLATTENING = 1 / 298.257223563;
const E2 = FLATTENING * (2 - FLATTENING);
const DEG = Math.PI / 180;

/**
 * WGS84 ↔ local East-North plane in metres around an origin (ADR-0011). Mirrors the backend's
 * `LocalTangentPlane` (meridional and prime-vertical radii at the origin) so basemap features line up
 * with the network package.
 */
export class LocalTangentPlane {
  private readonly metresPerDegNorth: number;
  private readonly metresPerDegEast: number;

  constructor(readonly origin: GeoOrigin) {
    const phi = origin.lat * DEG;
    const sin = Math.sin(phi);
    const w = Math.sqrt(1 - E2 * sin * sin);
    this.metresPerDegNorth = ((SEMI_MAJOR_AXIS * (1 - E2)) / (w * w * w)) * DEG;
    this.metresPerDegEast = (SEMI_MAJOR_AXIS / w) * Math.cos(phi) * DEG;
  }

  /** Returns `[east, north]` in metres. */
  toLocal(lon: number, lat: number): [number, number] {
    return [(lon - this.origin.lon) * this.metresPerDegEast, (lat - this.origin.lat) * this.metresPerDegNorth];
  }

  /** Returns `[lon, lat]` in degrees. */
  toGeo(east: number, north: number): [number, number] {
    return [this.origin.lon + east / this.metresPerDegEast, this.origin.lat + north / this.metresPerDegNorth];
  }
}

/** Package ENU `[east, north, up]` → Three.js scene `[x, y, z]` with x = east, y = up, z = −north (ADR-0011). */
export function toScene(p: Vec3): [number, number, number] {
  return [p[0], p[2], -p[1]];
}

/** Scene `[x, y, z]` → package ENU `[east, north, up]`. */
export function fromScene(x: number, y: number, z: number): [number, number, number] {
  return [x, -z, y];
}
