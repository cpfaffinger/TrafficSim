/** TileJSON handling for the OpenFreeMap basemap source (#36). */

export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const DEFAULT_BASEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap';

export interface TileSource {
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  attribution: string;
}

/** Validates the parts of a TileJSON document we use. */
export function parseTileJson(json: unknown): TileSource {
  if (typeof json !== 'object' || json === null) throw new Error('TileJSON: expected an object');
  const o = json as Record<string, unknown>;
  const tiles = Array.isArray(o.tiles) ? o.tiles.filter((t): t is string => typeof t === 'string' && t.includes('{z}')) : [];
  if (tiles.length === 0) throw new Error('TileJSON: no tile URL templates');
  const zoom = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    tiles,
    minzoom: zoom(o.minzoom, 0),
    maxzoom: zoom(o.maxzoom, 14),
    attribution: typeof o.attribution === 'string' ? attributionText(o.attribution) || DEFAULT_BASEMAP_ATTRIBUTION : DEFAULT_BASEMAP_ATTRIBUTION,
  };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©', nbsp: ' ' };

/** TileJSON attributions are HTML; we render plain text (never inject provider HTML). */
export function attributionText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) =>
      e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, ' ')
    .trim();
}
