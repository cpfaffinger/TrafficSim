import { describe, expect, it } from 'vitest';
import { LocalTangentPlane } from '../network/geo';
import { PackageIndex } from '../network/inspect';
import { editorNetwork } from '../test/editorNetwork';
import { addDraftPoint, buildRoad, DEFAULT_ROAD, insertAfterNode, projectOnSegment, roadTags, snapPoint, type DraftPoint } from './drawRoad';
import { EditError, type EditOperation } from './ops';

const index = new PackageIndex(editorNetwork());
const link = (id: string) => index.links.get(id)!;

describe('road drawing (#69)', () => {
  it('projects points on segments', () => {
    expect(projectOnSegment([5, 3], [0, 0], [10, 0])).toEqual({ x: 5, y: 0, t: 0.5, distance: 3 });
    expect(projectOnSegment([-5, 0], [0, 0], [10, 0]).t).toBe(0);
    expect(projectOnSegment([1, 1], [0, 0], [0, 0]).distance).toBeCloseTo(Math.SQRT2);
  });

  it('snaps to nearby junctions', () => {
    expect(snapPoint(index, [4, -3])).toEqual({ kind: 'node', osmId: 100, nodeId: 'n0', x: 0, y: 0 });
  });

  it('attaches to any OSM segment when the package lists the link nodes (#105)', () => {
    const pkg = editorNetwork();
    // way 1000 [101, 201, 202, 100] from x = -100 to 0; the backward link lists nodes in travel order.
    const nodes = [
      { id: 101, x: -100, y: 0 },
      { id: 201, x: -66, y: 0 },
      { id: 202, x: -33, y: 0 },
      { id: 100, x: 0, y: 0 },
    ];
    const links = pkg.links.map((l) =>
      l.osmWayId === 1000 ? { ...l, osmNodes: l.from === 'n0' ? [...nodes].reverse() : nodes, osmForward: l.from !== 'n0' } : l,
    );
    const withNodes = new PackageIndex({ ...pkg, links });
    expect(snapPoint(withNodes, [-50, -1])).toMatchObject({ kind: 'insert', wayId: 1000, afterNode: 201, x: -50 });
    expect(snapPoint(withNodes, [-80, -1])).toMatchObject({ kind: 'insert', wayId: 1000, afterNode: 101 });
  });

  it('attaches to roads on their first or last segment', () => {
    // East road (way 2000): forward link l2 from the junction, a click on its second segment.
    expect(snapPoint(index, [60, -2])).toMatchObject({ kind: 'insert', wayId: 2000, afterNode: 301, x: 60, y: 0 });
    expect(snapPoint(index, [20, -2])).toMatchObject({ kind: 'insert', wayId: 2000, afterNode: 100, x: 20 });
    // West road (way 1000): a click on its second half uses the last segment.
    expect(snapPoint(index, [-30, -1])).toMatchObject({ kind: 'insert', wayId: 1000, afterNode: 202, x: -30 });
    expect(snapPoint(index, [-70, -1])).toMatchObject({ kind: 'insert', wayId: 1000, afterNode: 101 });
  });

  it('knows the OSM node before a segment in way order', () => {
    expect(insertAfterNode(index, link('l0'), 0)).toBe(101);
    expect(insertAfterNode(index, link('l0'), 1)).toBe(202);
    expect(insertAfterNode(index, link('l1'), 0)).toBe(202);
    expect(insertAfterNode(index, link('l1'), 1)).toBe(101);
    expect(insertAfterNode(index, link('l3'), 0)).toBe(301);
    expect(insertAfterNode(index, link('l3'), 1)).toBe(100);
    const pkg = editorNetwork();
    const l0 = pkg.links[0]!;
    l0.geometry = [[-100, 0, 0], [-60, 0, 0], [-30, 0, 0], [0, 0, 0]];
    expect(insertAfterNode(new PackageIndex(pkg), l0, 1)).toBeNull();
  });

  it('falls back to free points away from the network', () => {
    expect(snapPoint(index, [50, 50])).toEqual({ kind: 'free', x: 50, y: 50 });
  });

  it('ignores repeated clicks on the same spot', () => {
    const p: DraftPoint = { kind: 'free', x: 1, y: 1 };
    expect(addDraftPoint([p], { ...p, x: 1.2 })).toHaveLength(1);
    expect(addDraftPoint([p], { ...p, x: 5 })).toHaveLength(2);
  });

  it('writes road tags', () => {
    expect(roadTags(DEFAULT_ROAD)).toEqual({ highway: 'residential', lanes: '2', 'lanes:forward': '1', 'lanes:backward': '1' });
    expect(roadTags({ ...DEFAULT_ROAD, oneway: true, lanes: 2, maxspeed: 50, structure: 'bridge', layer: 2, name: ' New St ' })).toEqual({
      highway: 'residential',
      lanes: '2',
      oneway: 'yes',
      maxspeed: '50',
      bridge: 'yes',
      layer: '2',
      name: 'New St',
    });
    expect(() => roadTags({ ...DEFAULT_ROAD, lanes: 5 })).toThrow(EditError);
    expect(() => roadTags({ ...DEFAULT_ROAD, maxspeed: 2 })).toThrow(EditError);
  });

  it('builds attach points and the new way with fresh negative ids', () => {
    const existing: EditOperation = { op: 'add_way', wayId: -1, nodes: [{ id: 100 }, { id: -2, lat: 0, lon: 0 }], tags: { highway: 'service' } };
    const points = [snapPoint(index, [0, 0]), snapPoint(index, [50, 50]), snapPoint(index, [60, 1])];
    const r = buildRoad(index, points, DEFAULT_ROAD, [existing]);
    const [insert, add] = r.ops as [EditOperation & { op: 'insert_node' }, EditOperation & { op: 'add_way' }];
    expect(insert).toMatchObject({ op: 'insert_node', wayId: 2000, afterNode: 301, nodeId: -4 });
    expect(add.op).toBe('add_way');
    expect(add.wayId).toBe(-5);
    expect(add.nodes.map((n) => n.id)).toEqual([100, -3, -4]);
    const [lon, lat] = new LocalTangentPlane(index.pkg.origin).toGeo(50, 50);
    expect(add.nodes[1]!.lat).toBeCloseTo(lat, 6);
    expect(add.nodes[1]!.lon).toBeCloseTo(lon, 6);
    expect(r.label).toBe('New residential road');
  });

  it('rejects too short or self-crossing roads', () => {
    const n0 = snapPoint(index, [0, 0]);
    expect(() => buildRoad(index, [n0], DEFAULT_ROAD, [])).toThrow(/two points/);
    expect(() => buildRoad(index, [n0, snapPoint(index, [40, 40]), n0], DEFAULT_ROAD, [])).toThrow(/same junction/);
    const loop = [n0, snapPoint(index, [40, 40]), snapPoint(index, [40, -40]), n0];
    expect(buildRoad(index, loop, { ...DEFAULT_ROAD, name: 'Loop' }, []).label).toBe('New residential road “Loop”');
  });
});
