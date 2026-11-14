// Test support: a minimal Mapbox Vector Tile (MVT 2.1) encoder for polygon features.
import { PbfWriter } from 'pbf';

export interface TestFeature {
  /** Rings in tile pixel coordinates (0..extent), closed implicitly. */
  rings: [number, number][][];
  properties?: Record<string, string | number | boolean>;
  type?: 1 | 2 | 3;
}

export interface TestLayer {
  name: string;
  features: TestFeature[];
  extent?: number;
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

function geometry(rings: [number, number][][]): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const ring of rings) {
    const [first, ...rest] = ring;
    out.push((1 & 7) | (1 << 3), zigzag(first![0] - cx), zigzag(first![1] - cy));
    [cx, cy] = first!;
    out.push((2 & 7) | (rest.length << 3));
    for (const [x, y] of rest) {
      out.push(zigzag(x - cx), zigzag(y - cy));
      [cx, cy] = [x, y];
    }
    out.push((7 & 7) | (1 << 3));
  }
  return out;
}

type Value = string | number | boolean;

function writeLayer(layer: TestLayer, pbf: PbfWriter): void {
  const keys: string[] = [];
  const values: Value[] = [];
  const tagsOf = (props: Record<string, Value>) =>
    Object.entries(props).flatMap(([k, v]) => {
      let ki = keys.indexOf(k);
      if (ki < 0) ki = keys.push(k) - 1;
      let vi = values.indexOf(v);
      if (vi < 0) vi = values.push(v) - 1;
      return [ki, vi];
    });
  const encoded = layer.features.map((f) => ({ tags: tagsOf(f.properties ?? {}), type: f.type ?? 3, geometry: geometry(f.rings) }));
  pbf.writeVarintField(15, 2);
  pbf.writeStringField(1, layer.name);
  for (const f of encoded) {
    pbf.writeMessage(
      2,
      (feat: typeof f, p: PbfWriter) => {
        p.writePackedVarint(2, feat.tags);
        p.writeVarintField(3, feat.type);
        p.writePackedVarint(4, feat.geometry);
      },
      f,
    );
  }
  for (const k of keys) pbf.writeStringField(3, k);
  for (const v of values) {
    pbf.writeMessage(
      4,
      (val: Value, p: PbfWriter) => {
        if (typeof val === 'string') p.writeStringField(1, val);
        else if (typeof val === 'boolean') p.writeBooleanField(7, val);
        else p.writeDoubleField(3, val);
      },
      v,
    );
  }
  pbf.writeVarintField(5, layer.extent ?? 4096);
}

export function encodeTile(layers: TestLayer[]): Uint8Array {
  const pbf = new PbfWriter();
  for (const layer of layers) pbf.writeMessage(3, writeLayer, layer);
  return pbf.finish();
}
