import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseNetworkPackage } from '../network/parse';
import { aspectColor, signalMarkers } from './signalMarkers';

const fixture = parseNetworkPackage(
  JSON.parse(readFileSync(path.resolve(process.cwd(), '../docs/architecture/fixtures/network-package-v1.json'), 'utf8')),
);

describe('signal markers', () => {
  it('places one head per signalised incoming lane', () => {
    const markers = signalMarkers(fixture, ['n0:g0', 'n0:g1']);
    // l1 and l3 have 2 lanes, l5 and l7 one lane each
    expect(markers).toHaveLength(6);
    expect(new Set(markers.map((m) => m.groupIndex))).toEqual(new Set([0, 1]));
    expect(markers[0]!.position[2]).toBeCloseTo(4);
    expect(signalMarkers(fixture, [])).toHaveLength(0);
  });

  it('maps aspects to colours', () => {
    expect(aspectColor(2)[1]).toBeGreaterThan(0.8);
    expect(aspectColor(1)[0]).toBe(1);
    expect(aspectColor(0)[0]).toBeGreaterThan(0.9);
  });
});
