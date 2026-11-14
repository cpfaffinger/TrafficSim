import { LocalTangentPlane } from '../network/geo';
import type { BBox } from '../network/types';

/** Import area helpers (#34). Boxes are WGS84 `[west, south, east, north]`. */

export const DEFAULT_AREA_KM = 1.5;
export const MIN_AREA_SIDE_KM = 0.1;
/** Result boxes larger than this (e.g. whole cities) are replaced by a square around the point. */
export const MAX_PROPOSED_AREA_KM2 = 9;

export function bboxCentre(b: BBox): { lat: number; lon: number } {
  return { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 };
}

/** Width and height in kilometres, measured through the centre. */
export function bboxSizeKm(b: BBox): { widthKm: number; heightKm: number } {
  const plane = new LocalTangentPlane(bboxCentre(b));
  const [w, s] = plane.toLocal(b[0], b[1]);
  const [e, n] = plane.toLocal(b[2], b[3]);
  return { widthKm: (e - w) / 1000, heightKm: (n - s) / 1000 };
}

export function bboxAreaKm2(b: BBox): number {
  const { widthKm, heightKm } = bboxSizeKm(b);
  return widthKm * heightKm;
}

/** A `widthKm` × `heightKm` box centred on a point. */
export function boxAround(lat: number, lon: number, widthKm: number, heightKm = widthKm): BBox {
  const plane = new LocalTangentPlane({ lat, lon });
  const [w, s] = plane.toGeo((-widthKm * 1000) / 2, (-heightKm * 1000) / 2);
  const [e, n] = plane.toGeo((widthKm * 1000) / 2, (heightKm * 1000) / 2);
  return [w, s, e, n];
}

/** Same centre, new size (each side at least MIN_AREA_SIDE_KM). */
export function resizeBbox(b: BBox, widthKm: number, heightKm: number): BBox {
  const c = bboxCentre(b);
  return boxAround(c.lat, c.lon, Math.max(MIN_AREA_SIDE_KM, widthKm), Math.max(MIN_AREA_SIDE_KM, heightKm));
}

export interface AreaProposalInput {
  latitude: number;
  longitude: number;
  bbox: BBox | readonly number[] | null;
}

/**
 * Initial import area for a search result: its own box when that is a sensible street/district size,
 * otherwise a DEFAULT_AREA_KM square around the point.
 */
export function proposeArea(result: AreaProposalInput): BBox {
  const b = result.bbox;
  if (b && b.length === 4 && b[0]! < b[2]! && b[1]! < b[3]!) {
    const box: BBox = [b[0]!, b[1]!, b[2]!, b[3]!];
    const { widthKm, heightKm } = bboxSizeKm(box);
    if (widthKm >= MIN_AREA_SIDE_KM && heightKm >= MIN_AREA_SIDE_KM && widthKm * heightKm <= MAX_PROPOSED_AREA_KM2) return box;
  }
  return boxAround(result.latitude, result.longitude, DEFAULT_AREA_KM);
}

export function formatKm2(value: number): string {
  return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

/** Rounds coordinates to ~1 m (6 decimals) so equal areas produce identical requests. */
export function roundBbox(b: BBox): BBox {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(b[0]), r(b[1]), r(b[2]), r(b[3])];
}
