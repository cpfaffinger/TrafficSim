import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNetworkPackage } from '../network/parse';
import { buildCellRibbons } from './cellRibbons';

const fixture = parseNetworkPackage(
  JSON.parse(readFileSync(path.resolve(process.cwd(), '../docs/architecture/fixtures/network-package-v1.json'), 'utf8')),
);

describe('cell ribbons (#59)', () => {
  it('builds one quad per cell along the lane', () => {
    // link 0 (l1), lane 0: geometry from x = -150 to -10 at y = -4.875 (140 m) → 14 cells of 10 m
    const lanes = [{ linkIndex: 0, laneIndex: 0, cellCount: 14, firstCell: 0, length: 140, speedLimit: 13.9 }];
    const r = buildCellRibbons(fixture, lanes, 14, 10);

    expect(r.positions.length).toBe(14 * 4 * 3);
    expect(r.indices.slice(0, 6)).toEqual(new Uint32Array([0, 1, 2, 0, 2, 3]));
    // first cell starts at the lane start, spans 10 m, sits around the lane centre
    expect(r.positions[0]).toBeCloseTo(-150, 3);
    expect(r.positions[2 * 3]).toBeCloseTo(-140, 3);
    expect((r.positions[1]! + r.positions[4]!) / 2).toBeCloseTo(-4.875, 3);
    expect(r.positions[2]).toBeCloseTo(0.06, 3);
  });

  it('skips lanes that do not exist and cells beyond the table', () => {
    const r = buildCellRibbons(fixture, [{ linkIndex: 99, laneIndex: 0, cellCount: 2, firstCell: 0, length: 20, speedLimit: 10 }, { linkIndex: 0, laneIndex: 0, cellCount: 5, firstCell: 1, length: 50, speedLimit: 10 }], 2, 10);
    expect(r.positions.length).toBe(2 * 12);
    expect(r.positions[12]).toBeCloseTo(-150, 3);
  });
});
