import { describe, expect, it } from 'vitest';
import { loadGoldenFixture } from '../test/goldenFixture';
import { connector, node, packageOf, straightLink } from '../test/networkFactory';
import { createBuildContext } from './buildContext';
import {
  arrowStations,
  arrowTriangles,
  boundaryComponents,
  buildMarkings,
  centreLinePlan,
  dashPattern,
  DOUBLE_HALF_GAP,
  lineIntervals,
  MARKING_LIFT,
  paintLine,
  stopLineKind,
} from './markings';
import { MeshData } from './meshData';
import type { NetworkPackage } from './types';

function markingsOf(pkg: NetworkPackage) {
  const out = { markings: new MeshData(), tunnelMarkings: new MeshData() };
  buildMarkings(createBuildContext(pkg), out);
  return out;
}

/** Number of separate painted pieces (strips) — each piece of a straight line is one quad. */
const quads = (m: MeshData) => m.triangleCount / 2;

describe('boundary markings', () => {
  it('maps markings to painted line components', () => {
    expect(boundaryComponents('dashed')).toEqual([{ offset: 0, kind: 'dashed' }]);
    expect(boundaryComponents('solid')).toEqual([{ offset: 0, kind: 'solid' }]);
    expect(boundaryComponents('double_solid').map((c) => c.kind)).toEqual(['solid', 'solid']);
    // Left component has the negative (left) offset.
    expect(boundaryComponents('solid_dashed')).toEqual([
      { offset: -DOUBLE_HALF_GAP, kind: 'solid' },
      { offset: DOUBLE_HALF_GAP, kind: 'dashed' },
    ]);
    expect(boundaryComponents('dashed_solid')).toEqual([
      { offset: -DOUBLE_HALF_GAP, kind: 'dashed' },
      { offset: DOUBLE_HALF_GAP, kind: 'solid' },
    ]);
  });

  it('uses long dashes on motorways and short dashes in town', () => {
    expect(dashPattern('motorway')).toEqual({ dash: 6, gap: 12 });
    expect(dashPattern('residential')).toEqual({ dash: 3, gap: 6 });
  });

  it('turns dashes solid in the no-lane-change zone', () => {
    const p = { dash: 3, gap: 6 };
    expect(lineIntervals('solid', 50, p)).toEqual([[0, 50]]);
    expect(lineIntervals('solid', 0, p)).toEqual([]);
    expect(lineIntervals('dashed', 20, p)).toEqual([
      [0, 3],
      [9, 12],
      [18, 20],
    ]);
    expect(lineIntervals('dashed', 40, p, 30)).toEqual([
      [0, 3],
      [9, 40],
    ]);
  });

  it('paints lines lifted above the road at the requested offset and width', () => {
    const m = new MeshData();
    paintLine(
      m,
      [
        [0, 0, 0],
        [10, 0, 0],
      ],
      1,
      0.2,
      (len) => [[0, len]],
    );
    const ys = m.positions.filter((_, i) => i % 3 === 1);
    const zs = m.positions.filter((_, i) => i % 3 === 2); // scene z = −north
    expect(new Set(ys)).toEqual(new Set([MARKING_LIFT]));
    expect(Math.min(...zs)).toBeCloseTo(0.9);
    expect(Math.max(...zs)).toBeCloseTo(1.1);
  });

  it('draws an asymmetric boundary with one solid and one dashed line', () => {
    const solidDashed = straightLink('a', 'n1', 'n2', [0, 0], [90, 0], {
      lanes: 2,
      boundaries: [{ rightLane: 0, leftLane: 1, marking: 'solid_dashed', allowLeft: true, allowRight: false }],
      leftEdge: 'centre_dashed',
      twoWay: true,
    });
    const dashed = straightLink('a', 'n1', 'n2', [0, 0], [90, 0], { lanes: 2, leftEdge: 'centre_dashed', twoWay: true });
    const nodes = [node('n1', 0, 0), node('n2', 90, 0)];
    // dashed: 10 dashes (90 m / 9 m); solid_dashed adds one continuous solid line.
    const centre = quads(markingsOf(packageOf(nodes, [dashed])).markings) - 10;
    expect(quads(markingsOf(packageOf(nodes, [solidDashed])).markings) - centre).toBe(11);
  });
});

describe('centre and edge lines', () => {
  const pkg = loadGoldenFixture();
  const ctx = createBuildContext(pkg);
  const link = (id: string) => ctx.links.get(id)!;

  it('draws identical centre halves once', () => {
    // l2/l3 and l6/l7 are both centre_dashed.
    expect(centreLinePlan(link('l6'), link('l7'))).toEqual([{ offset: 0, kind: 'dashed' }]);
    expect(centreLinePlan(link('l7'), link('l6'))).toEqual([]);
  });

  it('draws each side of an asymmetric centre line inside its own half', () => {
    // l1 (centre_solid) and l4 (centre_dashed) share way 101.
    expect(centreLinePlan(link('l1'), link('l4'))).toEqual([{ offset: DOUBLE_HALF_GAP, kind: 'solid' }]);
    expect(centreLinePlan(link('l4'), link('l1'))).toEqual([{ offset: DOUBLE_HALF_GAP, kind: 'dashed' }]);
  });

  it('handles double solid centre lines and one-way edges', () => {
    const a = { ...link('l6'), leftEdge: 'double_solid' as const };
    const b = { ...link('l7'), leftEdge: 'double_solid' as const };
    expect(centreLinePlan(a, b).map((c) => c.kind)).toEqual(['solid', 'solid']);
    expect(centreLinePlan(a, undefined)).toEqual([{ offset: DOUBLE_HALF_GAP, kind: 'solid' }]);
    expect(centreLinePlan(link('l9'), undefined)).toEqual([]);
  });
});

describe('stop lines', () => {
  const pkg = loadGoldenFixture();
  const ctx = createBuildContext(pkg);

  it('marks signalised approaches and nothing on exits', () => {
    for (const id of ['l1', 'l3', 'l5', 'l7']) expect(stopLineKind(ctx, ctx.links.get(id)!)).toBe('stop');
    for (const id of ['l2', 'l4', 'l9']) expect(stopLineKind(ctx, ctx.links.get(id)!)).toBeNull();
  });

  it('distinguishes give-way lines and node controls', () => {
    const a = straightLink('a', 'n1', 'n2', [0, 0], [50, 0]);
    const b = straightLink('b', 'n2', 'n3', [60, 0], [100, 0]);
    const nodes = (control: Parameters<typeof node>[3]) => [node('n1', 0, 0), node('n2', 55, 0, control), node('n3', 100, 0)];
    const kind = (control: Parameters<typeof node>[3], priority?: Parameters<typeof connector>[4]) => {
      const pkg = packageOf(nodes(control), [a, b], priority ? [connector('c', 'n2', a, b, priority)] : []);
      const c = createBuildContext(pkg);
      return stopLineKind(c, c.links.get('a')!);
    };
    expect(kind('priority', 'minor')).toBe('give_way');
    expect(kind('roundabout', 'roundabout_entry')).toBe('give_way');
    expect(kind('priority', 'stop')).toBe('stop');
    expect(kind('priority', 'major')).toBeNull();
    expect(kind('all_way_stop', 'right_before_left')).toBe('stop');
    expect(kind('level_crossing')).toBe('stop');
    expect(kind('signal')).toBe('stop');
    expect(kind('right_before_left', 'right_before_left')).toBeNull();
  });

  it('paints a solid stop line across every lane and dashed give-way lines', () => {
    const a = straightLink('a', 'n1', 'n2', [0, 0], [10, 0], { width: 3.2 });
    const b = straightLink('b', 'n2', 'n3', [20, 0], [30, 0]);
    const nodes = [node('n1', 0, 0), node('n2', 15, 0, 'priority'), node('n3', 30, 0)];
    const stop = markingsOf(packageOf(nodes, [a, b], [connector('c', 'n2', a, b, 'stop')])).markings;
    const plain = markingsOf(packageOf(nodes, [a, b], [connector('c', 'n2', a, b, 'major')])).markings;
    const giveWay = markingsOf(packageOf(nodes, [a, b], [connector('c', 'n2', a, b, 'minor')])).markings;
    expect(quads(stop) - quads(plain)).toBe(1);
    expect(quads(giveWay) - quads(plain)).toBe(4); // 3.2 m lane: 0.5 m dashes every 0.8 m
  });
});

describe('turn arrows', () => {
  it('builds a shaft plus one branch and head per turn', () => {
    expect(arrowTriangles([])).toEqual([]);
    expect(arrowTriangles(['through'])).toHaveLength(2 + 3);
    expect(arrowTriangles(['left', 'through'])).toHaveLength(2 + 3 + 3);
    expect(arrowTriangles(['through', 'through'])).toHaveLength(5);
    expect(arrowTriangles(['reverse'])).toHaveLength(2 + 2 + 2 + 1);
  });

  it('points left turns to the left (+v)', () => {
    const tris = arrowTriangles(['left']);
    const maxV = Math.max(...tris.flat().map((p) => p[1]));
    const minV = Math.min(...tris.flat().map((p) => p[1]));
    expect(maxV).toBeGreaterThan(1.5);
    expect(minV).toBeGreaterThan(-0.5);
    const right = arrowTriangles(['sharp_right', 'merge_to_right']);
    expect(Math.min(...right.flat().map((p) => p[1]))).toBeLessThan(-1);
  });

  it('places one arrow near the end and a second on long lanes', () => {
    expect(arrowStations(10)).toEqual([]);
    expect(arrowStations(30)).toEqual([20]);
    expect(arrowStations(140)).toEqual([100, 130]);
  });

  it('paints arrows for marked lanes of the golden fixture', () => {
    const pkg = loadGoldenFixture();
    const withArrows = markingsOf(pkg).markings.triangleCount;
    const unmarked = structuredClone(pkg);
    unmarked.links.forEach((l) => l.lanes.forEach((ln) => (ln.turns = [])));
    const without = markingsOf(unmarked).markings.triangleCount;
    // l1 and l3: 2 lanes × 2 arrows × (shaft 2 + 2 branches × 3) triangles each.
    expect(withArrows - without).toBe(2 * 2 * 2 * 8);
  });
});

describe('tunnel markings', () => {
  it('go into the tunnel layer', () => {
    const a = straightLink('a', 'n1', 'n2', [0, 0], [50, 0], { structure: 'tunnel', z: -8, lanes: 2, roadClass: 'primary' });
    const out = markingsOf(packageOf([node('n1', 0, 0), node('n2', 50, 0)], [a]));
    expect(out.markings.triangleCount).toBe(0);
    expect(out.tunnelMarkings.triangleCount).toBeGreaterThan(0);
  });
});
