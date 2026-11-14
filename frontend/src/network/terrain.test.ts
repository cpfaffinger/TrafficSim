import { describe, expect, it } from 'vitest';
import { readGoldenFixtureJson } from '../test/goldenFixture';
import { MeshData } from './meshData';
import { parseNetworkPackage } from './parse';
import { buildTerrainMesh, drapeOnTerrain, terrainHeightAt, terrainRange } from './terrain';
import type { TerrainGrid } from './types';

/** 3×2 samples, 10 m cells from (−10, 0): heights rise 1 m per column and 10 m per row. */
const grid: TerrainGrid = { west: -10, south: 0, cellSize: 10, columns: 3, rows: 2, heights: [0, 1, 2, 10, 11, 12], originElevation: 250 };

describe('terrainHeightAt', () => {
  it('interpolates bilinearly and clamps outside the grid', () => {
    expect(terrainHeightAt(grid, -10, 0)).toBe(0);
    expect(terrainHeightAt(grid, 10, 10)).toBe(12);
    expect(terrainHeightAt(grid, -5, 5)).toBeCloseTo(5.5, 9);
    expect(terrainHeightAt(grid, 5, 2.5)).toBeCloseTo(1.5 + 2.5, 9);
    expect(terrainHeightAt(grid, -100, -100)).toBe(0);
    expect(terrainHeightAt(grid, 100, 100)).toBe(12);
  });

  it('reports the height range', () => {
    expect(terrainRange(grid)).toEqual([0, 12]);
  });
});

describe('buildTerrainMesh', () => {
  it('builds an upward-facing height field below the terrain', () => {
    const mesh = buildTerrainMesh(grid, 1);
    expect(mesh.vertexCount).toBe(6);
    expect(mesh.triangleCount).toBe(4);
    // Scene coordinates: x east, y up, z −north.
    expect(mesh.positions.slice(0, 3)).toEqual([-10, -1, -0]);
    expect(mesh.positions.slice(15, 18)).toEqual([10, 11, -10]);
    const [a, b, c] = mesh.indices.slice(0, 3).map((i) => mesh.positions.slice(i * 3, i * 3 + 3)) as [number[], number[], number[]];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    expect(u[2]! * v[0]! - u[0]! * v[2]!).toBeGreaterThan(0); // normal points up
  });

  it('decimates large grids but keeps the edges', () => {
    const big: TerrainGrid = { west: 0, south: 0, cellSize: 30, columns: 300, rows: 10, heights: new Array<number>(3000).fill(5), originElevation: 0 };
    const mesh = buildTerrainMesh(big, 0, 100);
    const xs = new Set<number>();
    for (let i = 0; i < mesh.positions.length; i += 3) xs.add(mesh.positions[i]!);
    expect(xs.size).toBeLessThanOrEqual(101);
    expect(Math.max(...xs)).toBe(299 * 30);
  });
});

describe('drapeOnTerrain', () => {
  it('lifts vertices by the terrain height under them', () => {
    const mesh = new MeshData();
    mesh.vertex([-5, 5, -0.2]);
    mesh.vertex([10, 10, 3]);
    drapeOnTerrain(mesh, grid);
    expect(mesh.positions[1]).toBeCloseTo(5.5 - 0.2, 9);
    expect(mesh.positions[4]).toBeCloseTo(15, 9);
  });
});

describe('parseNetworkPackage — terrain', () => {
  const withTerrain = (terrain: unknown) => ({ ...(structuredClone(readGoldenFixtureJson()) as Record<string, unknown>), terrain });

  it('is optional', () => {
    expect(parseNetworkPackage(readGoldenFixtureJson()).terrain).toBeUndefined();
    expect(parseNetworkPackage(withTerrain(null)).terrain).toBeUndefined();
  });

  it('reads a grid', () => {
    expect(parseNetworkPackage(withTerrain(grid)).terrain).toEqual(grid);
  });

  it('drops inconsistent grids instead of rejecting the package', () => {
    expect(parseNetworkPackage(withTerrain({ ...grid, heights: [1, 2] })).terrain).toBeUndefined();
    expect(parseNetworkPackage(withTerrain({ ...grid, cellSize: 0 })).terrain).toBeUndefined();
    expect(parseNetworkPackage(withTerrain({ ...grid, west: 'x' })).terrain).toBeUndefined();
    expect(parseNetworkPackage(withTerrain([1, 2])).terrain).toBeUndefined();
  });
});
