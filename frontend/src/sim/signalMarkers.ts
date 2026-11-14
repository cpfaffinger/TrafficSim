import type { NetworkPackage, Vec3 } from '../network/types';

/** A signal head position at a stop line, tied to the index of its signal group. */
export interface SignalMarker {
  position: Vec3;
  groupIndex: number;
}

/**
 * One marker per signalised incoming lane (at the lane's end, lifted to head height), linked to the
 * signal group order reported by the sim core.
 */
export function signalMarkers(pkg: NetworkPackage, groupIds: readonly string[], height = 4): SignalMarker[] {
  const groupIndex = new Map(groupIds.map((id, i) => [id, i]));
  const seen = new Set<string>();
  const markers: SignalMarker[] = [];
  for (const c of pkg.connectors) {
    if (c.priority !== 'signal' || !c.signalGroup) continue;
    const index = groupIndex.get(c.signalGroup);
    const key = `${c.fromLink}:${c.fromLane}`;
    if (index === undefined || seen.has(key)) continue;
    seen.add(key);
    const start = c.geometry[0];
    if (!start) continue;
    markers.push({ position: [start[0], start[1], start[2] + height], groupIndex: index });
  }
  return markers;
}

/** RGB of a signal aspect (0 red, 1 amber, 2 green). */
export function aspectColor(aspect: number): [number, number, number] {
  return aspect === 2 ? [0.15, 0.85, 0.3] : aspect === 1 ? [1, 0.75, 0.1] : [0.95, 0.15, 0.12];
}
