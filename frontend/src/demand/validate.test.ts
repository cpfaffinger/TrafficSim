import { describe, expect, it } from 'vitest';
import { fixturePackage, generatedDemand } from '../test/demandFixtures';
import { FALLBACK_BUILTINS } from './builtins';
import { parseDemand } from './model';
import { mixNames, validateDemand } from './validate';

const b = FALLBACK_BUILTINS;
const pkg = fixturePackage();
const paths = (raw: unknown, withPkg = true) => validateDemand(parseDemand(raw), b, withPkg ? pkg : null).map((i) => i.path);

describe('validateDemand', () => {
  it('accepts every generated scenario', () => {
    for (const key of ['morning', 'midday', 'evening', 'saturday', 'night', 'stress', 'event', 'freight']) {
      expect(validateDemand(parseDemand(generatedDemand(key)), b, pkg), key).toEqual([]);
    }
    expect(validateDemand(parseDemand(null), b)).toEqual([]);
  });

  it('rejects bad start times', () => {
    expect(paths({ startTimeOfDay: 86400 })).toEqual(['startTimeOfDay']);
    expect(paths({ startTimeOfDay: 'late' })).toEqual(['startTimeOfDay']);
  });

  it('checks zones and OD entries', () => {
    const issues = validateDemand(
      parseDemand({
        zones: [{ id: 'a' }, { id: 'a' }, { id: '' }],
        od: [
          { from: 'a', to: 'x', vph: -1, curve: 'nope' },
          { from: 'a', to: 'a', vph: 1, vehicleMix: { tank: 1 }, driverMix: { average: 0 } },
          { from: 'a', to: 'a', vph: 1, vehicleMix: { car: -1 } },
        ],
      }),
      b,
    );
    expect(issues.map((i) => i.message)).toEqual([
      'Zone “a” is defined twice.',
      'A zone has no id.',
      'OD entry 1: unknown zone “x”.',
      'OD entry 1: vehicles per hour must be a non-negative number.',
      'OD entry 1: unknown curve “nope”.',
      'OD entry 2: vehicle mix: unknown vehicle type “tank”.',
      'OD entry 2: driver mix: shares must not all be zero.',
      'OD entry 3: vehicle mix: share of “car” must be a non-negative number.',
    ]);
    expect(new Set(issues.map((i) => i.section))).toEqual(new Set(['od']));
  });

  it('checks entries and road-class profiles against the network', () => {
    expect(paths({ entries: { n1: { vph: 1, curve: 'x' }, n6: 5, n0: -1 } })).toEqual(['entries.n1', 'entries.n6', 'entries.n0', 'entries.n0']);
    expect(paths({ entries: { n6: 5 } }, false)).toEqual([]);
    expect(paths({ profiles: { motorway: { volumePerLane: -1 }, track: {}, primary: { curve: 'zz' } } })).toEqual([
      'profiles.motorway',
      'profiles.track',
      'profiles.primary',
    ]);
    expect(paths({ demandCurve: 'zz' })).toEqual(['demandCurve']);
  });

  it('checks custom curves and their use', () => {
    expect(paths({ curves: { ok: { interval: 3600, factors: [1] }, 'two words': { interval: 3600, factors: [1] }, bad: { interval: 0, factors: [1] } } })).toEqual([
      'curves.two words',
      'curves.bad',
    ]);
    expect(paths({ curves: { mine: { interval: 60, factors: [1] } }, od: [], entries: { n1: { vph: 1, curve: 'mine' } } })).toEqual([]);
    expect(paths({ residential: { outboundCurve: 'zz', inboundCurve: 'flat' } })).toEqual(['residential.outboundCurve']);
  });

  it('checks global mixes, including the scenario’s own types and profiles', () => {
    expect(paths({ vehicleMix: { car: 1, minibus: 1 }, vehicleTypes: { minibus: { class: 'bus' } } })).toEqual([]);
    expect(paths({ vehicleMix: { minibus: 1 } })).toEqual(['vehicleMix']);
    expect(paths({ driverMix: { rookie: 1 }, driverProfiles: { rookie: {} } })).toEqual([]);
    expect(paths({ driverMix: { rookie: 1 } })).toEqual(['driverMix']);
    expect(mixNames(parseDemand({ vehicleTypes: { car: {}, minibus: {} } }), b).vehicle).toEqual([...b.vehicleTypes, 'minibus']);
  });
});
