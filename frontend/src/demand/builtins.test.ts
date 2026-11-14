import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FALLBACK_BUILTINS, parseBuiltins, PROFILE_CLASSES, profileOf } from './builtins';

const repo = (p: string) => path.resolve(process.cwd(), '..', p);
const wasmDir = path.resolve(process.cwd(), 'src/generated/sim-core');

/** `| a, b | 600 |` cells of the road-class table in sim-core/README.md → {class: volume}. */
function readmeVolumes(): Record<string, number> {
  const readme = readFileSync(repo('sim-core/README.md'), 'utf8');
  const table = readme.slice(readme.indexOf('| Class | veh/h/lane |'), readme.indexOf('`demandJson()`'));
  const out: Record<string, number> = {};
  for (const m of table.matchAll(/\|\s*([a-z_, ]+?)\s*\|\s*(\d+)\s*(?=\|)/g)) {
    for (const cls of m[1]!.split(',')) out[cls.trim()] = Number(m[2]);
  }
  return out;
}

describe('built-in catalogues', () => {
  it('fallback road-class profiles match the sim-core README table', () => {
    const volumes = readmeVolumes();
    expect(Object.keys(volumes).sort()).toEqual([...PROFILE_CLASSES].sort());
    for (const cls of PROFILE_CLASSES) expect(FALLBACK_BUILTINS.roadClassProfiles[cls], cls).toEqual({ volumePerLane: volumes[cls], curve: 'weekday' });
  });

  it('fallback vehicle types and driver profiles are the README built-ins', () => {
    const readme = readFileSync(repo('sim-core/README.md'), 'utf8');
    for (const t of FALLBACK_BUILTINS.vehicleTypes) expect(readme).toContain(`| \`${t}\``);
    for (const d of FALLBACK_BUILTINS.driverProfiles) expect(readme).toMatch(new RegExp(`Built-ins:[^]*\`${d}\``));
  });

  it.skipIf(!existsSync(path.join(wasmDir, 'trafficsim_sim_core_bg.wasm')))('fallback equals the WASM free functions', async () => {
    const wasm = await import('../generated/sim-core/trafficsim_sim_core.js');
    await wasm.default({ module_or_path: readFileSync(path.join(wasmDir, 'trafficsim_sim_core_bg.wasm')) });
    const live = parseBuiltins(wasm.builtinVehicleTypesJson(), wasm.builtinDriverProfilesJson(), wasm.builtinRoadClassProfilesJson());
    expect(live).toEqual(FALLBACK_BUILTINS);
  });

  it('parses the WASM JSON, keeping a stable order and appending new names', () => {
    const b = parseBuiltins(
      JSON.stringify({ van: {}, car: {}, hovercraft: {} }),
      JSON.stringify({ commuter: {}, average: {} }),
      JSON.stringify({ unknown: { volumePerLane: 150, curve: 'weekday' }, motorway: { volumePerLane: 1400, curve: 'flat' } }),
    );
    expect(b.vehicleTypes).toEqual(['car', 'van', 'hovercraft']);
    expect(b.driverProfiles).toEqual(['average', 'commuter']);
    expect(Object.keys(b.roadClassProfiles)).toEqual(['motorway', 'unknown']);
    expect(parseBuiltins('null', '[]', '{}').vehicleTypes).toEqual([]);
  });

  it('resolves unknown road classes like the sim core', () => {
    expect(profileOf(FALLBACK_BUILTINS, 'motorway').volumePerLane).toBe(1400);
    expect(profileOf(FALLBACK_BUILTINS, 'track').volumePerLane).toBe(150);
    expect(profileOf({ ...FALLBACK_BUILTINS, roadClassProfiles: {} }, 'x')).toEqual({ volumePerLane: 150, curve: 'weekday' });
  });
});
