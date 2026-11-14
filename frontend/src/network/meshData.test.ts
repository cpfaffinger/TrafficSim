import { describe, expect, it } from 'vitest';
import { MeshData, PickRegistry, pickKey } from './meshData';

describe('PickRegistry', () => {
  it('deduplicates targets by key', () => {
    const r = new PickRegistry();
    const a = r.register({ kind: 'lane', linkId: 'l1', laneIndex: 0 });
    const b = r.register({ kind: 'lane', linkId: 'l1', laneIndex: 0 });
    const c = r.register({ kind: 'node', nodeId: 'n1' });
    expect(a).toBe(b);
    expect(c).toBe(1);
    expect(r.indexOf({ kind: 'node', nodeId: 'n1' })).toBe(1);
    expect(r.indexOf({ kind: 'link', linkId: 'zz' })).toBeUndefined();
  });

  it('builds distinct keys per kind', () => {
    expect(
      new Set([
        pickKey({ kind: 'lane', linkId: 'x', laneIndex: 1 }),
        pickKey({ kind: 'link', linkId: 'x' }),
        pickKey({ kind: 'connector', connectorId: 'x' }),
        pickKey({ kind: 'node', nodeId: 'x' }),
      ]).size,
    ).toBe(4);
  });
});

describe('MeshData', () => {
  it('converts ENU to scene coordinates', () => {
    const m = new MeshData();
    expect(m.vertex([1, 2, 3])).toBe(0);
    expect(m.positions).toEqual([1, 3, -2]);
  });

  it('records the owner of each triangle', () => {
    const m = new MeshData();
    m.setOwner(7).strip(
      [
        [0, 1, 0],
        [5, 1, 0],
        [10, 1, 0],
      ],
      [
        [0, -1, 0],
        [5, -1, 0],
        [10, -1, 0],
      ],
    );
    m.setOwner(2).fan([
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ]);
    expect(m.triangleCount).toBe(6);
    expect(m.owners).toEqual([7, 7, 7, 7, 2, 2]);
    expect(m.trianglesOf(2)).toEqual([4, 5]);
    expect(Math.max(...m.indices)).toBe(m.vertexCount - 1);
  });

  it('ignores degenerate strips and fans', () => {
    const m = new MeshData();
    m.strip([[0, 0, 0]], [[0, 1, 0]]);
    m.fan([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    expect(m.triangleCount).toBe(0);
  });

  it('builds closed-top boxes with flat faces', () => {
    const m = new MeshData();
    m.box([0, 0], [0, 2], 1, 0, 5);
    expect(m.triangleCount).toBe(10); // 4 sides + top
    expect(m.vertexCount).toBe(20);
    const ys = m.positions.filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(5);
    const xs = m.positions.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(-0.5);
    expect(Math.max(...xs)).toBeCloseTo(0.5);
  });
});
