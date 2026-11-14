import { describe, expect, it } from 'vitest';
import { PackageIndex } from '../network/inspect';
import { editorNetwork } from '../test/editorNetwork';
import { junctionDiagram } from './junctionDiagram';
import {
  armLabel,
  banMovement,
  compass,
  changesetOverrides,
  classifyTurn,
  junctionMovements,
  toggleConnection,
  turnAngle,
  withoutMovementEdits,
  type Movement,
} from './movements';
import { controlChoiceOf, convertToRoundabout, setNodeControl } from './nodeEdits';
import { EditError, type EditOperation } from './ops';

const index = new PackageIndex(editorNetwork());
const node = index.nodes.get('n0')!;
const movement = (ms: Movement[], id: string) => ms.find((m) => m.id === id)!;

describe('junction control (#68)', () => {
  it('writes node tags for each control', () => {
    expect(setNodeControl(node, 'signal').ops).toEqual([
      { op: 'set_node_tags', nodeId: 100, tags: { highway: 'traffic_signals', stop: null, 'trafficsim:signals': null } },
    ]);
    expect(setNodeControl(node, 'stop').ops[0]).toMatchObject({ tags: { highway: 'stop', 'trafficsim:signals': 'no' } });
    // "automatic" on a signalised junction removes inferred signals too (#106)
    expect(setNodeControl({ ...node, control: 'signal' }, 'auto').ops[0]).toMatchObject({ tags: { highway: null, 'trafficsim:signals': 'no' } });
    expect(setNodeControl(node, 'all_way_stop').ops[0]).toMatchObject({ tags: { highway: 'stop', stop: 'all' } });
    expect(setNodeControl(node, 'auto').ops[0]).toMatchObject({ tags: { highway: null, stop: null, 'trafficsim:signals': null } });
    expect(setNodeControl(node, 'give_way').label).toBe('Junction control: give way sign');
    expect(() => setNodeControl({ ...node, osmId: null }, 'stop')).toThrow(EditError);
  });

  it('guesses the current control', () => {
    expect(controlChoiceOf('signal')).toBe('signal');
    expect(controlChoiceOf('all_way_stop')).toBe('all_way_stop');
    expect(controlChoiceOf('roundabout')).toBe('mini_roundabout');
    expect(controlChoiceOf('priority')).toBe('auto');
  });

  it('converts junctions to roundabouts within the radius limits', () => {
    expect(convertToRoundabout(node, 15).ops).toEqual([{ op: 'convert_to_roundabout', nodeId: 100, radius: 15 }]);
    expect(() => convertToRoundabout(node, 3)).toThrow(/between 6 and 60/);
  });
});

describe('movements (#66)', () => {
  it('lists every candidate movement with its key, turn and lane connections', () => {
    const ms = junctionMovements(index, 'n0', []);
    expect(ms.map((m) => m.id)).toEqual(['l0>l5', 'l0>l2', 'l3>l1', 'l3>l5', 'l4>l1', 'l4>l5', 'l4>l2', 'l6>l2', 'l6>l1']);
    const westThrough = movement(ms, 'l0>l2');
    expect(westThrough.key).toEqual({ nodeId: 100, fromNeighbour: 202, toNeighbour: 301 });
    expect(westThrough.turn).toBe('through');
    expect(westThrough.connections).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(movement(ms, 'l4>l2').turn).toBe('left');
  });

  it('classifies turns like the compiler', () => {
    const l0 = index.links.get('l0')!;
    expect(turnAngle(l0, index.links.get('l5')!)).toBeCloseTo(-90);
    expect(classifyTurn(0)).toBe('through');
    expect(classifyTurn(30)).toBe('slight_left');
    expect(classifyTurn(-30)).toBe('slight_right');
    expect(classifyTurn(150)).toBe('sharp_left');
    expect(classifyTurn(-150)).toBe('sharp_right');
    expect(classifyTurn(179)).toBe('reverse');
  });

  it('marks banned and overridden movements from the changeset', () => {
    const key = { nodeId: 100, fromNeighbour: 202, toNeighbour: 301 };
    const ban: EditOperation = { op: 'ban_movement', ...key };
    const conn: EditOperation = { op: 'set_lane_connections', ...key, fromLane: 0, toLanes: [1, 1, 0] };
    expect(changesetOverrides([conn]).connections.get('100:202:301')?.get(0)).toEqual([0, 1]);
    expect(changesetOverrides([conn, ban]).connections.size).toBe(0);
    expect(changesetOverrides([ban, conn]).banned.size).toBe(0);
    const ms = junctionMovements(index, 'n0', [ban]);
    expect(movement(ms, 'l0>l2').banned).toBe(true);
    expect(movement(junctionMovements(index, 'n0', [conn]), 'l0>l2').overridden).toBe(true);
  });

  it('toggles lane connections and rewrites the whole movement', () => {
    const m = movement(junctionMovements(index, 'n0', []), 'l0>l2');
    const r = toggleConnection(m, 0, 1);
    expect(r.ops).toEqual([
      { op: 'set_lane_connections', nodeId: 100, fromNeighbour: 202, fromLane: 0, toNeighbour: 301, toLanes: [0, 1] },
      { op: 'set_lane_connections', nodeId: 100, fromNeighbour: 202, fromLane: 1, toNeighbour: 301, toLanes: [1] },
    ]);
    expect(r.label).toBe('Connect lane 0 → lane 1 (through)');
    expect(toggleConnection(m, 1, 1).ops[1]).toMatchObject({ fromLane: 1, toLanes: [] });
    expect(() => toggleConnection(m, 5, 0)).toThrow(EditError);
  });

  it('bans turns and lifts bans', () => {
    const m = movement(junctionMovements(index, 'n0', []), 'l3>l5');
    const ban = banMovement(m);
    expect(ban.ops).toEqual([{ op: 'ban_movement', nodeId: 100, fromNeighbour: 301, toNeighbour: 501 }]);
    expect(ban.label).toBe('Ban left turn');
    const other: EditOperation = { op: 'set_node_tags', nodeId: 1, tags: {} };
    const conn: EditOperation = { op: 'set_lane_connections', nodeId: 100, fromNeighbour: 301, toNeighbour: 501, fromLane: 0, toLanes: [0] };
    expect(withoutMovementEdits([other, ...ban.ops, conn], m, 'ban')).toEqual([other, conn]);
    expect(withoutMovementEdits([other, ...ban.ops, conn], m, 'all')).toEqual([other]);
  });

  it('refuses movements without OSM ids', () => {
    const pkg = editorNetwork();
    pkg.links[0]!.osmBeforeTo = null;
    const m = movement(junctionMovements(new PackageIndex(pkg), 'n0', []), 'l0>l2');
    expect(m.key).toBeNull();
    expect(() => banMovement(m)).toThrow(/cannot be edited/);
  });
});

describe('arm labels', () => {
  it('names arms by compass direction seen from the junction', () => {
    expect(compass(1, 0)).toBe('E');
    expect(compass(-1, -1)).toBe('SW');
    expect(compass(0, -1)).toBe('S');
    expect(armLabel(index.links.get('l0')!, true)).toBe('from W');
    expect(armLabel({ ...index.links.get('l2')!, name: 'Main St' }, false)).toBe('to E (Main St)');
    expect(armLabel(index.links.get('l4')!, true)).toBe('from N');
  });
});

describe('junction diagram', () => {
  it('places lane ends and connection curves inside the square', () => {
    const ms = junctionMovements(index, 'n0', []);
    const d = junctionDiagram(index, 'n0', ms, 200);
    expect(d.arms).toHaveLength(7);
    expect(d.incoming).toHaveLength(2 + 2 + 1 + 1);
    expect(d.outgoing).toHaveLength(2 + 2 + 1);
    for (const p of [...d.incoming, ...d.outgoing]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(200);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(200);
    }
    expect(d.connections).toHaveLength(index.pkg.connectors.length);
    expect(d.connections[0]!.d).toMatch(/^M [\d.]+ [\d.]+ Q 100 100 /);
    // The western approach arrives from the left: its stub extends to smaller x.
    const west = d.arms.find((a) => a.linkId === 'l0')!;
    expect(west.to.x).toBeLessThan(west.from.x);
  });
});
