// Generates the synthetic golden fixture network-package-v1.json (format spec: ../network-package.md).
// Scenario: a signalised cross junction (main road E-W, 2 lanes per direction, side road N-S, 1 lane per
// direction) and a one-way motorway bridge pair crossing over the side road without a shared node.
// Run: node docs/architecture/fixtures/generate-synthetic.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const round = (v) => Math.round(v * 1000) / 1000;
const pt = (x, y, z = 0) => [round(x), round(y), round(z)];
const len = (g) => round(g.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - g[i][0], p[1] - g[i][1], p[2] - g[i][2]), 0));
const ALL = ['car', 'van', 'truck', 'bus', 'motorcycle'];
const W = 3.25;
const TRIM = 10; // junction radius

const nodes = [];
const links = [];
const connectors = [];
const node = (id, osmId, x, y, control, z = 0) => nodes.push({ id, osmId, x, y, z, control });

node('n0', 1, 0, 0, 'signal');
node('n1', 2, -150, 0, 'boundary');
node('n2', 3, 150, 0, 'boundary');
node('n3', 4, 0, 150, 'boundary');
node('n4', 5, 0, -150, 'boundary');
node('n5', 6, -150, 60, 'boundary');
node('n6', 7, 150, 60, 'boundary');
node('n7', 8, 150, 75, 'boundary');
node('n8', 9, -150, 75, 'boundary');

// Unit direction helpers for straight links.
function straightLink({ id, way, from, to, a, b, lanes, cls, name, opposite, speed, trimStart, trimEnd, layer = 0, structure = 'none',
  turns = [], leftEdge, boundaries, z = 0, gap = 0 }) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  const ux = dx / L, uy = dy / L;
  const rx = uy, ry = -ux; // right-hand normal
  const s = [a[0] + ux * trimStart, a[1] + uy * trimStart];
  const e = [b[0] - ux * trimEnd, b[1] - uy * trimEnd];
  // A two-way road's lanes start at the way centreline; a one-way road is centred on it.
  const centreOffset = opposite ? gap : -(lanes * W) / 2;
  const laneList = Array.from({ length: lanes }, (_, i) => {
    const off = centreOffset + (lanes - 1 - i + 0.5) * W;
    const g = [pt(s[0] + rx * off, s[1] + ry * off, z), pt(e[0] + rx * off, e[1] + ry * off, z)];
    return { id: `${id}:${i}`, index: i, width: W, speedLimit: speed, allowed: ALL, turns: turns[i] ?? [], geometry: g, length: len(g) };
  });
  const geometry = [pt(s[0], s[1], z), pt(e[0], e[1], z)];
  links.push({
    id, osmWayId: way, from, to, roadClass: cls, name, layer, structure, roundabout: false, oppositeLink: opposite ?? null,
    throughTraffic: true, length: len(geometry), speedLimit: speed, geometry, lanes: laneList,
    boundaries: boundaries ?? laneList.slice(1).map((_, i) => ({ rightLane: i, leftLane: i + 1, marking: 'dashed', allowLeft: true, allowRight: true })),
    leftEdge, noLaneChangeZone: to === 'n0' ? 30 : 0, assumed: ['width'],
  });
}

const v50 = 13.889, v30 = 8.333, v100 = 27.778;
// Main road (way 101): eastbound l1 n1->n0, l2 n0->n2; westbound l3 n2->n0, l4 n0->n1.
straightLink({ id: 'l1', way: 101, from: 'n1', to: 'n0', a: [-150, 0], b: [0, 0], lanes: 2, cls: 'primary', name: 'Main Street', opposite: 'l4', speed: v50, trimStart: 0, trimEnd: TRIM, turns: [['through', 'right'], ['left', 'through']], leftEdge: 'centre_solid' });
straightLink({ id: 'l2', way: 102, from: 'n0', to: 'n2', a: [0, 0], b: [150, 0], lanes: 2, cls: 'primary', name: 'Main Street', opposite: 'l3', speed: v50, trimStart: TRIM, trimEnd: 0, leftEdge: 'centre_dashed' });
straightLink({ id: 'l3', way: 102, from: 'n2', to: 'n0', a: [150, 0], b: [0, 0], lanes: 2, cls: 'primary', name: 'Main Street', opposite: 'l2', speed: v50, trimStart: 0, trimEnd: TRIM, turns: [['through', 'right'], ['left', 'through']], leftEdge: 'centre_solid',
  boundaries: [{ rightLane: 0, leftLane: 1, marking: 'solid_dashed', allowLeft: true, allowRight: false }] });
straightLink({ id: 'l4', way: 101, from: 'n0', to: 'n1', a: [0, 0], b: [-150, 0], lanes: 2, cls: 'primary', name: 'Main Street', opposite: 'l1', speed: v50, trimStart: TRIM, trimEnd: 0, leftEdge: 'centre_dashed' });
// Side road (ways 103/104): southbound l5 n3->n0, l6 n0->n4; northbound l7 n4->n0, l8 n0->n3.
straightLink({ id: 'l5', way: 103, from: 'n3', to: 'n0', a: [0, 150], b: [0, 0], lanes: 1, cls: 'residential', name: 'Side Street', opposite: 'l8', speed: v30, trimStart: 0, trimEnd: TRIM, leftEdge: 'centre_dashed' });
straightLink({ id: 'l6', way: 104, from: 'n0', to: 'n4', a: [0, 0], b: [0, -150], lanes: 1, cls: 'residential', name: 'Side Street', opposite: 'l7', speed: v30, trimStart: TRIM, trimEnd: 0, leftEdge: 'centre_dashed' });
straightLink({ id: 'l7', way: 104, from: 'n4', to: 'n0', a: [0, -150], b: [0, 0], lanes: 1, cls: 'residential', name: 'Side Street', opposite: 'l6', speed: v30, trimStart: 0, trimEnd: TRIM, leftEdge: 'centre_dashed' });
straightLink({ id: 'l8', way: 103, from: 'n0', to: 'n3', a: [0, 0], b: [0, 150], lanes: 1, cls: 'residential', name: 'Side Street', opposite: 'l5', speed: v30, trimStart: TRIM, trimEnd: 0, leftEdge: 'centre_dashed' });
// Motorway bridge over the side road (layer 1, no shared node with ways 103/104).
straightLink({ id: 'l9', way: 105, from: 'n5', to: 'n6', a: [-150, 60], b: [150, 60], lanes: 2, cls: 'motorway', name: 'A1', speed: v100, trimStart: 0, trimEnd: 0, layer: 1, structure: 'bridge', z: 6, leftEdge: 'edge' });
straightLink({ id: 'l10', way: 106, from: 'n7', to: 'n8', a: [150, 75], b: [-150, 75], lanes: 2, cls: 'motorway', name: 'A1', speed: v100, trimStart: 0, trimEnd: 0, layer: 1, structure: 'bridge', z: 6, leftEdge: 'edge' });
for (const id of ['l9', 'l10']) {
  const l = links.find((x) => x.id === id);
  const n = nodes.filter((x) => x.id === l.from || x.id === l.to);
  n.forEach((x) => { x.z = 6; });
}

// Connectors at n0: cubic Bezier from lane end to lane start.
function bezier(p0, d0, p3, d3) {
  const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / 3;
  const p1 = [p0[0] + d0[0] * dist, p0[1] + d0[1] * dist];
  const p2 = [p3[0] - d3[0] * dist, p3[1] - d3[1] * dist];
  const out = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, m = 1 - t;
    out.push(pt(m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0],
      m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1]));
  }
  return out;
}
const dir = (g, atEnd) => {
  const [a, b] = atEnd ? [g[g.length - 2], g[g.length - 1]] : [g[0], g[1]];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
};
function turnOf(din, dout) {
  const cross = din[0] * dout[1] - din[1] * dout[0];
  const dot = din[0] * dout[0] + din[1] * dout[1];
  const angle = Math.atan2(cross, dot) * 180 / Math.PI; // + = left
  if (Math.abs(angle) <= 30) return 'through';
  if (Math.abs(angle) > 150) return 'reverse';
  return angle > 0 ? 'left' : 'right';
}
const group = { l1: 'n0:g0', l3: 'n0:g0', l5: 'n0:g1', l7: 'n0:g1' };
let cid = 0;
for (const inId of ['l1', 'l3', 'l5', 'l7']) {
  const lin = links.find((l) => l.id === inId);
  for (const outId of ['l2', 'l4', 'l6', 'l8']) {
    if (lin.oppositeLink === outId) continue;
    const lout = links.find((l) => l.id === outId);
    const turn = turnOf(dir(lin.geometry, true), dir(lout.geometry, false));
    const sources = lin.lanes.length === 1 ? [0] : lin.lanes.filter((ln) => ln.turns.includes(turn)).map((ln) => ln.index);
    for (const fromLane of sources) {
      const toLane = turn === 'right' ? 0 : turn === 'left' ? lout.lanes.length - 1 : Math.min(fromLane, lout.lanes.length - 1);
      const a = lin.lanes[fromLane].geometry, b = lout.lanes[toLane].geometry;
      const g = bezier(a[a.length - 1], dir(a, true), b[0], dir(b, false));
      connectors.push({ id: `c${cid++}`, node: 'n0', fromLink: inId, fromLane, toLink: outId, toLane, turn, priority: 'signal',
        signalGroup: group[inId], geometry: g, length: len(g), conflicts: [] });
    }
  }
}
// Conflicts: crossing polylines or same target lane.
const segX = (p, q, r, s) => {
  const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
  const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
};
const crosses = (g, h) => g.slice(1).some((q, i) => h.slice(1).some((s, j) => segX(g[i], q, h[j], s)));
for (const a of connectors) {
  for (const b of connectors) {
    if (a === b || a.fromLink === b.fromLink && a.fromLane === b.fromLane) continue;
    if ((a.toLink === b.toLink && a.toLane === b.toLane) || crosses(a.geometry, b.geometry)) a.conflicts.push(b.id);
  }
}

const pkg = {
  formatVersion: 1,
  baselineId: null,
  origin: { lat: 48.2082, lon: 16.3738 },
  bbox: [16.3718, 48.2068, 16.3758, 48.2096],
  osmTimestamp: '2026-11-14T10:00:00Z',
  attribution: ['© OpenStreetMap contributors (ODbL)'],
  nodes,
  links,
  connectors,
  signals: [{ node: 'n0', cycle: 90, offset: 0, groups: [{ id: 'n0:g0', green: [[0, 40]], amber: 3 }, { id: 'n0:g1', green: [[45, 85]], amber: 3 }] }],
  stats: { nodes: nodes.length, links: links.length, lanes: links.reduce((s, l) => s + l.lanes.length, 0), connectors: connectors.length, signals: 1 },
};
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'network-package-v1.json');
fs.writeFileSync(out, JSON.stringify(pkg, null, 1) + '\n');
console.log('wrote', out, pkg.stats);
