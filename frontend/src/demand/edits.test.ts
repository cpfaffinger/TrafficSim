import { describe, expect, it } from 'vitest';
import { generatedDemand } from '../test/demandFixtures';
import { FALLBACK_BUILTINS } from './builtins';
import {
  addOd,
  curveUsage,
  freeCurveName,
  newOdEntry,
  normalizeMix,
  removeOd,
  renameCurve,
  resetProfiles,
  setCurve,
  setEntry,
  setMix,
  setProfile,
  setShare,
  setStartTime,
  updateOd,
} from './edits';
import { parseDemand, serializeDemand } from './model';

const base = () => parseDemand(generatedDemand('morning'));

describe('demand edits', () => {
  it('set the start time without touching the input', () => {
    const m = base();
    const next = setStartTime(m, 3600);
    expect(next.startTimeOfDay).toBe(3600);
    expect(m.startTimeOfDay).toBe(23400);
  });

  it('edit, add and remove OD entries', () => {
    const m = base();
    const edited = updateOd(m, 0, { vph: 9, curve: undefined, driverMix: undefined });
    expect(edited.od[0]).toEqual({ from: 'z-1_-1', to: 'ext', vph: 9 });
    expect(edited.od[1]).toBe(m.od[1]);
    const added = addOd(m, newOdEntry(m));
    expect(added.od.at(-1)).toEqual({ from: 'z-1_-1', to: 'z-1_0', vph: 0, curve: 'flat' });
    expect(newOdEntry(m, 'ext').from).toBe('ext');
    expect(newOdEntry(parseDemand({ zones: [{ id: 'solo' }] }))).toMatchObject({ from: 'solo', to: 'solo' });
    expect(newOdEntry(parseDemand(null))).toMatchObject({ from: '', to: '' });
    const removed = removeOd(m, 0);
    expect(removed.od).toHaveLength(12);
    expect(removed.od[0]).toBe(m.od[1]);
  });

  it('set and clear entry overrides', () => {
    const m = setEntry(base(), 'n1', { vph: 100, curve: 'flat' });
    expect(m.entries.n1).toEqual({ vph: 100, curve: 'flat' });
    expect(setEntry(m, 'n1', { vph: 5, curve: '' }).entries.n1).toEqual({ vph: 5 });
    expect(serializeDemand(setEntry(m, 'n1', null))).not.toHaveProperty('entries');
  });

  it('patch road-class profiles relative to the built-in defaults', () => {
    const builtin = FALLBACK_BUILTINS.roadClassProfiles.primary!;
    let m = setProfile(base(), 'primary', { volumePerLane: 500 }, builtin);
    expect(m.profiles.primary).toEqual({ volumePerLane: 500 });
    m = setProfile(m, 'primary', { curve: 'flat' }, builtin);
    expect(m.profiles.primary).toEqual({ volumePerLane: 500, curve: 'flat' });
    m = setProfile(m, 'primary', { volumePerLane: 600, curve: 'weekday' }, builtin);
    expect(m.profiles).not.toHaveProperty('primary');
    m = setProfile(m, 'trunk', { volumePerLane: 1 }, FALLBACK_BUILTINS.roadClassProfiles.trunk!);
    expect(resetProfiles(m).profiles).toEqual({});
  });

  it('manage custom curves and rename every reference', () => {
    let m = parseDemand({
      od: [{ from: 'a', to: 'b', vph: 1, curve: 'mine' }],
      entries: { n1: { vph: 1, curve: 'mine' } },
      profiles: { motorway: { curve: 'mine' } },
      demandCurve: 'mine',
      residential: { outboundCurve: 'mine', inboundCurve: 'flat' },
      curves: { mine: { interval: 3600, factors: [1] }, custom1: { interval: 60, factors: [1] } },
    });
    expect(freeCurveName(m)).toBe('custom2');
    expect(curveUsage(m, 'mine')).toBe(5);
    expect(curveUsage(m, 'flat')).toBe(1);
    expect(renameCurve(m, 'mine', 'mine')).toBe(m);
    expect(renameCurve(m, 'flat', 'x')).toBe(m);
    m = renameCurve(m, 'mine', 'ours');
    expect(Object.keys(m.curves)).toEqual(['ours', 'custom1']);
    expect(curveUsage(m, 'ours')).toBe(5);
    expect(m.rest.residential).toEqual({ outboundCurve: 'ours', inboundCurve: 'flat' });
    m = setCurve(m, 'ours', null);
    expect(m.curves).not.toHaveProperty('ours');
    expect(setCurve(m, 'x', { interval: 1, factors: [2] }).curves.x).toEqual({ interval: 1, factors: [2] });
    expect(curveUsage(parseDemand(null), 'flat')).toBe(0);
    expect(renameCurve(parseDemand({ curves: { a: { interval: 1, factors: [1] } } }), 'a', 'b').rest).toEqual({});
  });

  it('edit and normalise mixes', () => {
    const m = setMix(base(), 'vehicleMix', setShare(null, 'car', 2));
    expect(m.vehicleMix).toEqual({ car: 2 });
    expect(setMix(m, 'driverMix', null).driverMix).toBeNull();
    expect(normalizeMix({ car: 3, van: 1, bad: -1 })).toEqual({ car: 0.75, van: 0.25, bad: 0 });
    expect(normalizeMix({ car: 0 })).toEqual({});
    expect(normalizeMix(undefined)).toEqual({});
  });
});
