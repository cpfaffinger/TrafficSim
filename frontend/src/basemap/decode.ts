import { classifyRings, VectorTile, type VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { LocalTangentPlane } from '../network/geo';
import type { TileId } from './tiles';
import { tileToLonLat } from './tiles';

/** Decodes OpenMapTiles-schema vector tiles into ground polygons in the package's local plane (#36). */

export type BasemapKind = 'water' | 'park' | 'landuse' | 'building';

export interface BasemapPolygon {
  kind: BasemapKind;
  /** Outer ring first, then holes; `[east, north]` metres, open (no repeated closing point). */
  rings: [number, number][][];
  /** Buildings only: roof and base height in metres. */
  height?: number;
  minHeight?: number;
}

const GREEN_LANDCOVER = new Set(['grass', 'wood', 'forest', 'farmland', 'wetland', 'sand']);
const GREEN_LANDUSE = new Set(['cemetery', 'pitch', 'playground', 'stadium', 'zoo', 'garden']);
export const DEFAULT_BUILDING_HEIGHT = 10;
const POLYGON = 3;

type Props = Record<string, number | string | boolean>;

/** Maps an OpenMapTiles layer + properties to a basemap kind, or null to skip the feature. */
export function classify(layer: string, props: Props): BasemapKind | null {
  switch (layer) {
    case 'water':
      return 'water';
    case 'park':
      return 'park';
    case 'landcover':
      return GREEN_LANDCOVER.has(String(props.class)) ? 'park' : null;
    case 'landuse':
      return GREEN_LANDUSE.has(String(props.class)) ? 'park' : 'landuse';
    case 'building':
      return props.hide_3d === true ? null : 'building';
    default:
      return null;
  }
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** `[minEast, minNorth, maxEast, maxNorth]` of interest; features entirely outside are dropped. */
export type ClipRect = [number, number, number, number];

export function decodeTile(data: ArrayBuffer | Uint8Array, tile: TileId, plane: LocalTangentPlane, clip?: ClipRect): BasemapPolygon[] {
  const vt = new VectorTile(new PbfReader(data));
  const out: BasemapPolygon[] = [];
  for (const [name, layer] of Object.entries(vt.layers)) {
    for (let i = 0; i < layer.length; i++) {
      const feature: VectorTileFeature = layer.feature(i);
      if (feature.type !== POLYGON) continue;
      const kind = classify(name, feature.properties);
      if (!kind) continue;
      const extent = feature.extent;
      const project = (p: { x: number; y: number }): [number, number] => {
        const [lon, lat] = tileToLonLat(tile.x + p.x / extent, tile.y + p.y / extent, tile.z);
        return plane.toLocal(lon, lat);
      };
      for (const polygon of classifyRings(feature.loadGeometry())) {
        const rings = polygon.map((ring) => openRing(ring.map(project))).filter((r) => r.length >= 3);
        if (rings.length === 0 || (clip && !overlaps(rings[0]!, clip))) continue;
        const item: BasemapPolygon = { kind, rings };
        if (kind === 'building') {
          item.height = num(feature.properties.render_height, DEFAULT_BUILDING_HEIGHT);
          item.minHeight = num(feature.properties.render_min_height, 0);
        }
        out.push(item);
      }
    }
  }
  return out;
}

function openRing(ring: [number, number][]): [number, number][] {
  const first = ring[0];
  const last = ring.at(-1);
  if (first && last && ring.length > 1 && first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

function overlaps(ring: [number, number][], r: ClipRect): boolean {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x1 >= r[0] && x0 <= r[2] && y1 >= r[1] && y0 <= r[3];
}
