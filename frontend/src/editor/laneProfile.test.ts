import { describe, expect, it } from 'vitest';
import { straightLink } from '../test/networkFactory';
import {
  addLane,
  laneCountTags,
  laneTags,
  markingOf,
  nextMarking,
  osmLanes,
  permissionsOf,
  profileOf,
  removeLane,
  setBoundary,
  setWidths,
  updateLane,
  type LaneProfile,
} from './laneProfile';

const threeLanes = (): LaneProfile =>
  profileOf({
    ...straightLink('l1', 'a', 'b', [0, 0], [100, 0], { lanes: 3, turns: [['right'], ['through'], ['left']] }),
    assumed: ['width'],
  });

describe('lane profile', () => {
  it('reads turns, widths, bus lanes and boundaries from a link', () => {
    const link = straightLink('l1', 'a', 'b', [0, 0], [100, 0], { lanes: 2, width: 3.5 });
    link.lanes[0]!.allowed = ['bus'];
    const p = profileOf(link);
    expect(p.lanes.map((l) => [l.busOnly, l.width])).toEqual([
      [true, 3.5],
      [false, 3.5],
    ]);
    expect(p.boundaries).toEqual([{ allowLeft: true, allowRight: true }]);
    expect(p.widthTagged).toBe(true);
  });

  it('writes per-lane tags in OSM order (left to right)', () => {
    expect(osmLanes(['a', 'b', 'c'])).toBe('c|b|a');
    const tags = laneTags(threeLanes(), 'forward');
    expect(tags['turn:lanes:forward']).toBe('left|through|right');
    expect(tags['change:lanes:forward']).toBeNull();
    expect(tags['bus:lanes:forward']).toBeNull();
    expect(tags['width:lanes:forward']).toBeNull();
  });

  it('uses direction-free keys for one-way roads and clears directional variants', () => {
    const tags = laneTags(threeLanes(), 'oneway');
    expect(tags['turn:lanes']).toBe('left|through|right');
    expect(tags['turn:lanes:forward']).toBeNull();
    expect(tags['turn:lanes:backward']).toBeNull();
  });

  it('marks unmarked lanes as none when other lanes carry markings', () => {
    const p = updateLane(threeLanes(), 1, { turns: [] });
    expect(laneTags(p, 'backward')['turn:lanes:backward']).toBe('left|none|right');
    const none = [0, 1, 2].reduce((acc, i) => updateLane(acc, i, { turns: [] }), threeLanes());
    expect(laneTags(none, 'backward')['turn:lanes:backward']).toBeNull();
  });

  it('adds lanes on either side with a dashed boundary', () => {
    const left = addLane(threeLanes(), 'left');
    expect(left.lanes.map((l) => l.turns)).toEqual([['right'], ['through'], ['left'], []]);
    expect(left.boundaries).toHaveLength(3);
    const right = addLane(setBoundary(threeLanes(), 0, 'solid'), 'right');
    expect(right.lanes[0]!.turns).toEqual([]);
    expect(right.boundaries.map(markingOf)).toEqual(['dashed', 'solid', 'dashed']);
    expect(addLane({ lanes: [], boundaries: [], widthTagged: false }, 'left').lanes).toHaveLength(1);
  });

  it('removes a lane together with an adjacent boundary', () => {
    const p = setBoundary(setBoundary(threeLanes(), 0, 'solid'), 1, 'solid_dashed');
    expect(removeLane(p, 0).boundaries.map(markingOf)).toEqual(['solid_dashed']);
    expect(removeLane(p, 2).boundaries.map(markingOf)).toEqual(['solid']);
    expect(removeLane(p, 1).boundaries.map(markingOf)).toEqual(['solid']);
    expect(removeLane(p, 1).lanes.map((l) => l.turns)).toEqual([['right'], ['left']]);
  });

  it('derives change:lanes from boundary permissions', () => {
    // boundary 0|1 solid; boundary 1|2: only the right lane (1) may cross to the left.
    const p = setBoundary(setBoundary(threeLanes(), 0, 'solid'), 1, 'solid_dashed');
    // lane 0: not left; lane 1: may go left but not right; lane 2: may not go right.
    expect(laneTags(p, 'forward')['change:lanes:forward']).toBe('not_right|not_right|not_left');
    const both = setBoundary(threeLanes(), 0, 'dashed_solid');
    expect(laneTags(both, 'forward')['change:lanes:forward']).toBe('yes|yes|not_left');
    const fully = setBoundary(setBoundary(threeLanes(), 0, 'solid'), 1, 'solid');
    expect(laneTags(fully, 'forward')['change:lanes:forward']).toBe('not_right|no|not_left');
  });

  it('maps markings to permissions and cycles through them', () => {
    for (const m of ['dashed', 'solid', 'solid_dashed', 'dashed_solid'] as const) expect(markingOf(permissionsOf(m))).toBe(m);
    expect(markingOf(permissionsOf('double_solid'))).toBe('solid');
    expect(nextMarking('dashed')).toBe('solid');
    expect(nextMarking('double_solid')).toBe('solid_dashed');
    expect(nextMarking('dashed_solid')).toBe('dashed');
  });

  it('writes bus lanes and widths', () => {
    const p = setWidths(updateLane(threeLanes(), 0, { busOnly: true }), 2, 2.75);
    const tags = laneTags(p, 'forward');
    expect(tags['bus:lanes:forward']).toBe('yes|yes|designated');
    expect(tags['psv:lanes:forward']).toBeNull();
    expect(tags['width:lanes:forward']).toBe('2.75|3|3');
    expect(setWidths(threeLanes(), null, 3.1).lanes.every((l) => l.width === 3.1)).toBe(true);
  });

  it('computes lane counts per direction', () => {
    expect(laneCountTags('oneway', 3, 0)).toEqual({ lanes: '3', 'lanes:forward': null, 'lanes:backward': null });
    expect(laneCountTags('forward', 3, 2)).toEqual({ lanes: '5', 'lanes:forward': '3', 'lanes:backward': '2' });
    expect(laneCountTags('backward', 3, 2)).toEqual({ lanes: '5', 'lanes:forward': '2', 'lanes:backward': '3' });
    expect(laneCountTags('forward', 5, 4).lanes).toBeNull();
  });
});
