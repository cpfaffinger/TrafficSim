import { LocalTangentPlane } from '../network/geo';
import type { BBox, GeoOrigin } from '../network/types';
import { decodeTile, type BasemapPolygon, type ClipRect } from './decode';
import { OPENFREEMAP_TILEJSON, parseTileJson } from './tileJson';
import { chooseZoom, expandBbox, tileToLonLat, tilesForBbox, tileUrl, type TileId } from './tiles';

/**
 * Loads basemap polygons for an area from OpenFreeMap vector tiles (#36). The browser fetches the
 * public tiles directly with CORS (works under COEP `require-corp`). Single tile failures are
 * tolerated; the caller falls back to a plain ground when the whole basemap is unavailable.
 */

export interface BasemapResult {
  polygons: BasemapPolygon[];
  attribution: string;
  tileCount: number;
  failedTiles: number;
}

export interface LoadBasemapOptions {
  bbox: BBox;
  origin: GeoOrigin;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  tileJsonUrl?: string;
  maxTiles?: number;
  marginKm?: number;
  concurrency?: number;
}

const tileCache = new Map<string, ArrayBuffer>();
const TILE_CACHE_SIZE = 96;

function remember(url: string, data: ArrayBuffer): void {
  tileCache.set(url, data);
  if (tileCache.size > TILE_CACHE_SIZE) tileCache.delete(tileCache.keys().next().value!);
}

export function clearTileCache(): void {
  tileCache.clear();
}

async function fetchTile(fetchFn: typeof fetch, url: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  const cached = tileCache.get(url);
  if (cached) return cached;
  const response = await fetchFn(url, { mode: 'cors', signal });
  if (response.status === 204 || response.status === 404) return null; // empty tile (e.g. open sea)
  if (!response.ok) throw new Error(`Tile ${url}: HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  remember(url, data);
  return data;
}

/** Runs `tasks` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await task(items[i]!) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchSource(fetchFn: typeof fetch, url: string, signal?: AbortSignal) {
  const response = await fetchFn(url, { mode: 'cors', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`TileJSON: HTTP ${response.status}`);
  return parseTileJson(await response.json());
}

/** The parts of `outer` around `inner` as up to four boxes (south, north, west, east strip). */
export function ringStrips(inner: BBox, outer: BBox): BBox[] {
  const [ow, os, oe, on] = outer;
  const iw = Math.max(inner[0], ow);
  const is = Math.max(inner[1], os);
  const ie = Math.min(inner[2], oe);
  const inn = Math.min(inner[3], on);
  const strips: BBox[] = [
    [ow, os, oe, is],
    [ow, inn, oe, on],
    [ow, is, iw, inn],
    [ie, is, oe, inn],
  ];
  return strips.filter((b) => b[2] > b[0] && b[3] > b[1]);
}

const overlaps = (a: BBox, b: BBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function tileBbox(t: TileId): BBox {
  const [w, n] = tileToLonLat(t.x, t.y, t.z);
  const [e, s] = tileToLonLat(t.x + 1, t.y + 1, t.z);
  return [w, s, e, n];
}

export interface LoadBasemapRingOptions extends Omit<LoadBasemapOptions, 'bbox' | 'marginKm'> {
  /** Area already covered in detail by `loadBasemap`. */
  inner: BBox;
  /** Outer edge of the surroundings. */
  outer: BBox;
}

/**
 * Ground polygons (no buildings) for the surroundings of a loaded network, between `inner` and
 * `outer`, at the zoom that fits `outer` into `maxTiles` (#122): the camera may pan beyond the
 * imported area, which then still shows land, parks and water instead of an empty plane.
 */
export async function loadBasemapRing(options: LoadBasemapRingOptions): Promise<BasemapResult> {
  const {
    inner,
    outer,
    origin,
    fetchFn = (input, init) => fetch(input, init),
    signal,
    tileJsonUrl = OPENFREEMAP_TILEJSON,
    maxTiles = 30,
    concurrency = 6,
  } = options;
  const source = await fetchSource(fetchFn, tileJsonUrl, signal);
  const zoom = chooseZoom(outer, Math.min(source.maxzoom, 14), maxTiles, Math.max(source.minzoom, 0));
  const plane = new LocalTangentPlane(origin);
  const strips = ringStrips(inner, outer);
  const clips = strips.map((b): ClipRect => {
    const [w, s] = plane.toLocal(b[0], b[1]);
    const [e, n] = plane.toLocal(b[2], b[3]);
    return [w, s, e, n];
  });
  const tiles = tilesForBbox(outer, zoom).filter((t) => strips.some((s) => overlaps(tileBbox(t), s)));
  const template = (t: TileId) => source.tiles[(t.x + t.y) % source.tiles.length]!;
  const results = await mapLimit(tiles, concurrency, async (t) => {
    const data = await fetchTile(fetchFn, tileUrl(template(t), t), signal);
    if (!data) return [];
    const box = tileBbox(t);
    return strips
      .flatMap((s, i) => (overlaps(box, s) ? decodeTile(data, t, plane, clips[i]) : []))
      .filter((p) => p.kind !== 'building');
  });
  signal?.throwIfAborted();
  const failedTiles = results.filter((r) => r.status === 'rejected').length;
  if (tiles.length > 0 && failedTiles === tiles.length) {
    throw new Error('Basemap tiles are unavailable.');
  }
  const polygons = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return { polygons, attribution: source.attribution, tileCount: tiles.length, failedTiles };
}

export async function loadBasemap(options: LoadBasemapOptions): Promise<BasemapResult> {
  const {
    bbox,
    origin,
    fetchFn = (input, init) => fetch(input, init),
    signal,
    tileJsonUrl = OPENFREEMAP_TILEJSON,
    maxTiles = 36,
    marginKm = 0.3,
    concurrency = 6,
  } = options;
  const source = await fetchSource(fetchFn, tileJsonUrl, signal);

  const area = expandBbox(bbox, marginKm);
  const zoom = chooseZoom(area, Math.min(source.maxzoom, 14), maxTiles, Math.max(source.minzoom, 0));
  const tiles = tilesForBbox(area, zoom);
  const plane = new LocalTangentPlane(origin);
  const [w, s] = plane.toLocal(area[0], area[1]);
  const [e, n] = plane.toLocal(area[2], area[3]);
  const clip: ClipRect = [w, s, e, n];

  const template = (t: TileId) => source.tiles[(t.x + t.y) % source.tiles.length]!;
  const results = await mapLimit(tiles, concurrency, async (t) => {
    const data = await fetchTile(fetchFn, tileUrl(template(t), t), signal);
    return data ? decodeTile(data, t, plane, clip) : [];
  });
  signal?.throwIfAborted();
  const failedTiles = results.filter((r) => r.status === 'rejected').length;
  if (tiles.length > 0 && failedTiles === tiles.length) {
    throw new Error('Basemap tiles are unavailable.');
  }
  const polygons = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return { polygons, attribution: source.attribution, tileCount: tiles.length, failedTiles };
}
