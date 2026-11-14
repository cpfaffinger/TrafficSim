import { describe, expect, it } from 'vitest';
import { cellValue, diffColor, EMPTY, HEATMAP_METRICS, metricColor, metricValues, smoothAlongLanes, writeCellColors } from './heatmapMetrics';
import { decodeLaneCells } from './laneCells';
import { buildBlob } from './testBlob';

const bucket = decodeLaneCells(buildBlob({ cells: 3, buckets: 2, first: 0 })).buckets[1]!;

describe('heatmap metrics (#59)', () => {
  it('reads every metric', () => {
    expect(HEATMAP_METRICS.map((m) => cellValue(bucket, 0, m))).toEqual([Math.fround(0.5), 10, 0.5, 3, 1, 2]);
    expect(Array.from(metricValues(bucket, 'density'))).toEqual([10, 10, 10]);
  });

  it('colours good values green and bad values red, empty cells neutral', () => {
    expect(metricColor('speedRatio', 1)[1]).toBeGreaterThan(0.6);
    expect(metricColor('speedRatio', 0)[0]).toBeGreaterThan(0.85);
    expect(metricColor('density', 200)[0]).toBeGreaterThan(0.85);
    expect(metricColor('density', Number.NaN)).toBe(EMPTY);
  });

  it('uses a diverging scale for differences', () => {
    expect(diffColor('speedRatio', 0)).toEqual([0.86, 0.87, 0.89]);
    diffColor('speedRatio', 1).forEach((v, i) => expect(v).toBeCloseTo([0.24, 0.39, 0.87][i]!)); // faster in B = blue
    diffColor('density', 120).forEach((v, i) => expect(v).toBeCloseTo([0.9, 0.28, 0.3][i]!)); // denser in B = red
    // a 3 % speed-ratio change is already a quarter of the way to blue (sqrt easing)
    expect(diffColor('speedRatio', 0.03)[0]).toBeCloseTo(0.86 - 0.62 * Math.sqrt(0.1));
    expect(diffColor('density', Number.NaN)).toBe(EMPTY);
  });

  it('smooths along lanes and writes four vertex colours per cell', () => {
    const smooth = smoothAlongLanes(new Float32Array([0, Number.NaN, 3, 9]), [{ firstCell: 0, cellCount: 3 }, { firstCell: 3, cellCount: 1 }], 1);
    expect(Array.from(smooth)).toEqual([0, 1.5, 3, 9]);
    const empty = smoothAlongLanes(new Float32Array([Number.NaN]), [{ firstCell: 0, cellCount: 1 }]);
    expect(Number.isNaN(empty[0]!)).toBe(true);
    const target = new Float32Array(2 * 4 * 3);
    writeCellColors(target, new Float32Array([0, 1]), (v) => [v, v, v]);
    expect(Array.from(target.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(target.slice(12, 15))).toEqual([1, 1, 1]);
  });
});
