import type { NetworkPackage } from '../network/types';
import type { Builtins } from './builtins';
import { meanFactor, resolveCurve } from './curves';
import type { DemandModel } from './model';
import { boundaryEntries, residentialDemand } from './network';

export type ProcessKind = 'boundary' | 'od' | 'residentialOut' | 'residentialIn';

export interface ProcessTotal {
  kind: ProcessKind;
  /** Number of arrival processes. */
  count: number;
  /** Vehicles per hour at curve factor 1. */
  peakVph: number;
  /** Mean vehicles per hour over the scenario window (start time + duration). */
  meanVph: number;
}

export const PROCESS_LABELS: Record<ProcessKind, string> = {
  boundary: 'Boundary entries',
  od: 'OD matrix',
  residentialOut: 'Residential outbound',
  residentialIn: 'Residential inbound',
};

const safe = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);

/** Generated vehicles per hour by process kind (unscaled; the simulation panel's demand level applies on top). */
export function demandTotals(m: DemandModel, durationSeconds: number, builtins: Builtins, pkg: NetworkPackage | null): ProcessTotal[] {
  const mean = (curve: string | null | undefined) => {
    if (!curve) return 1;
    const c = resolveCurve(curve, m.curves);
    return c ? meanFactor(c, m.startTimeOfDay, durationSeconds) : 0;
  };
  const total = (kind: ProcessKind, items: { vph: number; curve?: string | null }[]): ProcessTotal => ({
    kind,
    count: items.length,
    peakVph: items.reduce((a, i) => a + safe(i.vph), 0),
    meanVph: items.reduce((a, i) => a + safe(i.vph) * mean(i.curve), 0),
  });
  const out: ProcessTotal[] = [];
  if (pkg) out.push(total('boundary', boundaryEntries(pkg, m, builtins).filter((e) => e.source !== 'off')));
  out.push(total('od', m.od));
  const r = pkg ? residentialDemand(pkg, m) : null;
  if (r) {
    out.push(total('residentialOut', [{ vph: r.outboundPerKm * r.km, curve: r.outboundCurve }]));
    out.push(total('residentialIn', [{ vph: r.inboundPerKm * r.km, curve: r.inboundCurve }]));
  }
  return out;
}
