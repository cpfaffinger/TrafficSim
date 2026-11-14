import { describe, expect, it } from 'vitest';
import { loadGoldenFixture } from '../test/goldenFixture';
import { connector, node, packageOf, straightLink } from '../test/networkFactory';
import { createBuildContext } from './buildContext';
import { MeshData } from './meshData';
import { buildNetworkMeshes, networkExtent } from './networkMeshes';
import { connectorEdges, JUNCTION_PATCH_DROP, junctionPatch } from './roadSurface';

/** Scene-space vertices of all triangles owned by `owner`. */
function ownedVertices(mesh: MeshData, owner: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const t of mesh.trianglesOf(owner)) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]!;
      out.push([mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!]);
    }
  }
  return out;
}

describe('road surfaces (golden fixture)', () => {
  const pkg = loadGoldenFixture();
  const meshes = buildNetworkMeshes(pkg);
  const owner = (t: Parameters<typeof meshes.registry.indexOf>[0]) => meshes.registry.indexOf(t)!;

  it('draws every lane as a ribbon of its own width (lane-accurate)', () => {
    // l1 lane 0: centreline y = -4.875 (north), width 3.25 → scene z = −north spans 3.25..6.5.
    const verts = ownedVertices(meshes.surface, owner({ kind: 'lane', linkId: 'l1', laneIndex: 0 }));
    expect(verts.length).toBe(6);
    const zs = verts.map((v) => v[2]);
    expect(Math.min(...zs)).toBeCloseTo(3.25);
    expect(Math.max(...zs)).toBeCloseTo(6.5);
    const xs = verts.map((v) => v[0]);
    expect(Math.min(...xs)).toBe(-150);
    expect(Math.max(...xs)).toBe(-10);
  });

  it('registers a pick target for every lane, connector and the junction', () => {
    const lanes = pkg.links.reduce((s, l) => s + l.lanes.length, 0);
    const kinds = meshes.registry.targets.map((t) => t.kind);
    expect(kinds.filter((k) => k === 'lane')).toHaveLength(lanes);
    expect(kinds.filter((k) => k === 'connector')).toHaveLength(pkg.connectors.length);
    expect(meshes.registry.indexOf({ kind: 'node', nodeId: 'n0' })).toBeDefined();
    for (const c of pkg.connectors) {
      expect(meshes.surface.trianglesOf(owner({ kind: 'connector', connectorId: c.id })).length).toBeGreaterThan(0);
    }
  });

  it('places the bridge surface at its schematic elevation', () => {
    const ys = ownedVertices(meshes.surface, owner({ kind: 'lane', linkId: 'l9', laneIndex: 1 })).map((v) => v[1]);
    expect(new Set(ys)).toEqual(new Set([6]));
  });

  it('keeps tunnel layers empty when there are no tunnels', () => {
    expect(meshes.tunnelSurface.triangleCount).toBe(0);
    expect(meshes.tunnelMarkings.triangleCount).toBe(0);
  });

  it('covers the junction with a patch slightly below the connectors', () => {
    const ctx = createBuildContext(pkg);
    const patch = junctionPatch(ctx, pkg.connectors)!;
    expect(patch.length).toBeGreaterThanOrEqual(4);
    expect(patch.every((p) => Math.abs(p[2] + JUNCTION_PATCH_DROP) < 1e-9)).toBe(true);
    const xs = patch.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThanOrEqual(-10);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(10);
  });

  it('computes the horizontal extent', () => {
    expect(meshes.extent).toEqual([-150, -150, 150, 150]);
    expect(networkExtent(packageOf([], []))).toEqual([-100, -100, 100, 100]);
  });
});

describe('connector ribbons', () => {
  it('taper from the incoming to the outgoing lane width', () => {
    const a = straightLink('a', 'n1', 'n2', [0, 0], [10, 0], { width: 3 });
    const b = straightLink('b', 'n2', 'n3', [20, 0], [30, 0], { width: 4 });
    const pkg = packageOf([node('n1', 0, 0), node('n2', 15, 0), node('n3', 30, 0)], [a, b], [connector('c', 'n2', a, b)]);
    const { left, right } = connectorEdges(createBuildContext(pkg), pkg.connectors[0]!);
    expect(left[0]![1] - right[0]![1]).toBeCloseTo(3);
    expect(left[1]![1] - right[1]![1]).toBeCloseTo(4);
  });

  it('puts movements between tunnel links into the tunnel layer', () => {
    const a = straightLink('a', 'n1', 'n2', [0, 0], [10, 0], { structure: 'tunnel', z: -8 });
    const b = straightLink('b', 'n2', 'n3', [20, 0], [30, 0], { structure: 'tunnel', z: -8 });
    const pkg = packageOf([node('n1', 0, 0), node('n2', 15, 0), node('n3', 30, 0)], [a, b], [connector('c', 'n2', a, b)]);
    const meshes = buildNetworkMeshes(pkg);
    expect(meshes.surface.triangleCount).toBe(0);
    expect(meshes.tunnelSurface.triangleCount).toBeGreaterThan(0);
  });
});
