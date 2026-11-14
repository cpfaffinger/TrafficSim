import * as THREE from 'three';
import type { MeshData } from '../network/meshData';

/** Converts renderer-agnostic mesh data into an indexed BufferGeometry with flat-friendly normals. */
export function toBufferGeometry(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  const index = data.vertexCount > 65_535 ? new Uint32Array(data.indices) : new Uint16Array(data.indices);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/** Geometry made of the given triangles of `data`, lifted by `lift` metres (selection highlight). */
export function subsetGeometry(data: MeshData, triangles: readonly number[], lift = 0.05): THREE.BufferGeometry {
  const positions = new Float32Array(triangles.length * 9);
  let o = 0;
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const v = data.indices[t * 3 + k]!;
      positions[o++] = data.positions[v * 3]!;
      positions[o++] = data.positions[v * 3 + 1]! + lift;
      positions[o++] = data.positions[v * 3 + 2]!;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Removes and disposes every child mesh (geometries and materials) of a group. */
export function disposeGroup(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Line) {
        o.geometry.dispose();
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of materials) m.dispose();
      }
    });
  }
}
