import { LocalTangentPlane } from '../network/geo';
import type { BBox, GeoOrigin } from '../network/types';
import { decodeTile, type BasemapPolygon, type ClipRect } from './decode';
import { OPENFREEMAP_TILEJSON, parseTileJson } from './tileJson';
import { chooseZoom, expandBbox, tilesForBbox, tileUrl, type TileId } from './tiles';

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
  const response = await fetchFn(tileJsonUrl, { mode: 'cors', signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`TileJSON: HTTP ${response.status}`);
  const source = parseTileJson(await response.json());

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
