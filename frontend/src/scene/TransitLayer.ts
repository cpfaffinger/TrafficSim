import * as THREE from 'three';
import { toScene } from '../network/geo';
import type { NetworkPackage } from '../network/types';
import { stopPlacements } from '../transit/model';

const POLE_HEIGHT = 2.6;
/** Plate colours: kerb stops and bus bays (#85). */
const STOP_COLOR = 0x2e9d4f;
const BAY_COLOR = 0x1f6fb2;

/**
 * Bus stop markers (#85): an instanced pole with a square plate per stop, beside the kerb lane (bays
 * further out). Rebuilt per package; hidden at far zoom together with markings and signs (#80).
 */
export class TransitLayer {
  readonly group = new THREE.Group();

  load(pkg: NetworkPackage): void {
    this.clear();
    const stops = stopPlacements(pkg);
    if (stops.length === 0) return;
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);

    const poles = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.06, 0.06, 1, 6).translate(0, 0.5, 0),
      new THREE.MeshLambertMaterial({ color: 0x8a8d91 }),
      stops.length,
    );
    const plates = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.6, 0.06), new THREE.MeshLambertMaterial({ color: 0xffffff }), stops.length);
    const color = new THREE.Color();
    stops.forEach((s, i) => {
      const [x, y, z] = toScene(s.base);
      matrix.compose(new THREE.Vector3(x, y, z), q.identity(), new THREE.Vector3(1, POLE_HEIGHT, 1));
      poles.setMatrixAt(i, matrix);
      // Plate faces oncoming traffic, like traffic signs.
      q.setFromAxisAngle(up, s.heading - Math.PI / 2);
      matrix.compose(new THREE.Vector3(x, y + POLE_HEIGHT, z), q, one);
      plates.setMatrixAt(i, matrix);
      plates.setColorAt(i, color.setHex(s.bay ? BAY_COLOR : STOP_COLOR));
    });
    this.group.add(poles, plates);
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.InstancedMesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
        child.dispose();
      }
    }
  }
}
