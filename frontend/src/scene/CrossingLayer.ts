import * as THREE from 'three';
import { crossingMarkings, pedestrianViews, PEDESTRIAN_STATES } from '../network/crossings';
import { toScene } from '../network/geo';
import type { Crossing, NetworkPackage } from '../network/types';

const PEDESTRIAN_COLORS: Record<number, number> = {
  [PEDESTRIAN_STATES.waiting]: 0xf28c28,
  [PEDESTRIAN_STATES.walking]: 0x2f6fd6,
  [PEDESTRIAN_STATES.waitingOnCrossing]: 0xf5c400,
};

/**
 * Pedestrian crossings (ADR-0020, #86): instanced marking rectangles (zebra stripes, crosswalk edge
 * lines) per package, and one instanced mesh of simple figures for the pedestrians of a simulation
 * frame. Markings are hidden at far zoom together with the other markings (#80).
 */
export class CrossingLayer {
  /** Road markings (static per package). */
  readonly markings = new THREE.Group();
  /** Pedestrians (per frame). */
  readonly pedestrians = new THREE.Group();
  private crossings: readonly Crossing[] = [];
  private figures: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private readonly figure = new THREE.CylinderGeometry(0.22, 0.28, 1.7, 8).translate(0, 0.85, 0);
  private readonly figureMaterial = new THREE.MeshLambertMaterial();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();

  load(pkg: NetworkPackage): void {
    this.clear();
    this.crossings = pkg.crossings ?? [];
    const rects = this.crossings.flatMap(crossingMarkings);
    if (rects.length === 0) return;
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const material = new THREE.MeshLambertMaterial({ color: 0xf4f4f0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mesh = new THREE.InstancedMesh(plane, material, rects.length);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    rects.forEach((r, i) => {
      position.set(...toScene([r.centre[0], r.centre[1], r.centre[2] + 0.03]));
      this.quaternion.setFromAxisAngle(this.up, r.angle);
      scale.set(r.length, 1, r.width);
      this.matrix.compose(position, this.quaternion, scale);
      mesh.setMatrixAt(i, this.matrix);
    });
    mesh.renderOrder = 2;
    this.markings.add(mesh);
  }

  /** Draws the pedestrians of a `pedestrianSnapshot()` (stride 5). */
  updatePedestrians(snapshot: Float32Array): void {
    const views = pedestrianViews(this.crossings, snapshot);
    if (views.length > this.capacity) {
      this.disposeFigures();
      this.capacity = Math.max(64, views.length * 2);
      this.figures = new THREE.InstancedMesh(this.figure, this.figureMaterial, this.capacity);
      this.figures.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.figures.setColorAt(0, this.color.setHex(0xffffff));
      this.figures.frustumCulled = false;
      this.pedestrians.add(this.figures);
    }
    if (!this.figures) return;
    const position = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    views.forEach((v, i) => {
      position.set(...toScene(v.position));
      this.quaternion.setFromAxisAngle(this.up, v.heading);
      this.matrix.compose(position, this.quaternion, one);
      this.figures!.setMatrixAt(i, this.matrix);
      this.figures!.setColorAt(i, this.color.setHex(PEDESTRIAN_COLORS[v.state] ?? 0xffffff));
    });
    this.figures.count = views.length;
    this.figures.instanceMatrix.needsUpdate = true;
    if (this.figures.instanceColor) this.figures.instanceColor.needsUpdate = true;
  }

  clearPedestrians(): void {
    if (this.figures) this.figures.count = 0;
  }

  clear(): void {
    for (const child of [...this.markings.children]) {
      const mesh = child as THREE.InstancedMesh;
      this.markings.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.clearPedestrians();
    this.crossings = [];
  }

  dispose(): void {
    this.clear();
    this.disposeFigures();
    this.figure.dispose();
    this.figureMaterial.dispose();
  }

  private disposeFigures(): void {
    if (this.figures) {
      this.pedestrians.remove(this.figures);
      this.figures.dispose();
      this.figures = null;
      this.capacity = 0;
    }
  }
}
