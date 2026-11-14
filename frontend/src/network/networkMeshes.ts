import { createBuildContext } from './buildContext';
import { buildMarkings } from './markings';
import { MeshData, PickRegistry } from './meshData';
import { buildRoadSurfaces } from './roadSurface';
import { buildStructures } from './structures';
import type { NetworkPackage } from './types';

/** All renderable geometry of one network package, merged per material (one draw call each). */
export interface NetworkMeshes {
  registry: PickRegistry;
  surface: MeshData;
  tunnelSurface: MeshData;
  markings: MeshData;
  tunnelMarkings: MeshData;
  structures: MeshData;
  /** Horizontal extent in package ENU: [minEast, minNorth, maxEast, maxNorth]. */
  extent: [number, number, number, number];
}

export function buildNetworkMeshes(pkg: NetworkPackage): NetworkMeshes {
  const ctx = createBuildContext(pkg);
  const out: NetworkMeshes = {
    registry: ctx.registry,
    surface: new MeshData(),
    tunnelSurface: new MeshData(),
    markings: new MeshData(),
    tunnelMarkings: new MeshData(),
    structures: new MeshData(),
    extent: networkExtent(pkg),
  };
  buildRoadSurfaces(ctx, out);
  buildMarkings(ctx, out);
  buildStructures(ctx, out.structures);
  return out;
}

export function networkExtent(pkg: NetworkPackage): [number, number, number, number] {
  let ext: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => {
    ext = [Math.min(ext[0], x), Math.min(ext[1], y), Math.max(ext[2], x), Math.max(ext[3], y)];
  };
  for (const n of pkg.nodes) add(n.x, n.y);
  for (const l of pkg.links) for (const p of l.geometry) add(p[0], p[1]);
  return Number.isFinite(ext[0]) ? ext : [-100, -100, 100, 100];
}
