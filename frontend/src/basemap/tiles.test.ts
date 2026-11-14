import { describe, expect, it } from 'vitest';
import { attributionText, DEFAULT_BASEMAP_ATTRIBUTION, parseTileJson } from './tileJson';
import { chooseZoom, expandBbox, lonLatToTile, tilesForBbox, tileToLonLat, tileUrl } from './tiles';

describe('tile math', () => {
  it('matches known tile coordinates', () => {
    // Vienna Stephansplatz at z14 is tile 8937/5681.
    const [x, y] = lonLatToTile(16.3738, 48.2082, 14);
    expect(Math.floor(x)).toBe(8937);
    expect(Math.floor(y)).toBe(5681);
    expect(lonLatToTile(0, 0, 1)).toEqual([1, 1]);
  });

  it('round-trips', () => {
    const [x, y] = lonLatToTile(16.3738, 48.2082, 14);
    const [lon, lat] = tileToLonLat(x, y, 14);
    expect(lon).toBeCloseTo(16.3738, 9);
    expect(lat).toBeCloseTo(48.2082, 9);
  });

  it('lists the tiles covering a box', () => {
    const tiles = tilesForBbox([16.3718, 48.2068, 16.3758, 48.2096], 14);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(4);
    expect(tiles.every((t) => t.z === 14)).toBe(true);
    expect(tilesForBbox([-180, -85, 180, 85], 1)).toHaveLength(4);
  });

  it('chooses the highest zoom within the tile budget', () => {
    const small: [number, number, number, number] = [16.37, 48.2, 16.38, 48.21];
    expect(chooseZoom(small, 14)).toBe(14);
    const big: [number, number, number, number] = [16.2, 48.1, 16.6, 48.35];
    const z = chooseZoom(big, 14, 36);
    expect(z).toBeLessThan(14);
    expect(tilesForBbox(big, z).length).toBeLessThanOrEqual(36);
    expect(chooseZoom([-180, -85, 180, 85], 14, 4, 10)).toBe(10);
  });

  it('expands boxes by a margin and fills URL templates', () => {
    const b = expandBbox([16, 48, 16.1, 48.1], 1);
    expect(b[1]).toBeCloseTo(48 - 1 / 111.32, 6);
    expect(b[0]).toBeLessThan(16 - 1 / 111.32);
    expect(tileUrl('https://t.example/{z}/{x}/{y}.pbf', { z: 14, x: 1, y: 2 })).toBe('https://t.example/14/1/2.pbf');
  });
});

describe('TileJSON', () => {
  it('reads templates, zooms and plain-text attribution', () => {
    const src = parseTileJson({
      tiles: ['https://tiles.openfreemap.org/planet/x/{z}/{x}/{y}.pbf'],
      maxzoom: 14,
      attribution:
        '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    expect(src.tiles).toHaveLength(1);
    expect(src.maxzoom).toBe(14);
    expect(src.minzoom).toBe(0);
    expect(src.attribution).toBe('OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
  });

  it('falls back to defaults and rejects unusable documents', () => {
    expect(parseTileJson({ tiles: ['a/{z}/{x}/{y}'], maxzoom: 'x' }).maxzoom).toBe(14);
    expect(parseTileJson({ tiles: ['a/{z}/{x}/{y}'], attribution: '<b></b>' }).attribution).toBe(DEFAULT_BASEMAP_ATTRIBUTION);
    expect(() => parseTileJson(null)).toThrow();
    expect(() => parseTileJson({ tiles: ['no-template'] })).toThrow('no tile URL templates');
  });

  it('decodes entities without injecting markup', () => {
    expect(attributionText('a &amp; b &#169; <script>x</script> &unknown;')).toBe('a & b © x &unknown;');
  });
});
