import { cellValue, type HeatmapMetric } from '../metrics/heatmapMetrics';
import type { LaneCellsBlob, LaneRow } from '../metrics/laneCells';
import type { Link, NetworkPackage } from '../network/types';
import { asSummary, RUN_KPIS } from './runStats';

/**
 * A/B comparison of two runs (#74): a cell-level diff when both runs share the lane-cell layout,
 * otherwise a per-link KPI diff with links matched by their OSM keys.
 */

export function sameLayout(a: LaneCellsBlob, b: LaneCellsBlob): boolean {
  if (a.laneCount !== b.laneCount || a.cellCount !== b.cellCount || a.cellLength !== b.cellLength) return false;
  return a.lanes.every((l, i) => {
    const m = b.lanes[i]!;
    return l.linkIndex === m.linkIndex && l.laneIndex === m.laneIndex && l.cellCount === m.cellCount && l.firstCell === m.firstCell;
  });
}

/** True when every lane row exists in the package, i.e. the cells can be drawn on it. */
export function layoutFits(pkg: NetworkPackage, lanes: readonly LaneRow[]): boolean {
  return lanes.every((row) => pkg.links[row.linkIndex]?.lanes.some((l) => l.index === row.laneIndex) ?? false);
}

/** Per-cell mean of a metric over all buckets of a run; NaN where the cell never had traffic. */
export function meanValues(blob: LaneCellsBlob, metric: HeatmapMetric): Float32Array {
  const sum = new Float64Array(blob.cellCount);
  const count = new Uint32Array(blob.cellCount);
  for (const bucket of blob.buckets) {
    for (let c = 0; c < blob.cellCount; c++) {
      const v = cellValue(bucket, c, metric);
      if (!Number.isNaN(v)) {
        sum[c] = sum[c]! + v;
        count[c] = count[c]! + 1;
      }
    }
  }
  const out = new Float32Array(blob.cellCount);
  for (let c = 0; c < out.length; c++) out[c] = count[c]! > 0 ? sum[c]! / count[c]! : Number.NaN;
  return out;
}

/** B − A per cell (NaN where either run has no value). */
export function cellDelta(a: LaneCellsBlob, b: LaneCellsBlob, metric: HeatmapMetric): Float32Array {
  const ma = meanValues(a, metric);
  const mb = meanValues(b, metric);
  const out = new Float32Array(mb.length);
  for (let c = 0; c < out.length; c++) out[c] = mb[c]! - ma[c]!;
  return out;
}

/** Stable identity of a link across scenarios: OSM way, neighbour nodes and direction. */
export function linkKey(link: Link): string | null {
  if (link.osmWayId === null) return null;
  return `${link.osmWayId}:${link.osmAfterFrom ?? ''}:${link.osmBeforeTo ?? ''}:${link.osmForward === false ? 'b' : 'f'}`;
}

export const LINK_METRICS = {
  meanSpeed: { label: 'Mean speed', unit: 'km/h', scale: 3.6, higherIsBetter: true },
  delay: { label: 'Delay per vehicle', unit: 's', scale: 1, higherIsBetter: false },
  flow: { label: 'Flow', unit: 'veh/h', scale: 1, higherIsBetter: true },
  queueMean: { label: 'Mean queue', unit: 'veh', scale: 1, higherIsBetter: false },
} as const;
export type LinkMetric = keyof typeof LINK_METRICS;

export interface LinkDelta {
  key: string;
  name: string;
  a: number;
  b: number;
  delta: number;
}

function linkValues(pkg: NetworkPackage, summary: unknown, metric: LinkMetric): Map<string, { name: string; value: number }> {
  const byId = new Map(pkg.links.map((l) => [l.id, l]));
  const scale = LINK_METRICS[metric].scale;
  const out = new Map<string, { name: string; value: number }>();
  for (const raw of asSummary(summary).links ?? []) {
    const m = raw as Record<string, unknown>;
    const link = typeof m.id === 'string' ? byId.get(m.id) : undefined;
    const key = link ? linkKey(link) : null;
    const value = m[metric];
    if (!link || !key || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out.set(key, { name: link.name ?? `way ${link.osmWayId}`, value: value * scale });
  }
  return out;
}

/** Links present in both runs, largest absolute change first. */
export function linkDeltas(pkgA: NetworkPackage, summaryA: unknown, pkgB: NetworkPackage, summaryB: unknown, metric: LinkMetric): LinkDelta[] {
  const a = linkValues(pkgA, summaryA, metric);
  const b = linkValues(pkgB, summaryB, metric);
  const out: LinkDelta[] = [];
  for (const [key, vb] of b) {
    const va = a.get(key);
    if (va) out.push({ key, name: vb.name, a: va.value, b: vb.value, delta: vb.value - va.value });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

export interface KpiDelta {
  key: string;
  label: string;
  unit: string;
  digits: number;
  a: number | null;
  b: number | null;
  /** Relative change in %, null when not computable. */
  pct: number | null;
  /** +1 better, −1 worse, 0 unchanged / unknown. */
  verdict: -1 | 0 | 1;
}

export function networkDeltas(summaryA: unknown, summaryB: unknown): KpiDelta[] {
  const sa = asSummary(summaryA);
  const sb = asSummary(summaryB);
  return RUN_KPIS.map((k) => {
    const a = k.get(sa);
    const b = k.get(sb);
    const pct = a !== null && b !== null && a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null;
    const diff = a !== null && b !== null ? b - a : 0;
    const verdict = diff === 0 ? 0 : (diff > 0) === k.higherIsBetter ? 1 : -1;
    return { key: k.key, label: k.label, unit: k.unit, digits: k.digits, a, b, pct, verdict };
  });
}
