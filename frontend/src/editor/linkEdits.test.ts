import { describe, expect, it } from 'vitest';
import { PackageIndex } from '../network/inspect';
import { editorNetwork } from '../test/editorNetwork';
import {
  addLane,
  moveLaneToOpposite,
  removeLane,
  removeRoad,
  setBoundaryMarking,
  setBusLane,
  setCentreLine,
  setDestinationOnly,
  setHgvBan,
  setLaneWidth,
  setSpeedLimit,
  setStructure,
  setTurns,
  structureTags,
  toggleOneway,
  type LinkEditContext,
} from './linkEdits';
import { EditError, type EditOperation, type SetWayTagsOp } from './ops';
import { linkPart, scopeParts, wayDirection } from './wayContext';

const index = new PackageIndex(editorNetwork());
const link = (id: string) => index.links.get(id)!;
const ctx = (scope: LinkEditContext['scope'] = 'way', changeset: EditOperation[] = []): LinkEditContext => ({ index, changeset, scope });
const tags = (ops: EditOperation[]) => (ops[0] as SetWayTagsOp).tags;

describe('way context', () => {
  it('derives the travel direction from the compiler link order', () => {
    expect(wayDirection(index, link('l0'))).toBe('forward');
    expect(wayDirection(index, link('l1'))).toBe('backward');
    expect(wayDirection(index, link('l4'))).toBe('oneway');
  });

  it('addresses the link part with its ends in way order', () => {
    expect(linkPart(index, link('l0'))).toEqual({ wayId: 1000, fromNode: 101, toNode: 100 });
    expect(linkPart(index, link('l1'))).toEqual({ wayId: 1000, fromNode: 101, toNode: 100 });
    expect(linkPart(index, link('l3'))).toEqual({ wayId: 2000, fromNode: 100, toNode: 102 });
  });

  it('edits the whole way at once unless an earlier edit split it', () => {
    expect(scopeParts(index, link('l0'), 'way', [])).toEqual([{ wayId: 1000, fromNode: null, toNode: null }]);
    const split: EditOperation = { op: 'set_way_tags', wayId: 1000, fromNode: 101, toNode: 100, tags: {} };
    expect(scopeParts(index, link('l1'), 'way', [split])).toEqual([{ wayId: 1000, fromNode: 101, toNode: 100 }]);
    expect(scopeParts(index, link('l0'), 'part', [])).toEqual([{ wayId: 1000, fromNode: 101, toNode: 100 }]);
  });

  it('refuses links without an OSM way', () => {
    const pkg = editorNetwork();
    pkg.links[4]!.osmWayId = null;
    const i = new PackageIndex(pkg);
    expect(() => scopeParts(i, i.links.get('l4')!, 'way', [])).toThrow(EditError);
  });
});

describe('lane tools (#65)', () => {
  it('adds a lane in the link direction and keeps the opposite count', () => {
    const r = addLane(ctx(), link('l1'), 'left');
    expect(r.ops).toEqual([
      expect.objectContaining({ op: 'set_way_tags', wayId: 1000, fromNode: null, toNode: null }),
    ]);
    expect(tags(r.ops)).toMatchObject({ lanes: '5', 'lanes:forward': '2', 'lanes:backward': '3' });
    expect(r.label).toBe('Add lane on the left (whole road)');
  });

  it('keeps turn markings when adding a lane on the right of the forward direction', () => {
    const r = addLane(ctx('part'), link('l0'), 'right');
    expect(tags(r.ops)).toMatchObject({ 'lanes:forward': '3', 'turn:lanes:forward': 'through|through;right|none' });
    expect(r.ops[0]).toMatchObject({ fromNode: 101, toNode: 100 });
  });

  it('removes lanes but never the last one', () => {
    expect(tags(removeLane(ctx(), link('l0'), 0).ops)).toMatchObject({ 'lanes:forward': '1', 'turn:lanes:forward': 'through' });
    expect(() => removeLane(ctx(), link('l4'), 0)).toThrow(/at least one lane/);
    expect(() => removeLane(ctx(), link('l0'), 5)).toThrow(EditError);
  });

  it('enforces the lane limit', () => {
    const pkg = editorNetwork();
    const l4 = pkg.links[4]!;
    l4.lanes = Array.from({ length: 8 }, (_, i) => ({ ...l4.lanes[0]!, index: i, id: `l4:${i}` }));
    const i = new PackageIndex(pkg);
    expect(() => addLane({ index: i, changeset: [], scope: 'way' }, i.links.get('l4')!, 'left')).toThrow(/At most 8/);
  });

  it('moves a lane to the opposite direction', () => {
    const r = moveLaneToOpposite(ctx(), link('l0'));
    expect(tags(r.ops)).toMatchObject({ lanes: '4', 'lanes:forward': '1', 'lanes:backward': '3', 'turn:lanes:forward': 'through;right' });
    expect(() => moveLaneToOpposite(ctx(), link('l4'))).toThrow(/two-way/);
    expect(() => moveLaneToOpposite(ctx(), link('l5'))).toThrow(/only one lane/);
  });

  it('sets lane widths', () => {
    expect(tags(setLaneWidth(ctx(), link('l2'), null, 3.5).ops)['width:lanes:forward']).toBe('3.5|3.5');
    expect(tags(setLaneWidth(ctx(), link('l2'), 0, 2.8).ops)['width:lanes:forward']).toBe('3|2.8');
    expect(() => setLaneWidth(ctx(), link('l2'), 0, 9)).toThrow(/between/);
  });

  it('toggles one-way', () => {
    const one = toggleOneway(ctx(), link('l1'));
    expect(tags(one.ops)).toMatchObject({ oneway: '-1', lanes: '2', 'lanes:forward': null, 'lanes:backward': null, 'turn:lanes:forward': null });
    expect(tags(toggleOneway(ctx(), link('l0')).ops)).toMatchObject({ oneway: 'yes', 'turn:lanes': 'through|through;right' });
    const two = toggleOneway(ctx(), link('l4'));
    expect(tags(two.ops)).toMatchObject({ oneway: 'no', lanes: '2', 'lanes:forward': '1', 'lanes:backward': '1', 'turn:lanes': null });
    expect(two.label).toBe('Make two-way (whole road)');
  });
});

describe('turn lanes (#66) and markings (#98)', () => {
  it('sets the turn markings of one lane', () => {
    const r = setTurns(ctx(), link('l0'), 1, ['left', 'through']);
    expect(tags(r.ops)['turn:lanes:forward']).toBe('left;through|through;right');
    expect(r.label).toContain('left, through');
    expect(setTurns(ctx(), link('l0'), 1, []).label).toContain('none');
    expect(() => setTurns(ctx(), link('l0'), 4, [])).toThrow(EditError);
  });

  it('sets boundary markings and the centre line', () => {
    expect(tags(setBoundaryMarking(ctx(), link('l2'), 0, 'solid').ops)['change:lanes:forward']).toBe('not_right|not_left');
    expect(() => setBoundaryMarking(ctx(), link('l4'), 0, 'solid')).toThrow(EditError);
    expect(tags(setCentreLine(ctx(), link('l2'), true).ops)).toMatchObject({ overtaking: 'no', divider: null });
    expect(tags(setCentreLine(ctx(), link('l2'), false).ops).overtaking).toBe('yes');
    expect(() => setCentreLine(ctx(), link('l4'), true)).toThrow(/One-way/);
  });
});

describe('speed and restrictions (#67)', () => {
  it('sets the speed limit per direction or for both', () => {
    expect(tags(setSpeedLimit(ctx(), link('l1'), 30, false).ops)).toEqual({ 'maxspeed:backward': '30', 'maxspeed:lanes:backward': null });
    expect(tags(setSpeedLimit(ctx(), link('l1'), 30, true).ops)).toMatchObject({ maxspeed: '30', 'maxspeed:forward': null });
    expect(tags(setSpeedLimit(ctx(), link('l4'), null, false).ops).maxspeed).toBeNull();
    expect(() => setSpeedLimit(ctx(), link('l4'), 300, true)).toThrow(/between 5 and 200/);
    expect(() => setSpeedLimit(ctx(), link('l4'), 33.3, true)).toThrow(EditError);
  });

  it('bans trucks, restricts to destination traffic and creates bus lanes', () => {
    expect(tags(setHgvBan(ctx(), link('l0'), true).ops)).toEqual({ hgv: 'no' });
    expect(tags(setHgvBan(ctx(), link('l0'), false).ops)).toEqual({ hgv: null });
    expect(tags(setDestinationOnly(ctx(), link('l0'), true).ops)).toEqual({ access: 'destination' });
    expect(tags(setDestinationOnly(ctx(), link('l0'), false).ops)).toEqual({ access: null });
    expect(tags(setBusLane(ctx(), link('l2'), 0, true).ops)['bus:lanes:forward']).toBe('yes|designated');
    expect(() => setBusLane(ctx(), link('l4'), 0, true)).toThrow(/single-lane/);
    expect(() => setBusLane(ctx(), link('l4'), 2, true)).toThrow(EditError);
  });
});

describe('structures and removal (#69, #98)', () => {
  it('turns roads into bridges or tunnels with a layer', () => {
    expect(tags(setStructure(ctx(), link('l0'), 'bridge').ops)).toEqual({ bridge: 'yes', tunnel: null, layer: '1' });
    expect(setStructure(ctx(), link('l0'), 'tunnel', -2).label).toBe('Tunnel, layer -2 (whole road)');
    expect(structureTags('none')).toEqual({ bridge: null, tunnel: null, layer: null });
    expect(structureTags('none', 1).layer).toBe('1');
    expect(() => structureTags('bridge', 7)).toThrow(/Layer/);
  });

  it('removes a road part or the whole way', () => {
    expect(removeRoad(ctx('part'), link('l3')).ops).toEqual([{ op: 'remove_way', wayId: 2000, fromNode: 100, toNode: 102 }]);
    expect(removeRoad(ctx(), link('l3')).ops).toEqual([{ op: 'remove_way', wayId: 2000, fromNode: null, toNode: null }]);
  });
});
