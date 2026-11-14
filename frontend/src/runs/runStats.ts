/**
 * KPIs of stored runs (sim-core `Summary`, #61) and their spread over seeds (#73): mean ± sample
 * standard deviation per KPI.
 */

export interface RunKpi {
  key: string;
  label: string;
  unit: string;
  digits: number;
  higherIsBetter: boolean;
  get: (summary: SummaryLike) => number | null;
  /** Shown only when a run has it (pedestrian KPIs, ADR-0020). */
  optional?: boolean;
}

export interface SummaryLike {
  network?: Record<string, unknown>;
  events?: Record<string, unknown>;
  links?: unknown[];
  pedestrians?: Record<string, unknown>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ped = (key: string) => (s: SummaryLike) => num(s.pedestrians?.[key]);
const net = (key: string, scale = 1) => (s: SummaryLike) => {
  const v = num(s.network?.[key]);
  return v === null ? null : v * scale;
};

export const RUN_KPIS: readonly RunKpi[] = [
  { key: 'meanSpeed', label: 'Mean speed', unit: 'km/h', digits: 1, higherIsBetter: true, get: net('meanSpeed', 3.6) },
  { key: 'meanTravelTime', label: 'Mean travel time', unit: 's', digits: 0, higherIsBetter: false, get: net('meanTravelTime') },
  { key: 'arrived', label: 'Arrived', unit: 'veh', digits: 0, higherIsBetter: true, get: net('arrived') },
  { key: 'vehicleKm', label: 'Vehicle-km', unit: 'km', digits: 0, higherIsBetter: true, get: net('vehicleKm') },
  { key: 'delayHours', label: 'Delay', unit: 'veh·h', digits: 1, higherIsBetter: false, get: net('delayHours') },
  { key: 'stops', label: 'Stops', unit: '', digits: 0, higherIsBetter: false, get: net('stops') },
  { key: 'tailbacks', label: 'Tailbacks', unit: '', digits: 0, higherIsBetter: false, get: (s) => num(s.events?.tailbacks) },
  { key: 'pedestriansServed', label: 'Pedestrians crossed', unit: 'ped', digits: 0, higherIsBetter: true, get: ped('served'), optional: true },
  { key: 'pedestrianDelay', label: 'Pedestrian delay', unit: 's', digits: 1, higherIsBetter: false, get: ped('meanDelay'), optional: true },
  { key: 'crossingVehicleDelay', label: 'Vehicle delay at crossings', unit: 'veh·h', digits: 2, higherIsBetter: false, get: ped('vehicleDelayHours'), optional: true },
];

/** KPIs to show for these summaries: optional ones only when at least one run has them. */
export function visibleKpis(summaries: readonly unknown[]): RunKpi[] {
  return RUN_KPIS.filter((k) => !k.optional || summaries.some((s) => k.get(asSummary(s)) !== null));
}

export interface Stat {
  n: number;
  mean: number;
  /** Sample standard deviation (0 for a single run). */
  sd: number;
}

export function stat(values: readonly number[]): Stat | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = values.length > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1)) : 0;
  return { n: values.length, mean, sd };
}

export function asSummary(raw: unknown): SummaryLike {
  return typeof raw === 'object' && raw !== null ? (raw as SummaryLike) : {};
}

/** Mean ± sd of every KPI over the given run summaries (runs lacking a KPI are skipped for it). */
export function aggregate(summaries: readonly unknown[], kpis: readonly RunKpi[] = RUN_KPIS): Map<string, Stat | null> {
  const out = new Map<string, Stat | null>();
  for (const kpi of kpis) {
    const values = summaries.map((s) => kpi.get(asSummary(s))).filter((v): v is number => v !== null);
    out.set(kpi.key, stat(values));
  }
  return out;
}

export function formatValue(value: number | null, kpi: RunKpi): string {
  return value === null ? '–' : value.toLocaleString('en-US', { maximumFractionDigits: kpi.digits, minimumFractionDigits: kpi.digits });
}

export function formatStat(s: Stat | null, kpi: RunKpi): string {
  if (!s) return '–';
  return s.n > 1 ? `${formatValue(s.mean, kpi)} ± ${formatValue(s.sd, kpi)}` : formatValue(s.mean, kpi);
}
