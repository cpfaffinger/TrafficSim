import type { NetworkPackage } from '../network/types';
import type { Builtins } from './builtins';
import { curveProblem, resolveCurve } from './curves';
import { isObject, type DemandModel, type Mix } from './model';
import { readTransit, transitIssues } from '../transit/model';

export type DemandSection = 'overview' | 'od' | 'entries' | 'curves' | 'mixes' | 'transit';

export interface DemandIssue {
  section: DemandSection;
  /** Stable key of the offending item (e.g. `od.3`, `entries.n1`, `profiles.motorway`). */
  path: string;
  message: string;
}

const rateOk = (v: number) => Number.isFinite(v) && v >= 0;

/** Names usable in mixes: built-ins plus the scenario's own `vehicleTypes` / `driverProfiles`. */
export function mixNames(m: DemandModel, builtins: Builtins): { vehicle: string[]; driver: string[] } {
  const extra = (key: string) => (isObject(m.rest[key]) ? Object.keys(m.rest[key]) : []);
  const merge = (base: string[], more: string[]) => [...base, ...more.filter((n) => !base.includes(n))];
  return { vehicle: merge(builtins.vehicleTypes, extra('vehicleTypes')), driver: merge(builtins.driverProfiles, extra('driverProfiles')) };
}

function mixIssues(mix: Mix, known: readonly string[], what: string): string | null {
  for (const [name, share] of Object.entries(mix)) {
    if (!known.includes(name)) return `unknown ${what} “${name}”`;
    if (!rateOk(share)) return `share of “${name}” must be a non-negative number`;
  }
  if (!(Object.values(mix).reduce((a, s) => a + s, 0) > 0)) return 'shares must not all be zero';
  return null;
}

/**
 * Checks what the sim core would reject (sim-core/src/config.rs `validate`): non-negative rates,
 * known zones, curves, road classes, entry nodes (with a package) and mix names.
 */
export function validateDemand(m: DemandModel, builtins: Builtins, pkg: NetworkPackage | null = null): DemandIssue[] {
  const issues: DemandIssue[] = [];
  const add = (section: DemandSection, path: string, message: string) => issues.push({ section, path, message });
  const curveKnown = (name: string | undefined) => !name || resolveCurve(name, m.curves) !== null;
  const names = mixNames(m, builtins);

  if (!(Number.isFinite(m.startTimeOfDay) && m.startTimeOfDay >= 0 && m.startTimeOfDay < 86_400)) {
    add('overview', 'startTimeOfDay', 'Start time must be a time of day (00:00–23:59).');
  }

  const zoneIds = new Set<string>();
  for (const z of m.zones) {
    if (!z.id) add('od', 'zones', 'A zone has no id.');
    else if (zoneIds.has(z.id)) add('od', `zones.${z.id}`, `Zone “${z.id}” is defined twice.`);
    zoneIds.add(z.id);
  }
  m.od.forEach((e, i) => {
    const path = `od.${i}`;
    const row = `OD entry ${i + 1}`;
    for (const z of [e.from, e.to]) if (!zoneIds.has(z)) add('od', path, `${row}: unknown zone “${z}”.`);
    if (!rateOk(e.vph)) add('od', path, `${row}: vehicles per hour must be a non-negative number.`);
    if (!curveKnown(e.curve)) add('od', path, `${row}: unknown curve “${e.curve}”.`);
    const vm = e.vehicleMix && mixIssues(e.vehicleMix, names.vehicle, 'vehicle type');
    if (vm) add('od', path, `${row}: vehicle mix: ${vm}.`);
    const dm = e.driverMix && mixIssues(e.driverMix, names.driver, 'driver profile');
    if (dm) add('od', path, `${row}: driver mix: ${dm}.`);
  });

  const entryNodes = pkg ? new Set(pkg.links.map((l) => l.from).filter((n) => pkg.nodes.some((x) => x.id === n && x.control === 'boundary'))) : null;
  for (const [node, e] of Object.entries(m.entries)) {
    const path = `entries.${node}`;
    if (entryNodes && !entryNodes.has(node)) add('entries', path, `Entry “${node}” is not a boundary entry node of this network.`);
    if (!rateOk(e.vph)) add('entries', path, `Entry “${node}”: vehicles per hour must be a non-negative number.`);
    if (!curveKnown(e.curve)) add('entries', path, `Entry “${node}”: unknown curve “${e.curve}”.`);
  }
  for (const [cls, p] of Object.entries(m.profiles)) {
    const path = `profiles.${cls}`;
    if (!builtins.roadClassProfiles[cls]) add('entries', path, `Unknown road class “${cls}”.`);
    if (p.volumePerLane !== undefined && !rateOk(p.volumePerLane)) add('entries', path, `Road class “${cls}”: volume per lane must be a non-negative number.`);
    if (!curveKnown(p.curve)) add('entries', path, `Road class “${cls}”: unknown curve “${p.curve}”.`);
  }
  if (typeof m.rest.demandCurve === 'string' && !curveKnown(m.rest.demandCurve)) {
    add('entries', 'demandCurve', `Unknown boundary curve “${m.rest.demandCurve}”.`);
  }

  for (const [name, c] of Object.entries(m.curves)) {
    if (!/^\S+$/.test(name)) add('curves', `curves.${name}`, `Curve name “${name}” must not be empty or contain spaces.`);
    const problem = curveProblem(c);
    if (problem) add('curves', `curves.${name}`, `Curve “${name}”: ${problem}.`);
  }
  if (isObject(m.rest.residential)) {
    for (const key of ['outboundCurve', 'inboundCurve']) {
      const c = m.rest.residential[key];
      if (typeof c === 'string' && !curveKnown(c)) add('curves', `residential.${key}`, `Residential ${key}: unknown curve “${c}”.`);
    }
  }

  const vm = m.vehicleMix && mixIssues(m.vehicleMix, names.vehicle, 'vehicle type');
  if (vm) add('mixes', 'vehicleMix', `Vehicle mix: ${vm}.`);
  const dm = m.driverMix && mixIssues(m.driverMix, names.driver, 'driver profile');
  if (dm) add('mixes', 'driverMix', `Driver mix: ${dm}.`);
  if (m.rest.transit !== undefined) {
    for (const message of transitIssues(readTransit(m.rest.transit), pkg ? (pkg.transitLines ?? []) : null)) add('transit', 'transit', message);
  }
  return issues;
}
