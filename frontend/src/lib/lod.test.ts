import { describe, expect, it } from 'vitest';
import { lodFor, sameLod } from './lod';

describe('level of detail', () => {
  it('shows everything close by', () => {
    expect(lodFor(200)).toEqual({ markings: true, buildings: true, vehicleScale: 1 });
    expect(lodFor(-5).vehicleScale).toBe(1);
  });

  it('hides details and enlarges vehicles far away', () => {
    expect(lodFor(2000)).toMatchObject({ markings: false, buildings: true });
    expect(lodFor(2000).vehicleScale).toBeCloseTo(3.33, 1);
    expect(lodFor(10_000)).toEqual({ markings: false, buildings: false, vehicleScale: 6 });
  });

  it('compares states with tolerance', () => {
    expect(sameLod(lodFor(700), lodFor(710))).toBe(true);
    expect(sameLod(lodFor(700), lodFor(2000))).toBe(false);
  });
});
