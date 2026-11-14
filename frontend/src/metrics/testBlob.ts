/** Builds a synthetic lane-cells-v1 blob with one lane (link 2, lane 1) for tests. */
export function buildBlob({ cells, buckets, first }: { cells: number; buckets: number; first: number }): ArrayBuffer {
  const pad4 = (n: number) => (n + 3) & ~3;
  const bucketSize = 16 * cells + pad4(6 * cells);
  const size = 48 + 20 + buckets * bucketSize;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  'LCV1'.split('').forEach((ch, i) => view.setUint8(i, ch.charCodeAt(0)));
  view.setUint16(4, 1, true);
  view.setUint16(6, 48, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, cells, true);
  view.setUint32(16, buckets, true);
  view.setUint32(20, first, true);
  view.setFloat32(24, 10, true);
  view.setFloat32(28, 30, true);
  view.setFloat64(32, 25200, true);
  view.setUint32(40, 0x7f, true);
  view.setUint32(48, 2, true);
  view.setUint16(52, 1, true);
  view.setUint16(54, cells, true);
  view.setUint32(56, 0, true);
  view.setFloat32(60, 25, true);
  view.setFloat32(64, 13.5, true);
  for (let b = 0; b < buckets; b++) {
    const o = 68 + b * bucketSize;
    for (let c = 0; c < cells; c++) {
      view.setFloat32(o + 4 * c, 10 * b, true); // density
      view.setFloat32(o + 4 * cells + 4 * c, 5, true); // mean speed
      view.setFloat32(o + 8 * cells + 4 * c, b === 0 ? Number.NaN : 0.5, true); // speed ratio
      view.setFloat32(o + 12 * cells + 4 * c, 3, true); // delay
      view.setUint16(o + 16 * cells + 2 * c, 5000, true); // queue share
      view.setUint16(o + 18 * cells + 2 * c, 2, true); // stops
      view.setUint16(o + 20 * cells + 2 * c, 1, true); // flow
    }
  }
  return buffer;
}
