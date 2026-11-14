import * as THREE from 'three';
import { buildTerrainMesh, terrainRange } from '../network/terrain';
import type { TerrainGrid } from '../network/types';
import { disposeGroup, toBufferGeometry } from './geometry';

const TERRAIN_COLOR = 0xd8d3c4;

/** Metres the terrain mesh sits below the terrain heights, so roads and the draped basemap stay on top. */
const TERRAIN_OFFSET = 1;

/**
 * Shaded height-field mesh of the package terrain (#87, ADR-0018), toggleable. One indexed mesh of at
 * most ~66 k vertices; rebuilt per package.
 */
export class TerrainLayer {
  readonly group = new THREE.Group();
  private range: [number, number] | null = null;

  /** Shows the terrain of a package (null removes it). */
  load(terrain: TerrainGrid | undefined | null): void {
    this.clear();
    if (!terrain) return;
    const material = new THREE.MeshLambertMaterial({ color: TERRAIN_COLOR, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
    const mesh = new THREE.Mesh(toBufferGeometry(buildTerrainMesh(terrain, TERRAIN_OFFSET)), material);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -1;
    this.group.add(mesh);
    this.range = terrainRange(terrain);
  }

  /** Lowest terrain height in metres (scene y), or null without terrain. */
  get minHeight(): number | null {
    return this.range ? this.range[0] - TERRAIN_OFFSET : null;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  clear(): void {
    disposeGroup(this.group);
    this.range = null;
  }
}
