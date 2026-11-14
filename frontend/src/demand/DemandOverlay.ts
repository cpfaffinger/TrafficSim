import * as THREE from 'three';
import { toScene } from '../network/geo';
import type { NetworkScene } from '../scene/NetworkScene';
import { disposeGroup } from '../scene/geometry';
import type { DemandHighlight } from './DemandEditor';
import type { Point, ZoneShape } from './zones';

type OverlayHost = Pick<NetworkScene, 'addOverlay' | 'removeOverlay' | 'invalidate'>;

const COLORS = { zone: 0x8b8d98, selected: 0x3e63dd, from: 0xff8a00, to: 0x12a594, node: 0xe5484d };
const HEIGHT = 1.5;

const v3 = ([x, y]: Point, h = HEIGHT) => new THREE.Vector3(...toScene([x, y, h]));

function line(points: readonly Point[], color: number, opacity: number, closed = false): THREE.Line {
  const pts = (closed && points.length > 2 ? [...points, points[0]!] : points).map((p) => v3(p));
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
  l.renderOrder = 22;
  return l;
}

function dots(points: readonly Point[], color: number, size: number): THREE.Points {
  const p = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(points.map((x) => v3(x, HEIGHT + 0.5))),
    new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, depthTest: false }),
  );
  p.renderOrder = 23;
  return p;
}

function fill(hull: readonly Point[], color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.ShapeGeometry(new THREE.Shape(hull.map(([x, y]) => new THREE.Vector2(x, y)))),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, depthTest: false, side: THREE.DoubleSide }),
  );
  // The shape is built in the ENU x/y plane; lay it on the ground (x = east, z = -north).
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = HEIGHT - 0.5;
  mesh.renderOrder = 21;
  return mesh;
}

/** Zone outlines and markers of the demand editor, with the selected zones' links emphasised (imperative glue). */
export class DemandOverlay {
  private readonly group = new THREE.Group();

  constructor(private readonly scene: OverlayHost) {
    this.group.renderOrder = 21;
    scene.addOverlay(this.group);
  }

  show(shapes: readonly ZoneShape[], highlight: DemandHighlight, nodes: ReadonlyMap<string, Point>): void {
    this.clear();
    const roles = new Map<string, number>();
    if (highlight.zone) roles.set(highlight.zone, COLORS.selected);
    if (highlight.from) roles.set(highlight.from, COLORS.from);
    if (highlight.to) roles.set(highlight.to, highlight.to === highlight.from ? COLORS.from : COLORS.to);
    const markers: Point[] = [];
    for (const z of shapes) {
      // Zones of nodes only (e.g. `ext` = all boundary nodes) get markers on their nodes, no outline.
      const area = z.links.length > 0 && z.hull.length > 2;
      const color = roles.get(z.id);
      if (color === undefined) {
        if (area) this.group.add(line(z.hull, COLORS.zone, 0.55, true));
        if (area && z.center) markers.push(z.center);
        continue;
      }
      if (area) this.group.add(line(z.hull, color, 0.95, true), fill(z.hull, color));
      for (const l of z.links) this.group.add(line(l, color, 1));
      if (z.nodes.length) this.group.add(dots(z.nodes, color, 11));
      if (area && z.center) this.group.add(dots([z.center], color, 12));
    }
    if (markers.length) this.group.add(dots(markers, COLORS.zone, 7));
    const picked = highlight.nodes.map((n) => nodes.get(n)).filter((p): p is Point => p !== undefined);
    if (picked.length) this.group.add(dots(picked, COLORS.node, 14));
    this.scene.invalidate();
  }

  /** Children count (tests). */
  get size(): number {
    return this.group.children.length;
  }

  private clear(): void {
    for (const child of this.group.children) {
      if (child instanceof THREE.Points) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    disposeGroup(this.group);
  }

  dispose(): void {
    this.clear();
    this.scene.removeOverlay(this.group);
  }
}
