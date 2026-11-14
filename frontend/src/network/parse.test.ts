import { describe, expect, it } from 'vitest';
import { readGoldenFixtureJson } from '../test/goldenFixture';
import { NetworkPackageError, parseNetworkPackage } from './parse';

type Json = Record<string, unknown>;
const fixture = () => structuredClone(readGoldenFixtureJson()) as Json;
const links = (pkg: Json) => pkg.links as Json[];

describe('parseNetworkPackage — golden fixture contract', () => {
  const pkg = parseNetworkPackage(readGoldenFixtureJson());

  it('reads the top level', () => {
    expect(pkg.formatVersion).toBe(1);
    expect(pkg.origin).toEqual({ lat: 48.2082, lon: 16.3738 });
    expect(pkg.bbox).toEqual([16.3718, 48.2068, 16.3758, 48.2096]);
    expect(pkg.attribution).toContain('© OpenStreetMap contributors (ODbL)');
    expect(pkg.stats).toEqual({ nodes: 9, links: 10, lanes: 16, connectors: pkg.connectors.length, signals: 1 });
  });

  it('reads the signalised cross junction', () => {
    const n0 = pkg.nodes.find((n) => n.id === 'n0');
    expect(n0?.control).toBe('signal');
    const l1 = pkg.links.find((l) => l.id === 'l1')!;
    expect(l1).toMatchObject({ from: 'n1', to: 'n0', roadClass: 'primary', name: 'Main Street', oppositeLink: 'l4' });
    expect(l1.lanes.map((l) => l.turns)).toEqual([
      ['through', 'right'],
      ['left', 'through'],
    ]);
    expect(l1.lanes[0]!.geometry[0]).toEqual([-150, -4.875, 0]);
    expect(l1.noLaneChangeZone).toBe(30);
    expect(pkg.links.find((l) => l.id === 'l3')!.boundaries[0]!.marking).toBe('solid_dashed');
    expect(pkg.signals[0]!.groups.map((g) => g.id)).toEqual(['n0:g0', 'n0:g1']);
    expect(pkg.connectors.every((c) => c.node === 'n0' && c.priority === 'signal')).toBe(true);
  });

  it('reads the motorway bridge pair', () => {
    const bridges = pkg.links.filter((l) => l.structure === 'bridge');
    expect(bridges.map((l) => l.id)).toEqual(['l9', 'l10']);
    expect(bridges.every((l) => l.layer === 1 && l.leftEdge === 'edge' && l.geometry[0]![2] === 6)).toBe(true);
  });
});

describe('parseNetworkPackage — validation', () => {
  const expectError = (pkg: unknown, path: string) => {
    let error: unknown;
    try {
      parseNetworkPackage(pkg);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NetworkPackageError);
    expect((error as NetworkPackageError).path).toBe(path);
  };

  it('rejects non-objects and other format versions', () => {
    expectError(null, '$');
    expectError([], '$');
    expectError({ ...fixture(), formatVersion: 2 }, 'formatVersion');
  });

  it('rejects an invalid origin and bbox', () => {
    expectError({ ...fixture(), origin: { lat: 91, lon: 0 } }, 'origin.lat');
    expectError({ ...fixture(), origin: { lat: 0, lon: 'x' } }, 'origin.lon');
    expectError({ ...fixture(), bbox: [1, 2, 0, 3] }, 'bbox');
    expectError({ ...fixture(), bbox: [1, 2, 3] }, 'bbox');
  });

  it('rejects unknown enum values with a precise path', () => {
    const pkg = fixture();
    links(pkg)[2]!.roadClass = 'highway';
    expectError(pkg, 'links[2].roadClass');
  });

  it('rejects malformed geometry', () => {
    const pkg = fixture();
    (links(pkg)[0]!.lanes as Json[])[1]!.geometry = [[0, 0, 0]];
    expectError(pkg, 'links[0].lanes[1].geometry');
    const pkg2 = fixture();
    links(pkg2)[0]!.geometry = [[0, 0], [1, 1]];
    expectError(pkg2, 'links[0].geometry[0]');
  });

  it('rejects inconsistent lanes and boundaries', () => {
    const pkg = fixture();
    links(pkg)[0]!.boundaries = [];
    expectError(pkg, 'links[0].boundaries');
    const pkg2 = fixture();
    (links(pkg2)[0]!.lanes as Json[]).reverse();
    expectError(pkg2, 'links[0].lanes[0].index');
    const pkg3 = fixture();
    links(pkg3)[0]!.lanes = [];
    expectError(pkg3, 'links[0].lanes');
    const pkg4 = fixture();
    (links(pkg4)[0]!.boundaries as Json[])[0]!.leftLane = 3;
    expectError(pkg4, 'links[0].boundaries[0]');
    const pkg5 = fixture();
    (links(pkg5)[0]!.lanes as Json[])[0]!.width = 0;
    expectError(pkg5, 'links[0].lanes[0].width');
  });

  it('rejects dangling references and duplicate ids', () => {
    const pkg = fixture();
    links(pkg)[0]!.to = 'n99';
    expectError(pkg, 'links[0].to');
    const pkg2 = fixture();
    (pkg2.connectors as Json[])[0]!.fromLane = 7;
    expectError(pkg2, 'connectors[0].fromLane');
    const pkg3 = fixture();
    (pkg3.connectors as Json[])[0]!.conflicts = ['c999'];
    expectError(pkg3, 'connectors[0].conflicts[0]');
    const pkg4 = fixture();
    links(pkg4)[1]!.id = 'l1';
    expectError(pkg4, 'links[1].id');
    const pkg5 = fixture();
    (pkg5.connectors as Json[])[0]!.signalGroup = 'nope';
    expectError(pkg5, 'connectors[0].signalGroup');
    const pkg6 = fixture();
    (pkg6.connectors as Json[])[0]!.toLink = 'l77';
    expectError(pkg6, 'connectors[0].toLink');
    const pkg7 = fixture();
    links(pkg7)[0]!.oppositeLink = 'l77';
    expectError(pkg7, 'links[0].oppositeLink');
  });

  it('rejects invalid signal plans', () => {
    const pkg = fixture();
    const signals = pkg.signals as Json[];
    ((signals[0]!.groups as Json[])[0]!.green as number[][])[0] = [0, 120];
    expectError(pkg, 'signals[0].groups[0].green[0]');
    const pkg2 = fixture();
    (pkg2.signals as Json[])[0]!.cycle = 0;
    expectError(pkg2, 'signals[0].cycle');
    const pkg3 = fixture();
    ((pkg3.signals as Json[])[0]!.groups as Json[])[0]!.green = [[40, 10]];
    expectError(pkg3, 'signals[0].groups[0].green[0]');
  });

  it('ignores unknown keys, applies defaults and computes missing stats', () => {
    const pkg = fixture();
    pkg.futureKey = { anything: true };
    delete pkg.stats;
    delete pkg.signals;
    const l = links(pkg)[0]!;
    delete l.layer;
    delete l.structure;
    delete l.assumed;
    (pkg.connectors as Json[]).forEach((c) => (c.signalGroup = null));
    const parsed = parseNetworkPackage(pkg);
    expect(parsed.stats).toEqual({ nodes: 9, links: 10, lanes: 16, connectors: parsed.connectors.length, signals: 0 });
    expect(parsed.links[0]).toMatchObject({ layer: 0, structure: 'none', assumed: [], osmAfterFrom: null, osmBeforeTo: null });
    expect('futureKey' in parsed).toBe(false);
  });

  it('reads the OSM neighbour nodes that key movements for edits', () => {
    const pkg = fixture();
    Object.assign(links(pkg)[0]!, { osmAfterFrom: 1001, osmBeforeTo: 1002 });
    expect(parseNetworkPackage(pkg).links[0]).toMatchObject({ osmAfterFrom: 1001, osmBeforeTo: 1002 });
    links(pkg)[0]!.osmBeforeTo = 'x';
    expectError(pkg, 'links[0].osmBeforeTo');
  });
});
