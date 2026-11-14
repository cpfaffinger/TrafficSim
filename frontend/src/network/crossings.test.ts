import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGoldenFixtureJson } from '../test/goldenFixture';
import { crossingFrame, crossingMarkings, PEDESTRIAN_STRIDE, pedestrianViews, ZEBRA_GAP, ZEBRA_STRIPE } from './crossings';
import { NetworkPackageError, parseNetworkPackage } from './parse';
import type { Crossing } from './types';

type Json = Record<string, unknown>;

/** Cross-stack contract fixture written by the backend (CrossingFixtureTests). */
const crossingsFixture = (): Json =>
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../docs/architecture/fixtures/network-package-crossings-v1.json'), 'utf8')) as Json;

const zebra: Crossing = {
  id: 'x0',
  osmId: 1,
  kind: 'zebra',
  node: null,
  signalGroup: null,
  signalMode: null,
  implicit: false,
  width: 7,
  depth: 3,
  demand: 120,
  geometry: [
    [10, -3.5, 0],
    [10, 3.5, 0],
  ],
  links: [{ link: 'l0', position: 10, span: [0, 3.5] }],
};

describe('crossings in the network package', () => {
  it('parses the compiled contract fixture with every crossing kind', () => {
    const pkg = parseNetworkPackage(crossingsFixture());
    const crossings = pkg.crossings!;
    expect(crossings).toHaveLength(7);
    expect(crossings.filter((c) => !c.implicit).map((c) => c.kind)).toEqual(['zebra', 'uncontrolled', 'signal']);
    expect(crossings.find((c) => c.osmId === 12)).toMatchObject({ signalMode: 'request', kind: 'signal' });
    expect(crossings.filter((c) => c.implicit).every((c) => c.signalMode === 'parallel' && c.signalGroup !== null)).toBe(true);
    expect(crossings[0]!.links[1]!.span).toEqual([3.5, 7]);
  });

  it('is optional, and references are checked', () => {
    expect(parseNetworkPackage(readGoldenFixtureJson()).crossings).toBeUndefined();
    const broken = crossingsFixture();
    ((broken.crossings as Json[])[0]!.links as Json[])[0]!.link = 'nope';
    expect(() => parseNetworkPackage(broken)).toThrow(NetworkPackageError);
    const kind = crossingsFixture();
    (kind.crossings as Json[])[1]!.kind = 'teleporter';
    expect(() => parseNetworkPackage(kind)).toThrow(/crossings\[1\]\.kind/);
    const group = crossingsFixture();
    (group.crossings as Json[])[2]!.signalGroup = 'n9:g9';
    expect(() => parseNetworkPackage(group)).toThrow(/unknown signal group/);
    const twice = crossingsFixture();
    (twice.crossings as Json[])[1]!.id = 'x0';
    expect(() => parseNetworkPackage(twice)).toThrow(/duplicate id/);
    const noLinks = crossingsFixture();
    (noLinks.crossings as Json[])[0]!.links = [];
    expect(() => parseNetworkPackage(noLinks)).toThrow(/at least one link/);
    expect(() => parseNetworkPackage({ ...crossingsFixture(), crossings: {} })).toThrow(/expected an array/);
    expect(parseNetworkPackage({ ...crossingsFixture(), crossings: null }).crossings).toBeUndefined();
  });
});

describe('crossing markings', () => {
  it('draws zebra stripes across the carriageway, as long as the crossing is deep', () => {
    const stripes = crossingMarkings(zebra);
    expect(stripes).toHaveLength(Math.floor(7 / (ZEBRA_STRIPE + ZEBRA_GAP)));
    expect(stripes[0]).toMatchObject({ length: 3, width: ZEBRA_STRIPE });
    expect(stripes[0]!.centre[0]).toBeCloseTo(10);
    expect(stripes[0]!.centre[1]).toBeCloseTo(-3.5 + 0.5);
    // along the road (east-west here)
    expect(Math.abs(Math.cos(stripes[0]!.angle))).toBeCloseTo(1);
  });

  it('draws dashed edge lines for signal and uncontrolled crossings, nothing when unmarked', () => {
    const edges = crossingMarkings({ ...zebra, kind: 'signal', depth: 4 });
    expect(edges.length).toBeGreaterThan(4);
    expect(new Set(edges.map((e) => e.centre[0]))).toEqual(new Set([8, 12]));
    expect(crossingMarkings({ ...zebra, kind: 'unmarked' })).toEqual([]);
    expect(crossingFrame({ ...zebra, geometry: [zebra.geometry[0], zebra.geometry[0]] }).length).toBe(7);
  });
});

describe('pedestrian snapshot', () => {
  it('places waiting pedestrians on the pavement and walkers on the crossing', () => {
    const snap = new Float32Array([
      // crossing, progress, direction, state, slot
      0, 0, 1, 0, 0,
      0, 0.5, -1, 1, 2,
      7, 0.5, 1, 1, 0, // unknown crossing: skipped
    ]);
    expect(snap.length % PEDESTRIAN_STRIDE).toBe(0);
    const views = pedestrianViews([zebra], snap);
    expect(views).toHaveLength(2);
    const [waiting, walking] = views;
    expect(waiting!.position[1]).toBeCloseTo(-3.5 - 0.6);
    expect(waiting!.state).toBe(0);
    expect(walking!.position[1]).toBeCloseTo(0);
    expect(walking!.position[0]).toBeCloseTo(10 + 0.5 * 0.6, 5); // slot 2 of a group, along the road
    expect(walking!.heading).toBeCloseTo(-Math.PI / 2);
  });
});
