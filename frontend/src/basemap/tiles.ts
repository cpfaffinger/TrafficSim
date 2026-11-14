import type { BBox } from '../network/types';

/** Web Mercator (XYZ) tile math for the basemap (#36). */

export interface TileId {
  z: number;
  x: number;
  y: number;
}

const MAX_LAT = 85.0511287798066;

/** Fractional tile coordinates of a WGS84 point at zoom z. */
export function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n;
  return [x, y];
}

/** WGS84 `[lon, lat]` of fractional tile coordinates at zoom z. */
export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** Inclusive tile index range `[x0, y0, x1, y1]` covering the box at zoom z. */
function tileRange(b: BBox, z: number): [number, number, number, number] {
  const [x0, y0] = lonLatToTile(b[0], b[3], z); // north-west
  const [x1, y1] = lonLatToTile(b[2], b[1], z); // south-east
  const max = 2 ** z - 1;
  const c = (v: number) => Math.min(max, Math.max(0, Math.floor(v)));
  return [c(x0), c(y0), c(x1), c(y1)];
}

export function tileCount(b: BBox, z: number): number {
  const [x0, y0, x1, y1] = tileRange(b, z);
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

/** Tiles at zoom z intersecting the box. */
export function tilesForBbox(b: BBox, z: number): TileId[] {
  const [x0, y0, x1, y1] = tileRange(b, z);
  const out: TileId[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) out.push({ z, x, y });
  }
  return out;
}

/** Highest zoom ≤ maxZoom (and ≥ minZoom) at which the box needs at most `maxTiles` tiles. */
export function chooseZoom(b: BBox, maxZoom: number, maxTiles = 36, minZoom = 10): number {
  for (let z = maxZoom; z > minZoom; z--) {
    if (tileCount(b, z) <= maxTiles) return z;
  }
  return minZoom;
}

/** Expands a box by `marginKm` on every side (approximate, for fetching surroundings). */
export function expandBbox(b: BBox, marginKm: number): BBox {
  const dLat = marginKm / 111.32;
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  const dLon = marginKm / (111.32 * Math.max(Math.cos(midLat), 0.01));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

/** Fills a `{z}/{x}/{y}` URL template. */
export function tileUrl(template: string, t: TileId): string {
  return template.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
}
