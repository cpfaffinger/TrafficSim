/** Attribution texts (#38) that must stay visible: network package, backend providers and basemap. */

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Merges attribution lists in order, dropping blanks and case-insensitive duplicates. */
export function mergeAttributions(...lists: readonly (readonly string[] | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const text = normalise(raw);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out.length ? out : [OSM_ATTRIBUTION];
}
