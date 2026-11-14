import * as THREE from 'three';
import { buildCellRibbons } from '../metrics/cellRibbons';
import type { LaneRow } from '../metrics/laneCells';
import type { NetworkPackage } from '../network/types';

/**
 * Lane-accurate heatmap ribbons (#59): one merged mesh with a quad per lane cell; only the vertex
 * colours change when the bucket or metric changes.
 */
export class HeatmapLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private colors: THREE.BufferAttribute | null = null;
  private key = '';

  /** Builds the ribbons for a lane table (no-op when the layout did not change). */
  prepare(pkg: NetworkPackage, lanes: readonly LaneRow[], cellCount: number, cellLength: number): void {
    const key = `${pkg.baselineId ?? ''}:${pkg.links.length}:${cellCount}:${cellLength}`;
    if (key === this.key && this.mesh) return;
    this.clear();
    this.key = key;
    const ribbons = buildCellRibbons(pkg, lanes, cellCount, cellLength);
    const geometry = new THREE.BufferGeometry();
    // ENU → scene (x = east, y = up, z = -north)
    const scene = new Float32Array(ribbons.positions.length);
    for (let i = 0; i < ribbons.positions.length; i += 3) {
      scene[i] = ribbons.positions[i]!;
      scene[i + 1] = ribbons.positions[i + 2]!;
      scene[i + 2] = -ribbons.positions[i + 1]!;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(scene, 3));
    this.colors = new THREE.BufferAttribute(new Float32Array(ribbons.positions.length), 3);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', this.colors);
    geometry.setIndex(new THREE.BufferAttribute(ribbons.indices, 1));
    geometry.computeBoundingSphere();
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.88, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    );
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);
  }

  /** Target array for vertex colours (4 vertices × RGB per cell); call `commit` after writing. */
  get colorArray(): Float32Array | null {
    return (this.colors?.array as Float32Array | undefined) ?? null;
  }

  commit(): void {
    if (this.colors) this.colors.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  clear(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    this.mesh = null;
    this.colors = null;
    this.key = '';
  }
}
