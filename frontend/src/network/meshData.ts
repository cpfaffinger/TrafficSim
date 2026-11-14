import { toScene } from './geo';
import type { Vec3 } from './types';

/** Something the user can pick in the 3D view. */
export type PickTarget =
  | { kind: 'lane'; linkId: string; laneIndex: number }
  | { kind: 'link'; linkId: string }
  | { kind: 'connector'; connectorId: string }
  | { kind: 'node'; nodeId: string };

export function pickKey(target: PickTarget): string {
  switch (target.kind) {
    case 'lane':
      return `lane:${target.linkId}:${target.laneIndex}`;
    case 'link':
      return `link:${target.linkId}`;
    case 'connector':
      return `connector:${target.connectorId}`;
    case 'node':
      return `node:${target.nodeId}`;
  }
}

/** Deduplicating registry of pick targets shared by all meshes of one network. */
export class PickRegistry {
  readonly targets: PickTarget[] = [];
  private readonly index = new Map<string, number>();

  register(target: PickTarget): number {
    const key = pickKey(target);
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.targets.length;
      this.targets.push(target);
      this.index.set(key, i);
    }
    return i;
  }

  indexOf(target: PickTarget): number | undefined {
    return this.index.get(pickKey(target));
  }
}

/**
 * Renderer-agnostic indexed triangle mesh in **scene** coordinates (x east, y up, z −north). Vertices
 * are added in package ENU and converted on the way in. Each triangle records its pick owner so a
 * raycast `faceIndex` on the merged geometry maps back to a lane, link, connector or node.
 */
export class MeshData {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  readonly owners: number[] = [];
  private owner = -1;

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Pick owner of subsequently added triangles (-1 = not pickable). */
  setOwner(owner: number): this {
    this.owner = owner;
    return this;
  }

  /** Adds a vertex given in package ENU and returns its index. */
  vertex(p: Vec3): number {
    const [x, y, z] = toScene(p);
    this.positions.push(x, y, z);
    return this.vertexCount - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
    this.owners.push(this.owner);
  }

  /** Quad a-b-c-d (in order around the perimeter) as two triangles. */
  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  /**
   * Strip between two polylines of equal length (e.g. left and right edges of a ribbon). Vertices are
   * emitted pairwise; consecutive pairs form quads.
   */
  strip(left: readonly Vec3[], right: readonly Vec3[]): void {
    const n = Math.min(left.length, right.length);
    if (n < 2) return;
    let prevL = this.vertex(left[0]!);
    let prevR = this.vertex(right[0]!);
    for (let i = 1; i < n; i++) {
      const l = this.vertex(left[i]!);
      const r = this.vertex(right[i]!);
      this.quad(prevL, prevR, r, l);
      prevL = l;
      prevR = r;
    }
  }

  /** Triangle fan over a convex polygon (ENU, any orientation). */
  fan(polygon: readonly Vec3[]): void {
    if (polygon.length < 3) return;
    const ids = polygon.map((p) => this.vertex(p));
    for (let i = 1; i < ids.length - 1; i++) this.triangle(ids[0]!, ids[i]!, ids[i + 1]!);
  }

  /** Axis-free box between two horizontal points with a width, from `bottom` to `top` height (ENU z). */
  box(a: readonly [number, number], b: readonly [number, number], width: number, bottom: number, top: number): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = (dy / l) * (width / 2);
    const ny = (-dx / l) * (width / 2);
    const corners: [number, number][] = [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
    ];
    // Separate vertices per face keep normals flat.
    for (let i = 0; i < 4; i++) {
      const p = corners[i]!;
      const q = corners[(i + 1) % 4]!;
      this.fan([
        [p[0], p[1], bottom],
        [q[0], q[1], bottom],
        [q[0], q[1], top],
        [p[0], p[1], top],
      ]);
    }
    this.fan(corners.map(([x, y]) => [x, y, top] as Vec3));
  }

  /** Indices of triangles owned by `owner` (for highlight overlays). */
  trianglesOf(owner: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.owners.length; i++) if (this.owners[i] === owner) out.push(i);
    return out;
  }
}
