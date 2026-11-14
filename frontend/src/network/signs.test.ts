import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNetworkPackage } from './parse';
import { signPlacements } from './signs';

const fixture = parseNetworkPackage(
  JSON.parse(readFileSync(path.resolve(process.cwd(), '../docs/architecture/fixtures/network-package-v1.json'), 'utf8')),
);

describe('sign placements (#103)', () => {
  it('places a signal mast at the right kerb of every signalised approach', () => {
    const signs = signPlacements(fixture);
    expect(signs.map((s) => s.linkId).sort()).toEqual(['l1', 'l3', 'l5', 'l7']);
    const east = signs.find((s) => s.linkId === 'l1')!;
    expect(east.kind).toBe('signal');
    expect(east.heading).toBeCloseTo(0);
    // eastbound: right kerb is south of the rightmost lane (y = -4.875 - 1.625 - 0.8)
    expect(east.base[1]).toBeCloseTo(-7.3, 1);
    expect(east.base[0]).toBeCloseTo(-10, 1);
  });

  it('uses endSign for unsignalised approaches and skips none', () => {
    const links = fixture.links.map((l) => (l.id === 'l9' ? { ...l, endSign: 'give_way' as const } : l.id === 'l10' ? { ...l, endSign: 'none' as const } : l));
    const pkg = { ...fixture, links, connectors: [] };
    expect(signPlacements(pkg)).toEqual([expect.objectContaining({ linkId: 'l9', kind: 'give_way' })]);
  });
});
