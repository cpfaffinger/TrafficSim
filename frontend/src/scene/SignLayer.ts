import * as THREE from 'three';
import { toScene } from '../network/geo';
import { signPlacements, type SignKind, type SignPlacement } from '../network/signs';
import type { NetworkPackage } from '../network/types';

const POST_HEIGHT = 2.3;
const MAST_HEIGHT = 4.2;

/** Plate shapes in the plate's local x/y plane (facing +z before rotation). */
function plateGeometry(kind: Exclude<SignKind, 'signal'>): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  if (kind === 'stop') {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      const p = [Math.cos(a) * 0.45, Math.sin(a) * 0.45] as const;
      if (i === 0) shape.moveTo(...p);
      else shape.lineTo(...p);
    }
  } else if (kind === 'give_way') {
    shape.moveTo(-0.5, 0.35);
    shape.lineTo(0.5, 0.35);
    shape.lineTo(0, -0.5);
  } else {
    shape.moveTo(0, 0.45);
    shape.lineTo(0.45, 0);
    shape.lineTo(0, -0.45);
    shape.lineTo(-0.45, 0);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

const PLATE_COLORS: Record<Exclude<SignKind, 'signal'>, number> = { stop: 0xc8102e, give_way: 0xf2f2f2, priority_road: 0xf5c400 };

/**
 * Instanced 3D sign posts and signal masts (#103): one instanced mesh per plate kind plus shared posts.
 * Plates face oncoming traffic. Rebuilt per package; hidden at far zoom together with markings (#80).
 */
export class SignLayer {
  readonly group = new THREE.Group();

  load(pkg: NetworkPackage): void {
    this.clear();
    const placements = signPlacements(pkg);
    if (placements.length === 0) return;
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);

    const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: 0x8a8d91 }), placements.length);
    placements.forEach((p, i) => {
      const height = p.kind === 'signal' ? MAST_HEIGHT : POST_HEIGHT;
      matrix.compose(new THREE.Vector3(...toScene(p.base)), q.identity(), new THREE.Vector3(1, height, 1));
      posts.setMatrixAt(i, matrix);
    });
    this.group.add(posts);

    const byKind = new Map<SignKind, SignPlacement[]>();
    for (const p of placements) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
    for (const [kind, list] of byKind) {
      const geometry = kind === 'signal' ? new THREE.BoxGeometry(0.35, 0.9, 0.3) : plateGeometry(kind);
      const material = new THREE.MeshLambertMaterial({ color: kind === 'signal' ? 0x2b2d30 : PLATE_COLORS[kind], side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      list.forEach((p, i) => {
        const [x, y, z] = toScene(p.base);
        const top = p.kind === 'signal' ? MAST_HEIGHT - 0.2 : POST_HEIGHT;
        // The plate's +z faces oncoming traffic: rotate local +z onto the reverse travel direction.
        q.setFromAxisAngle(up, p.heading - Math.PI / 2);
        matrix.compose(new THREE.Vector3(x, y + top, z), q, one);
        mesh.setMatrixAt(i, matrix);
      });
      this.group.add(mesh);
    }
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
