/**
 * Demand processes as the sim core derives them from a network package and a configuration
 * (sim-core/src/sim/demand.rs): boundary entries with their road-class defaults and residential
 * trip generation volumes.
 */
import type { NetworkPackage } from '../network/types';
import { profileOf, type Builtins, type RoadClassProfile } from './builtins';
import { isObject, type DemandModel } from './model';

export interface EntryLink {
  id: string;
  roadClass: string;
  lanes: number;
}

export interface BoundaryEntry {
  node: string;
  links: EntryLink[];
  /** Road-class default: Σ volumePerLane × lanes, curve of the busiest link. */
  defaultVph: number;
  defaultCurve: string | null;
  /** Effective rate and curve after overrides (`entries` > legacy `demand` > `defaultDemand` > default). */
  vph: number;
  curve: string | null;
  source: 'entry' | 'legacy' | 'uniform' | 'profile' | 'off';
}

/** Road-class profile after the scenario's `profiles` patches. */
export function effectiveProfile(m: DemandModel, builtins: Builtins, roadClass: string): RoadClassProfile {
  const base = profileOf(builtins, roadClass);
  const key = builtins.roadClassProfiles[roadClass] ? roadClass : 'unknown';
  const patch = m.profiles[key] ?? {};
  return { volumePerLane: patch.volumePerLane ?? base.volumePerLane, curve: patch.curve ?? base.curve };
}

/** `autoEntries` defaults to true without OD entries and false with them. */
export const autoEntries = (m: DemandModel): boolean => (typeof m.rest.autoEntries === 'boolean' ? m.rest.autoEntries : m.od.length === 0);

/** Boundary nodes with outgoing links (sim-core entry sources), in package order. */
export function boundaryEntries(pkg: NetworkPackage, m: DemandModel, builtins: Builtins): BoundaryEntry[] {
  const boundary = new Set(pkg.nodes.filter((n) => n.control === 'boundary').map((n) => n.id));
  const byNode = new Map<string, EntryLink[]>();
  for (const l of pkg.links) {
    if (!boundary.has(l.from)) continue;
    const list = byNode.get(l.from) ?? [];
    list.push({ id: l.id, roadClass: l.roadClass, lanes: l.lanes.length });
    byNode.set(l.from, list);
  }
  const legacy = isObject(m.rest.demand) ? m.rest.demand : {};
  const uniform = typeof m.rest.defaultDemand === 'number' && m.od.length === 0 ? m.rest.defaultDemand : null;
  const forced = typeof m.rest.demandCurve === 'string' ? m.rest.demandCurve : null;
  const auto = autoEntries(m);
  return pkg.nodes
    .filter((n) => byNode.has(n.id))
    .map((n) => {
      const links = byNode.get(n.id)!;
      let defaultVph = 0;
      let best = -1;
      let defaultCurve: string | null = null;
      for (const l of links) {
        const p = effectiveProfile(m, builtins, l.roadClass);
        const v = p.volumePerLane * l.lanes;
        defaultVph += v;
        if (v > best) {
          best = v;
          defaultCurve = p.curve;
        }
      }
      const entry = m.entries[n.id];
      const legacyRate = legacy[n.id];
      let vph: number;
      let curve: string | null = null;
      let source: BoundaryEntry['source'];
      if (entry) {
        vph = entry.vph;
        curve = entry.curve ?? null;
        source = 'entry';
      } else if (typeof legacyRate === 'number') {
        vph = legacyRate;
        source = 'legacy';
      } else if (uniform !== null) {
        vph = uniform;
        source = 'uniform';
      } else if (auto) {
        vph = defaultVph;
        curve = defaultCurve;
        source = 'profile';
      } else {
        vph = 0;
        source = 'off';
      }
      return { node: n.id, links, defaultVph, defaultCurve, vph, curve: forced ?? curve, source };
    });
}

export const DEFAULT_RESIDENTIAL_CLASSES = ['residential', 'living_street', 'service'];

export interface ResidentialDemand {
  km: number;
  outboundPerKm: number;
  inboundPerKm: number;
  outboundCurve: string;
  inboundCurve: string;
}

/** Residential trip generation (`autoZones`), or null when off. */
export function residentialDemand(pkg: NetworkPackage, m: DemandModel): ResidentialDemand | null {
  if (m.rest.autoZones !== true) return null;
  const r = isObject(m.rest.residential) ? m.rest.residential : {};
  const classes = Array.isArray(r.classes) ? r.classes.map(String) : DEFAULT_RESIDENTIAL_CLASSES;
  const metres = pkg.links.filter((l) => classes.includes(l.roadClass)).reduce((a, l) => a + l.length, 0);
  const n = (v: unknown, d: number) => (typeof v === 'number' ? v : d);
  const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
  return {
    km: metres / 1000,
    outboundPerKm: n(r.outboundPerKm, 40),
    inboundPerKm: n(r.inboundPerKm, 40),
    outboundCurve: s(r.outboundCurve, 'commuterOut'),
    inboundCurve: s(r.inboundCurve, 'commuterIn'),
  };
}
