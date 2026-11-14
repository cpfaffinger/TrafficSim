import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalTangentPlane } from '../network/geo';
import { encodeTile } from '../test/mvtEncoder';
import { buildBasemapMeshes, GROUND_LEVEL, triangulate } from './basemapMeshes';
import { classify, decodeTile, DEFAULT_BUILDING_HEIGHT } from './decode';
import { clearTileCache, loadBasemap, mapLimit } from './loader';
import { lonLatToTile, tileToLonLat } from './tiles';

const square = (x0: number, y0: number, size: number): [number, number][] => [
  [x0, y0],
  [x0 + size, y0],
  [x0 + size, y0 + size],
  [x0, y0 + size],
];

// The tile containing the origin, so decoded polygons land near (0, 0).
const ORIGIN = { lat: 48.2082, lon: 16.3738 };
const [tx, ty] = lonLatToTile(ORIGIN.lon, ORIGIN.lat, 14).map(Math.floor) as [number, number];
const TILE = { z: 14, x: tx, y: ty };

const sampleTile = () =>
  encodeTile([
    { name: 'water', features: [{ rings: [square(0, 0, 1024)], properties: { class: 'river' } }] },
    {
      name: 'building',
      features: [
        { rings: [square(2048, 2048, 64)], properties: { render_height: 21, render_min_height: 3 } },
        { rings: [square(3000, 3000, 32)], properties: {} },
        { rings: [square(100, 3000, 32)], properties: { hide_3d: true } },
      ],
    },
    { name: 'landcover', features: [{ rings: [square(0, 2048, 512)], properties: { class: 'rock' } }] },
    { name: 'transportation', features: [{ rings: [[[0, 0], [10, 10]]], type: 2 }] },
    {
      name: 'park',
      features: [{ rings: [square(1024, 1024, 1024), square(1280, 1280, 128).reverse()], properties: { class: 'park' } }],
    },
  ]);

describe('classify', () => {
  it('maps OpenMapTiles layers to basemap kinds', () => {
    expect(classify('water', {})).toBe('water');
    expect(classify('park', {})).toBe('park');
    expect(classify('landcover', { class: 'wood' })).toBe('park');
    expect(classify('landcover', { class: 'ice' })).toBeNull();
    expect(classify('landuse', { class: 'residential' })).toBe('landuse');
    expect(classify('landuse', { class: 'cemetery' })).toBe('park');
    expect(classify('building', {})).toBe('building');
    expect(classify('building', { hide_3d: true })).toBeNull();
    expect(classify('poi', {})).toBeNull();
  });
});

describe('decodeTile', () => {
  const plane = new LocalTangentPlane(ORIGIN);
  const polygons = decodeTile(sampleTile(), TILE, plane);

  it('decodes polygons of the supported layers', () => {
    expect(polygons.map((p) => p.kind).sort()).toEqual(['building', 'building', 'park', 'water']);
  });

  it('projects tile pixels into the local tangent plane', () => {
    const water = polygons.find((p) => p.kind === 'water')!;
    const [lon, lat] = tileToLonLat(TILE.x, TILE.y, 14);
    const expected = plane.toLocal(lon, lat);
    expect(water.rings[0]![0]![0]).toBeCloseTo(expected[0], 6);
    expect(water.rings[0]![0]![1]).toBeCloseTo(expected[1], 6);
    // A quarter tile at z14 is roughly 0.25 × 2446 m × cos(lat) wide.
    const xs = water.rings[0]!.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo((0.25 * 40075016.7 * Math.cos((48.2 * Math.PI) / 180)) / 16384, -1);
    expect(water.rings[0]).toHaveLength(4); // closing point dropped
  });

  it('keeps holes and building heights', () => {
    expect(polygons.find((p) => p.kind === 'park')!.rings).toHaveLength(2);
    const buildings = polygons.filter((p) => p.kind === 'building');
    expect(buildings.map((b) => [b.height, b.minHeight])).toEqual([
      [21, 3],
      [DEFAULT_BUILDING_HEIGHT, 0],
    ]);
  });

  it('drops features outside the clip rectangle', () => {
    expect(decodeTile(sampleTile(), TILE, plane, [1e6, 1e6, 2e6, 2e6])).toEqual([]);
  });
});

describe('basemap meshes', () => {
  it('triangulates polygons with holes', () => {
    expect(triangulate([square(0, 0, 10)])).toHaveLength(2);
    expect(triangulate([square(0, 0, 10), square(4, 4, 2).reverse()])).toHaveLength(8);
    expect(triangulate([[[0, 0], [1, 1]]])).toEqual([]);
  });

  it('places ground kinds at their own levels and extrudes buildings', () => {
    const meshes = buildBasemapMeshes([
      { kind: 'water', rings: [square(0, 0, 10)] },
      { kind: 'building', rings: [square(0, 0, 10)], height: 12, minHeight: 0 },
    ]);
    const ys = (m: (typeof meshes)['water']) => new Set(m.positions.filter((_, i) => i % 3 === 1));
    expect(ys(meshes.water)).toEqual(new Set([GROUND_LEVEL.water]));
    expect(ys(meshes.building)).toEqual(new Set([0, 12]));
    expect(meshes.building.triangleCount).toBe(2 + 4 * 2);
    expect(meshes.park.triangleCount).toBe(0);
  });
});

describe('loadBasemap', () => {
  beforeEach(() => clearTileCache());
  const tileJson = { tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'], maxzoom: 14, attribution: '<a>OpenFreeMap</a> &copy; OpenMapTiles' };
  const bbox = [16.3718, 48.2068, 16.3758, 48.2096] as const;

  it('fetches TileJSON and tiles with CORS and decodes them', async () => {
    const tile = sampleTile();
    const fetchFn = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(url.endsWith('.pbf') ? new Response(tile.slice().buffer) : new Response(JSON.stringify(tileJson))),
    );
    const result = await loadBasemap({ bbox, origin: ORIGIN, fetchFn: fetchFn as unknown as typeof fetch, marginKm: 0 });
    expect(result.attribution).toBe('OpenFreeMap © OpenMapTiles');
    expect(result.tileCount).toBeGreaterThan(0);
    expect(result.failedTiles).toBe(0);
    expect(result.polygons.length).toBeGreaterThan(0);
    expect(fetchFn.mock.calls.every((c) => (c[1] as RequestInit).mode === 'cors')).toBe(true);
    // Second load is served from the tile cache.
    fetchFn.mockClear();
    await loadBasemap({ bbox, origin: ORIGIN, fetchFn: fetchFn as unknown as typeof fetch, marginKm: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('tolerates empty and failing tiles', async () => {
    let n = 0;
    const fetchFn = vi.fn((url: string) => {
      if (!url.endsWith('.pbf')) return Promise.resolve(new Response(JSON.stringify(tileJson)));
      n++;
      return Promise.resolve(n === 1 ? new Response(null, { status: 204 }) : new Response('x', { status: 500 }));
    });
    const result = await loadBasemap({ bbox, origin: ORIGIN, fetchFn: fetchFn as unknown as typeof fetch, marginKm: 0.5 });
    expect(result.tileCount).toBeGreaterThan(1);
    expect(result.failedTiles).toBe(result.tileCount - 1);
  });

  it('fails when the source or all tiles are unavailable', async () => {
    const down = vi.fn(() => Promise.resolve(new Response('x', { status: 503 })));
    await expect(loadBasemap({ bbox, origin: ORIGIN, fetchFn: down as unknown as typeof fetch })).rejects.toThrow('TileJSON');
    const tilesDown = vi.fn((url: string) =>
      Promise.resolve(url.endsWith('.pbf') ? new Response('x', { status: 500 }) : new Response(JSON.stringify(tileJson))),
    );
    await expect(loadBasemap({ bbox, origin: ORIGIN, fetchFn: tilesDown as unknown as typeof fetch })).rejects.toThrow('unavailable');
  });
});

describe('mapLimit', () => {
  it('limits concurrency and keeps result order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (i === 3) throw new Error('boom');
      return i * 10;
    });
    expect(peak).toBe(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 'x', 40, 50]);
  });
});
