import { speedColor, type Rgb } from '../lib/colorScale';
import type { CellBucket } from './laneCells';

export const HEATMAP_METRICS = ['speedRatio', 'density', 'queue', 'delay', 'flow', 'stops'] as const;
export type HeatmapMetric = (typeof HEATMAP_METRICS)[number];

export interface MetricInfo {
  label: string;
  unit: string;
  /** Value range mapped onto the colour scale. */
  max: number;
  /** True when higher values are better (green). */
  higherIsBetter: boolean;
}

export const METRIC_INFO: Record<HeatmapMetric, MetricInfo> = {
  speedRatio: { label: 'Speed / limit', unit: '%', max: 1, higherIsBetter: true },
  density: { label: 'Density', unit: 'veh/km', max: 120, higherIsBetter: false },
  queue: { label: 'Queue share', unit: '%', max: 1, higherIsBetter: false },
  delay: { label: 'Delay', unit: 'veh·s', max: 60, higherIsBetter: false },
  flow: { label: 'Flow', unit: 'veh/bucket', max: 30, higherIsBetter: true },
  stops: { label: 'Stops', unit: 'per bucket', max: 10, higherIsBetter: false },
};

/** Raw value of a cell; NaN when there was no traffic. */
export function cellValue(bucket: CellBucket, cell: number, metric: HeatmapMetric): number {
  switch (metric) {
    case 'speedRatio':
      return bucket.speedRatio[cell]!;
    case 'density':
      return bucket.density[cell]!;
    case 'queue':
      return bucket.queueShare[cell]! / 10000;
    case 'delay':
      return bucket.delay[cell]!;
    case 'flow':
      return bucket.flow[cell]!;
    case 'stops':
      return bucket.stops[cell]!;
  }
}

/** Colour of a value: green = good … red = bad; empty cells (NaN / no traffic) get the neutral colour. */
export function metricColor(metric: HeatmapMetric, value: number): Rgb {
  if (Number.isNaN(value)) return EMPTY;
  const info = METRIC_INFO[metric];
  const t = Math.min(1, Math.max(0, value / info.max));
  return speedColor(info.higherIsBetter ? t : 1 - t);
}

export const EMPTY: Rgb = [0.72, 0.74, 0.76];

/** Diverging colour for differences B − A normalised by `max`: blue = better in B, red = worse. */
export function diffColor(metric: HeatmapMetric, delta: number): Rgb {
  if (Number.isNaN(delta)) return EMPTY;
  const info = METRIC_INFO[metric];
  const t = Math.max(-1, Math.min(1, delta / info.max)) * (info.higherIsBetter ? 1 : -1);
  // t > 0: improvement (blue), t < 0: worse (red), 0: white
  return t >= 0 ? [1 - 0.8 * t, 1 - 0.55 * t, 1] : [1, 1 + 0.75 * t, 1 + 0.8 * t];
}

/** Moving average along each lane (smoothed density overlay, #59). Empty cells stay empty. */
export function smoothAlongLanes(values: Float32Array, lanes: readonly { firstCell: number; cellCount: number }[], radius = 2): Float32Array {
  const out = new Float32Array(values.length).fill(Number.NaN);
  for (const lane of lanes) {
    for (let i = 0; i < lane.cellCount; i++) {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - radius); k <= Math.min(lane.cellCount - 1, i + radius); k++) {
        const v = values[lane.firstCell + k]!;
        if (!Number.isNaN(v)) {
          sum += v;
          n++;
        }
      }
      if (n > 0) out[lane.firstCell + i] = sum / n;
    }
  }
  return out;
}

/** Values of one metric for all cells of a bucket. */
export function metricValues(bucket: CellBucket, metric: HeatmapMetric): Float32Array {
  const out = new Float32Array(bucket.density.length);
  for (let c = 0; c < out.length; c++) out[c] = cellValue(bucket, c, metric);
  return out;
}

/** Writes RGB vertex colours (4 vertices per cell) for the given per-cell values. */
export function writeCellColors(target: Float32Array, values: Float32Array, color: (v: number) => Rgb): void {
  for (let c = 0; c < values.length; c++) {
    const [r, g, b] = color(values[c]!);
    for (let v = 0; v < 4; v++) {
      const o = (c * 4 + v) * 3;
      target[o] = r;
      target[o + 1] = g;
      target[o + 2] = b;
    }
  }
}
