import { describe, expect, it } from 'vitest';
import { loadGoldenFixture } from '../test/goldenFixture';
import { node, packageOf, straightLink } from '../test/networkFactory';
import { createBuildContext } from './buildContext';
import { MeshData } from './meshData';
import { buildStructures, DECK_THICKNESS, ObstacleGrid, PARAPET_HEIGHT, pierPlacements, portalFrame, PORTAL_HEIGHT } from './structures';
import type { NetworkPackage } from './types';

function structuresOf(pkg: NetworkPackage) {
  const ctx = createBuildContext(pkg);
  const mesh = new MeshData();
  buildStructures(ctx, mesh);
  return { mesh, registry: ctx.registry };
}

const heights = (m: MeshData, tris: number[]) =>
  tris.flatMap((t) => [0, 1, 2].map((k) => m.positions[m.indices[t * 3 + k]! * 3 + 1]!));

describe('bridges', () => {
  const pkg = loadGoldenFixture();
  const { mesh, registry } = structuresOf(pkg);

  it('draws decks with parapets for the motorway bridges only', () => {
    const l9 = registry.indexOf({ kind: 'link', linkId: 'l9' })!;
    const ys = heights(mesh, mesh.trianglesOf(l9));
    expect(Math.min(...ys)).toBe(0); // piers reach the ground
    expect(Math.max(...ys)).toBeCloseTo(6 + PARAPET_HEIGHT);
    expect(ys).toContain(6 - DECK_THICKNESS);
    expect(registry.indexOf({ kind: 'link', linkId: 'l1' })).toBeUndefined();
  });

  it('keeps piers off the side street below', () => {
    const ctx = createBuildContext(pkg);
    const grid = new ObstacleGrid();
    for (const l of pkg.links.filter((x) => x.layer === 0)) {
      for (const lane of l.lanes) grid.add(lane.geometry[0]!, lane.geometry[1]!, lane.width / 2);
    }
    const piers = pierPlacements(ctx.links.get('l9')!, grid);
    expect(piers.length).toBeGreaterThan(5);
    for (const p of piers) {
      const x = (p.a[0] + p.b[0]) / 2;
      expect(Math.abs(x)).toBeGreaterThan(3.25 + 1);
      expect(p.top).toBeCloseTo(6 - DECK_THICKNESS);
    }
    // A street right under a pier position (x = 15) removes that pier.
    grid.add([15, -100, 0], [15, 100, 0], 3);
    expect(pierPlacements(ctx.links.get('l9')!, grid).length).toBe(piers.length - 1);
  });

  it('skips piers where the deck is too low', () => {
    const low = straightLink('a', 'n1', 'n2', [0, 0], [100, 0], { z: 2, structure: 'bridge' });
    expect(pierPlacements(low, new ObstacleGrid())).toEqual([]);
  });

  it('builds embankment walls for elevated non-bridge links', () => {
    const ramp = straightLink('a', 'n1', 'n2', [0, 0], [100, 0], { z: 3 });
    const { mesh: m } = structuresOf(packageOf([node('n1', 0, 0), node('n2', 100, 0)], [ramp]));
    expect(m.triangleCount).toBe(4); // two walls (one-way link) of one segment each
    expect(Math.min(...m.positions.filter((_, i) => i % 3 === 1))).toBe(0);
  });
});

describe('obstacle grid', () => {
  it('finds carriageways across cell borders', () => {
    const grid = new ObstacleGrid(10);
    grid.add([-50, 0, 0], [50, 0, 0], 2);
    expect(grid.blocked([25, 1], 0.5)).toBe(true);
    expect(grid.blocked([25, 4], 0.5)).toBe(false);
    expect(grid.blocked([200, 0], 0.5)).toBe(false);
  });
});

describe('tunnels', () => {
  const nodes = [node('n1', 0, 0), node('n2', 100, 0), node('n3', 200, 0)];
  const open = straightLink('a', 'n1', 'n2', [0, 0], [100, 0]);
  const tunnel = straightLink('t', 'n2', 'n3', [100, 0], [200, 0], { structure: 'tunnel', layer: -1, lanes: 2 });

  it('builds a portal where the tunnel meets an open road', () => {
    const { mesh, registry } = structuresOf(packageOf(nodes, [open, tunnel]));
    const t = registry.indexOf({ kind: 'link', linkId: 't' })!;
    const tris = mesh.trianglesOf(t);
    expect(tris).toHaveLength(3 * 10); // two posts + lintel, 10 triangles each
    expect(Math.max(...heights(mesh, tris))).toBeCloseTo(PORTAL_HEIGHT);
  });

  it('frames the carriageway with posts outside the lanes', () => {
    const { posts, dir } = portalFrame(tunnel, false);
    expect(dir).toEqual([1, 0]);
    const ys = posts.map((p) => p[1]).sort((x, y) => x - y);
    expect(ys[0]).toBeLessThan(-3);
    expect(ys[1]).toBeGreaterThan(3);
    expect(portalFrame(tunnel, true).posts[0][0]).toBe(200);
  });
});
