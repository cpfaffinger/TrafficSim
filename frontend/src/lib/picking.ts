/**
 * Pick selection across stacked levels (#37, #96): the nearest hit wins, and clicking the same spot
 * again cycles to the next object below (e.g. from a bridge deck to the street underneath).
 */

export interface PreviousPick {
  x: number;
  y: number;
  owner: number;
}

/** Owners of raycast hits, nearest first, without duplicates and non-pickable (-1) entries. */
export function uniqueOwners(hits: readonly { owner: number; distance: number }[]): number[] {
  const out: number[] = [];
  for (const h of [...hits].sort((a, b) => a.distance - b.distance)) {
    if (h.owner >= 0 && !out.includes(h.owner)) out.push(h.owner);
  }
  return out;
}

export function nextPick(owners: readonly number[], click: { x: number; y: number }, previous: PreviousPick | null, tolerance = 4): number | null {
  if (owners.length === 0) return null;
  if (previous && Math.hypot(click.x - previous.x, click.y - previous.y) <= tolerance) {
    const i = owners.indexOf(previous.owner);
    if (i >= 0) return owners[(i + 1) % owners.length]!;
  }
  return owners[0]!;
}
