import * as THREE from 'three';
import type { DraftPoint } from '../editor/drawRoad';
import { toScene } from '../network/geo';
import type { NetworkScene } from './NetworkScene';
import { disposeGroup } from './geometry';

const COLORS = { line: 0x3e63dd, free: 0x3e63dd, attached: 0xff8a00 };
const HEIGHT = 1.2;

/** Draft geometry of the road drawing tool (#69), drawn over the network scene (imperative glue). */
export class EditorOverlay {
  private readonly group = new THREE.Group();

  constructor(private readonly scene: NetworkScene) {
    this.group.renderOrder = 20;
    scene.addOverlay(this.group);
  }

  setDraft(points: readonly DraftPoint[]): void {
    disposeGroup(this.group);
    if (points.length > 0) {
      const positions = points.map((p) => new THREE.Vector3(...toScene([p.x, p.y, HEIGHT])));
      if (positions.length > 1) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(positions),
          new THREE.LineBasicMaterial({ color: COLORS.line, depthTest: false, transparent: true }),
        );
        line.renderOrder = 20;
        this.group.add(line);
      }
      for (const [kind, color] of [
        ['free', COLORS.free],
        ['attached', COLORS.attached],
      ] as const) {
        const subset = positions.filter((_, i) => (points[i]!.kind === 'free') === (kind === 'free'));
        if (subset.length === 0) continue;
        const dots = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints(subset),
          new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false, depthTest: false, transparent: true }),
        );
        dots.renderOrder = 21;
        this.group.add(dots);
      }
    }
    this.scene.invalidate();
  }

  dispose(): void {
    disposeGroup(this.group);
    this.scene.removeOverlay(this.group);
  }
}
