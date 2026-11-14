// Test support: a four-arm junction with OSM ids, for editor tests.
//
//            N (103)  one-way southbound, way 3000 [103, 401, 100]
//               |
//  W (101) ---- J (100) ---- E (102)
//  way 1000 [101, 201, 202, 100]   way 2000 [100, 301, 102]
//  (link geometries have three points: ends and midpoint)
//               |
//            S (104)  way 4000 [100, 501, 104]
import { VEHICLE_CLASSES, type Connector, type Link, type NetworkPackage, type Vec3 } from '../network/types';
import { connector, node, packageOf, straightLink, type StraightLinkOptions } from './networkFactory';

/** Adds OSM ids and a midpoint to the reference line (each way has one node between its ends). */
function osmLink(link: Link, wayId: number, afterFrom: number, beforeTo: number): Link {
  const [a, b] = [link.geometry[0]!, link.geometry.at(-1)!];
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const lanes = link.lanes.map((l) => ({ ...l, allowed: [...VEHICLE_CLASSES] }));
  return { ...link, lanes, geometry: [a, mid, b], osmWayId: wayId, osmAfterFrom: afterFrom, osmBeforeTo: beforeTo };
}

function move(id: string, nodeId: string, from: Link, fromLane: number, to: Link, toLane: number, turn: Connector['turn']): Connector {
  return { ...connector(id, nodeId, from, to), fromLane, toLane, turn };
}

export interface EditorNetworkOptions {
  signalised?: boolean;
}

export function editorNetwork(o: EditorNetworkOptions = {}): NetworkPackage {
  const two = (opposite: string, extra: StraightLinkOptions = {}): StraightLinkOptions => ({
    twoWay: true,
    oppositeLink: opposite,
    roadClass: 'secondary',
    leftEdge: 'centre_dashed',
    ...extra,
  });
  // Way 1000 has two nodes between its ends.
  const l0 = osmLink(straightLink('l0', 'n1', 'n0', [-100, 0], [0, 0], two('l1', { lanes: 2, turns: [['through', 'right'], ['through']] })), 1000, 201, 202);
  const l1 = osmLink(straightLink('l1', 'n0', 'n1', [0, 0], [-100, 0], two('l0', { lanes: 2 })), 1000, 202, 201);
  const l2 = osmLink(straightLink('l2', 'n0', 'n2', [0, 0], [100, 0], two('l3', { lanes: 2 })), 2000, 301, 301);
  const l3 = osmLink(straightLink('l3', 'n2', 'n0', [100, 0], [0, 0], two('l2', { lanes: 2 })), 2000, 301, 301);
  const l4 = osmLink(straightLink('l4', 'n3', 'n0', [0, 100], [0, 0], { lanes: 1, roadClass: 'residential' }), 3000, 401, 401);
  const l5 = osmLink(straightLink('l5', 'n0', 'n4', [0, 0], [0, -100], two('l6', { lanes: 1, roadClass: 'tertiary' })), 4000, 501, 501);
  const l6 = osmLink(straightLink('l6', 'n4', 'n0', [0, -100], [0, 0], two('l5', { lanes: 1, roadClass: 'tertiary' })), 4000, 501, 501);
  const links = [l0, l1, l2, l3, l4, l5, l6];

  const control = o.signalised ? 'signal' : 'priority';
  const nodes = [
    { ...node('n0', 0, 0, control), osmId: 100 },
    { ...node('n1', -100, 0, 'boundary'), osmId: 101 },
    { ...node('n2', 100, 0, 'boundary'), osmId: 102 },
    { ...node('n3', 0, 100, 'boundary'), osmId: 103 },
    { ...node('n4', 0, -100, 'boundary'), osmId: 104 },
  ];
  const connectors = [
    move('c0', 'n0', l0, 0, l2, 0, 'through'),
    move('c1', 'n0', l0, 1, l2, 1, 'through'),
    move('c2', 'n0', l0, 0, l5, 0, 'right'),
    move('c3', 'n0', l3, 0, l1, 0, 'through'),
    move('c4', 'n0', l3, 1, l1, 1, 'through'),
    move('c5', 'n0', l3, 1, l5, 0, 'left'),
    move('c6', 'n0', l4, 0, l1, 0, 'right'),
    move('c7', 'n0', l4, 0, l2, 1, 'left'),
    move('c8', 'n0', l4, 0, l5, 0, 'through'),
    move('c9', 'n0', l6, 0, l2, 0, 'right'),
    move('c10', 'n0', l6, 0, l1, 1, 'left'),
  ];
  const pkg = packageOf(nodes, links, connectors);
  if (o.signalised) {
    const group = (c: Connector) => (c.fromLink === 'l0' || c.fromLink === 'l3' ? 'n0:g0' : 'n0:g1');
    pkg.connectors = connectors.map((c) => ({ ...c, priority: 'signal', signalGroup: group(c) }));
    pkg.signals = [
      {
        node: 'n0',
        cycle: 90,
        offset: 0,
        groups: [
          { id: 'n0:g0', green: [[0, 40]], amber: 3 },
          { id: 'n0:g1', green: [[45, 85]], amber: 3 },
        ],
      },
    ];
  }
  return pkg;
}
