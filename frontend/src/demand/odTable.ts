import type { OdEntry } from './model';

export type OdSortKey = 'index' | 'from' | 'to' | 'vph' | 'curve';

export interface OdView {
  /** Case-insensitive substring of from, to or curve. */
  query: string;
  /** Only entries starting or ending in this zone. */
  zone: string | null;
  sort: OdSortKey;
  descending: boolean;
}

export const DEFAULT_OD_VIEW: OdView = { query: '', zone: null, sort: 'index', descending: false };

/** Indices of the OD entries to show, filtered and sorted (stable; ties keep matrix order). */
export function odRows(od: readonly OdEntry[], view: OdView): number[] {
  const q = view.query.trim().toLowerCase();
  const rows = od
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !view.zone || e.from === view.zone || e.to === view.zone)
    .filter(({ e }) => !q || [e.from, e.to, e.curve ?? 'constant'].some((s) => s.toLowerCase().includes(q)));
  const key = (r: { e: OdEntry; i: number }): string | number => {
    switch (view.sort) {
      case 'index':
        return r.i;
      case 'vph':
        return Number.isFinite(r.e.vph) ? r.e.vph : -Infinity;
      case 'curve':
        return r.e.curve ?? '';
      default:
        return r.e[view.sort];
    }
  };
  const dir = view.descending ? -1 : 1;
  rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true });
    return c === 0 ? a.i - b.i : c * dir;
  });
  return rows.map((r) => r.i);
}

/** Clicking a column header: same column toggles the direction, a new one sorts ascending (vph descending). */
export function toggleSort(view: OdView, sort: OdSortKey): OdView {
  if (view.sort === sort) return { ...view, descending: !view.descending };
  return { ...view, sort, descending: sort === 'vph' };
}
