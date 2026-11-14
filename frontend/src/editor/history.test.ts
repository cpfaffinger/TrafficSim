import { describe, expect, it } from 'vitest';
import { commit, createHistory, MAX_HISTORY, pushEdit, redo, redoLabel, sameChangeset, undo, undoLabel } from './history';
import { describeOp, EditError, IdAllocator, parseChangeset, splitsWay, type EditOperation } from './ops';

const ban: EditOperation = { op: 'ban_movement', nodeId: 1, fromNeighbour: 2, toNeighbour: 3 };
const tags: EditOperation = { op: 'set_way_tags', wayId: 5, fromNode: null, toNode: null, tags: { lanes: '2' } };

describe('edit history (#70)', () => {
  it('pushes, undoes and redoes edits', () => {
    let h = createHistory();
    expect(undoLabel(h)).toBeNull();
    h = pushEdit(h, 'Ban', [ban]);
    h = pushEdit(h, 'Lanes', [tags]);
    expect(h.present.changeset).toEqual([ban, tags]);
    expect(undoLabel(h)).toBe('Lanes');
    h = undo(h);
    expect(h.present.changeset).toEqual([ban]);
    expect(redoLabel(h)).toBe('Lanes');
    h = redo(h);
    expect(h.present.changeset).toEqual([ban, tags]);
    expect(redo(h)).toBe(h);
    expect(undo(undo(undo(h))).present.changeset).toEqual([]);
    expect(undo(createHistory())).toEqual(createHistory());
  });

  it('drops the redo branch on a new edit and ignores empty edits', () => {
    let h = pushEdit(createHistory(), 'Ban', [ban]);
    h = undo(h);
    h = pushEdit(h, 'Lanes', [tags]);
    expect(h.future).toEqual([]);
    expect(pushEdit(h, 'Nothing', [])).toBe(h);
    expect(commit(h, 'Same', h.present.changeset)).toBe(h);
  });

  it('commits non-append changes and bounds its depth', () => {
    let h = pushEdit(createHistory(), 'Ban', [ban]);
    h = commit(h, 'Allow turn', []);
    expect(h.present).toEqual({ label: 'Allow turn', changeset: [] });
    expect(undo(h).present.changeset).toEqual([ban]);
    for (let i = 0; i < MAX_HISTORY + 10; i++) h = pushEdit(h, `e${i}`, [tags]);
    expect(h.past).toHaveLength(MAX_HISTORY);
  });

  it('compares changesets structurally', () => {
    expect(sameChangeset([ban], [{ ...ban }])).toBe(true);
    expect(sameChangeset([ban], [tags])).toBe(false);
    expect(sameChangeset([], [ban])).toBe(false);
  });
});

describe('operations', () => {
  it('allocates negative ids above the generated range', () => {
    const add: EditOperation = { op: 'add_way', wayId: -3, nodes: [{ id: 7 }, { id: -4, lat: 1, lon: 2 }], tags: { highway: 'residential' } };
    const split: EditOperation = { op: 'set_way_tags', wayId: -1_000_000_001, fromNode: null, toNode: null, tags: {} };
    const ids = new IdAllocator([add, split]);
    expect(ids.take()).toBe(-5);
    expect(ids.take()).toBe(-6);
    expect(new IdAllocator([]).take()).toBe(-1);
    expect(new IdAllocator([], [-9]).take()).toBe(-10);
  });

  it('knows which edits split a way', () => {
    expect(splitsWay(tags, 5)).toBe(false);
    expect(splitsWay({ ...tags, fromNode: 1 }, 5)).toBe(true);
    expect(splitsWay({ ...tags, fromNode: 1 }, 6)).toBe(false);
    expect(splitsWay({ op: 'remove_way', wayId: 5, fromNode: null, toNode: null }, 5)).toBe(true);
    expect(splitsWay({ op: 'convert_to_roundabout', nodeId: 1, radius: 15 }, 5)).toBe(true);
    expect(splitsWay(ban, 5)).toBe(false);
  });

  it('describes every operation', () => {
    const ops: EditOperation[] = [
      tags,
      { ...tags, fromNode: 1, toNode: 2, tags: { hgv: null } },
      { op: 'set_node_tags', nodeId: 1, tags: { highway: 'stop' } },
      { op: 'add_way', wayId: -1, nodes: [{ id: 1 }, { id: 2 }], tags: { highway: 'residential' } },
      { op: 'insert_node', wayId: 4, afterNode: 1, nodeId: -2, lat: 0, lon: 0 },
      { op: 'remove_way', wayId: 4, fromNode: 1, toNode: 2 },
      { op: 'convert_to_roundabout', nodeId: 1, radius: 15 },
      { op: 'set_lane_connections', nodeId: 1, fromNeighbour: 2, fromLane: 0, toNeighbour: 3, toLanes: [0, 1] },
      ban,
      { op: 'set_signal_plan', nodeId: 1, cycle: 90, offset: 0, phaseGreen: [40, 35], approachPhase: null },
    ];
    const texts = ops.map(describeOp);
    expect(texts).toEqual([
      'Way 5: lanes=2',
      'Way 5 (1–2): −hgv',
      'Node 1: highway=stop',
      'New road (2 nodes, residential)',
      'Attach point on way 4',
      'Remove way 4 (part)',
      'Roundabout at node 1 (r = 15 m)',
      'Lane connections at node 1: lane 0 → [0, 1]',
      'Ban turn at node 1',
      'Signal plan at node 1: cycle 90 s, 2 phases',
    ]);
  });

  it('parses changesets from the server', () => {
    expect(parseChangeset([ban, { op: 'unknown' }, null, 3])).toEqual([ban]);
    expect(parseChangeset({})).toEqual([]);
    expect(new EditError('x').name).toBe('EditError');
  });
});
