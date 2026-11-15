//! Synthetic networks for tests, benchmarks and the batch runner: the golden fixture and a
//! builder for small networks that follow the network package v1 spec (straight lanes, Bézier
//! connectors, explicit conflicts).

use crate::network::Network;
use crate::package::{
    Boundary, Connector, Lane, Link, Node, NodeControl, Package, Point, Priority, RoadClass,
    SignalController, SignalGroup, Turn, VehicleClassDto,
};

pub const FIXTURE: &str = include_str!("../../docs/architecture/fixtures/network-package-v1.json");

/// Corridor with one bus line, a kerb stop and a bay stop (#85).
pub const TRANSIT_FIXTURE: &str =
    include_str!("../../docs/architecture/fixtures/network-package-transit-v1.json");

pub fn fixture_package() -> Package {
    Package::from_json(FIXTURE).unwrap()
}

pub fn fixture_network() -> Network {
    Network::from_package(&fixture_package()).unwrap()
}

const LANE_WIDTH: f64 = 3.25;
const ALL: [VehicleClassDto; 5] = [
    VehicleClassDto::Car,
    VehicleClassDto::Van,
    VehicleClassDto::Truck,
    VehicleClassDto::Bus,
    VehicleClassDto::Motorcycle,
];

/// Builds packages programmatically. Links are straight between their nodes, trimmed by `trim`
/// metres at nodes that are neither boundaries nor plain joints, with lanes to the right of the
/// reference line (right-hand traffic, lane 0 = rightmost).
pub struct NetBuilder {
    pub package: Package,
    pub trim: f64,
}

impl Default for NetBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl NetBuilder {
    pub fn new() -> Self {
        Self {
            package: Package {
                format_version: 1,
                nodes: Vec::new(),
                links: Vec::new(),
                connectors: Vec::new(),
                signals: Vec::new(),
                transit_lines: Vec::new(),
                crossings: None,
            },
            trim: 8.0,
        }
    }

    pub fn node(&mut self, id: &str, x: f64, y: f64, control: NodeControl) -> &mut Self {
        self.package.nodes.push(Node {
            id: id.into(),
            x,
            y,
            z: 0.0,
            control,
        });
        self
    }

    fn node_pos(&self, id: &str) -> (Point, NodeControl) {
        let n = self
            .package
            .nodes
            .iter()
            .find(|n| n.id == id)
            .expect("unknown node");
        ([n.x, n.y, n.z], n.control)
    }

    fn trim_at(&self, control: NodeControl) -> f64 {
        match control {
            NodeControl::Boundary | NodeControl::None => 0.0,
            _ => self.trim,
        }
    }

    pub fn link(&mut self, id: &str, from: &str, to: &str, lanes: u32, speed: f64) -> &mut Self {
        let (a, ca) = self.node_pos(from);
        let (b, cb) = self.node_pos(to);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len = (dx * dx + dy * dy).sqrt();
        let (ux, uy) = (dx / len, dy / len);
        let (rx, ry) = (uy, -ux);
        let (t0, t1) = (self.trim_at(ca), self.trim_at(cb));
        let s = [a[0] + ux * t0, a[1] + uy * t0, 0.0];
        let e = [b[0] - ux * t1, b[1] - uy * t1, 0.0];
        let length = len - t0 - t1;
        let lane_list = (0..lanes)
            .map(|i| {
                let off = (f64::from(lanes - 1 - i) + 0.5) * LANE_WIDTH;
                Lane {
                    index: i,
                    width: LANE_WIDTH,
                    speed_limit: speed,
                    allowed: ALL.to_vec(),
                    geometry: vec![
                        [s[0] + rx * off, s[1] + ry * off, 0.0],
                        [e[0] + rx * off, e[1] + ry * off, 0.0],
                    ],
                    length,
                }
            })
            .collect();
        self.package.links.push(Link {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            road_class: RoadClass::Primary,
            layer: 0,
            roundabout: false,
            through_traffic: true,
            length,
            speed_limit: speed,
            geometry: vec![s, e],
            lanes: lane_list,
            boundaries: (1..lanes)
                .map(|i| Boundary {
                    right_lane: i - 1,
                    left_lane: i,
                    allow_left: true,
                    allow_right: true,
                })
                .collect(),
            no_lane_change_zone: 0.0,
            limits: None,
        });
        self
    }

    pub fn link_mut(&mut self, id: &str) -> &mut Link {
        self.package
            .links
            .iter_mut()
            .find(|l| l.id == id)
            .expect("unknown link")
    }

    pub fn connector_mut(&mut self, id: &str) -> &mut Connector {
        self.package
            .connectors
            .iter_mut()
            .find(|c| c.id == id)
            .expect("unknown connector")
    }

    /// Vehicle dimension limits of a link (#125).
    pub fn limits(&mut self, link: &str, limits: crate::package::Limits) -> &mut Self {
        let l = self
            .package
            .links
            .iter_mut()
            .find(|l| l.id == link)
            .expect("unknown link");
        l.limits = Some(limits);
        self
    }

    /// Connector from `from:from_lane` to `to:to_lane` at the node between them, shaped as a
    /// quadratic Bézier with the node as control point.
    pub fn connect(
        &mut self,
        id: &str,
        from: &str,
        from_lane: u32,
        to: &str,
        to_lane: u32,
        priority: Priority,
    ) -> &mut Self {
        let fl = self
            .package
            .links
            .iter()
            .find(|l| l.id == from)
            .expect("unknown link");
        let tl = self
            .package
            .links
            .iter()
            .find(|l| l.id == to)
            .expect("unknown link");
        assert_eq!(fl.to, tl.from, "connector must join consecutive links");
        let node = fl.to.clone();
        let (np, _) = self.node_pos(&node);
        let fg = &fl.lanes[from_lane as usize].geometry;
        let p0 = fg[fg.len() - 1];
        let din = unit(&fg[fg.len() - 2], &p0);
        let tg = &tl.lanes[to_lane as usize].geometry;
        let p2 = tg[0];
        let dout = unit(&p2, &tg[1]);
        let geometry: Vec<Point> = (0..=8)
            .map(|i| {
                let t = f64::from(i) / 8.0;
                let m = 1.0 - t;
                [
                    m * m * p0[0] + 2.0 * m * t * np[0] + t * t * p2[0],
                    m * m * p0[1] + 2.0 * m * t * np[1] + t * t * p2[1],
                    0.0,
                ]
            })
            .collect();
        let length = geometry
            .windows(2)
            .map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt())
            .sum::<f64>();
        let dot = din[0] * dout[0] + din[1] * dout[1];
        let cross = din[0] * dout[1] - din[1] * dout[0];
        let turn = if dot > 0.866 {
            Turn::Through
        } else if dot < -0.866 {
            Turn::Reverse
        } else if cross > 0.0 {
            Turn::Left
        } else {
            Turn::Right
        };
        self.package.connectors.push(Connector {
            id: id.into(),
            node,
            from_link: from.into(),
            from_lane,
            to_link: to.into(),
            to_lane,
            turn,
            priority,
            signal_group: None,
            geometry,
            length: length.max(0.5),
            conflicts: Vec::new(),
        });
        self
    }

    pub fn conflict(&mut self, a: &str, b: &str) -> &mut Self {
        self.connector_mut(a).conflicts.push(b.into());
        self
    }

    pub fn signal(&mut self, node: &str, cycle: f64, groups: &[(&str, f64, f64, f64)]) -> &mut Self {
        self.package.signals.push(SignalController {
            node: node.into(),
            cycle,
            offset: 0.0,
            groups: groups
                .iter()
                .map(|&(id, start, end, amber)| SignalGroup {
                    id: id.into(),
                    green: vec![[start, end]],
                    amber,
                })
                .collect(),
        });
        self
    }

    /// Derives conflicts at `node` like the fixture generator: connectors whose paths cross or
    /// that merge into the same lane (pairs from the same incoming lane never conflict).
    pub fn auto_conflicts(&mut self, node: &str) -> &mut Self {
        let ids: Vec<usize> = (0..self.package.connectors.len())
            .filter(|&i| self.package.connectors[i].node == node)
            .collect();
        for &a in &ids {
            for &b in &ids {
                let (ca, cb) = (&self.package.connectors[a], &self.package.connectors[b]);
                if a == b || (ca.from_link == cb.from_link && ca.from_lane == cb.from_lane) {
                    continue;
                }
                let merge = ca.to_link == cb.to_link && ca.to_lane == cb.to_lane;
                if merge || crosses(&ca.geometry, &cb.geometry) {
                    let id = cb.id.clone();
                    self.package.connectors[a].conflicts.push(id);
                }
            }
        }
        self
    }

    pub fn build(&self) -> Package {
        self.package.clone()
    }

    pub fn network(&self) -> Network {
        Network::from_package(&self.package).unwrap()
    }
}

fn segments_cross(p: &Point, q: &Point, r: &Point, s: &Point) -> bool {
    let d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
    if d.abs() < 1e-12 {
        return false;
    }
    let t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
    let u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
    t > 1e-6 && t < 1.0 - 1e-6 && u > 1e-6 && u < 1.0 - 1e-6
}

fn crosses(g: &[Point], h: &[Point]) -> bool {
    g.windows(2)
        .any(|a| h.windows(2).any(|b| segments_cross(&a[0], &a[1], &b[0], &b[1])))
}

/// Four-arm crossroads C with single-lane two-way arms of 250 m (W, E, N, S). East-west
/// approaches get `ew`, north-south approaches `ns`; conflicts are derived geometrically.
pub fn crossroads(control: NodeControl, ew: Priority, ns: Priority) -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("C", 0.0, 0.0, control);
    let arms = [
        ("W", -250.0, 0.0),
        ("E", 250.0, 0.0),
        ("N", 0.0, 250.0),
        ("S", 0.0, -250.0),
    ];
    for (id, x, y) in arms {
        b.node(id, x, y, NodeControl::Boundary);
        b.link(&format!("{id}in"), id, "C", 1, 13.889);
        b.link(&format!("{id}out"), "C", id, 1, 13.889);
    }
    for (from, _, _) in arms {
        for (to, _, _) in arms {
            if from != to {
                let p = if from == "W" || from == "E" { ew } else { ns };
                b.connect(
                    &format!("{from}{to}"),
                    &format!("{from}in"),
                    0,
                    &format!("{to}out"),
                    0,
                    p,
                );
            }
        }
    }
    b.auto_conflicts("C");
    b
}

/// `n × n` grid of priority junctions (spacing 250 m) with two-way links of `lanes` lanes,
/// boundary nodes around it. East-west movements are major, north-south minor.
pub fn grid(n: usize, lanes: u32) -> NetBuilder {
    grid_with_spacing(n, lanes, 250.0)
}

/// [`grid`] with junctions `s` metres apart (short blocks as in an old town centre, #116).
pub fn grid_with_spacing(n: usize, lanes: u32, s: f64) -> NetBuilder {
    let mut b = NetBuilder::new();
    let id = |i: i64, j: i64| format!("g{i}_{j}");
    for i in -1..=n as i64 {
        for j in -1..=n as i64 {
            let inside = (0..n as i64).contains(&i) && (0..n as i64).contains(&j);
            let edge = (inside_axis(i, n) && (j == -1 || j == n as i64))
                || (inside_axis(j, n) && (i == -1 || i == n as i64));
            if inside {
                b.node(&id(i, j), i as f64 * s, j as f64 * s, NodeControl::Priority);
            } else if edge {
                b.node(&id(i, j), i as f64 * s, j as f64 * s, NodeControl::Boundary);
            }
        }
    }
    let exists = |b: &NetBuilder, i: i64, j: i64| b.package.nodes.iter().any(|x| x.id == id(i, j));
    for i in -1..=n as i64 {
        for j in -1..=n as i64 {
            for (di, dj) in [(1, 0), (0, 1)] {
                let (a, c) = ((i, j), (i + di, j + dj));
                let boundary_pair = !inside_axis(a.0, n) && !inside_axis(c.0, n)
                    || !inside_axis(a.1, n) && !inside_axis(c.1, n);
                if exists(&b, a.0, a.1) && exists(&b, c.0, c.1) && !boundary_pair {
                    b.link(
                        &format!("{}>{}", id(a.0, a.1), id(c.0, c.1)),
                        &id(a.0, a.1),
                        &id(c.0, c.1),
                        lanes,
                        13.889,
                    );
                    b.link(
                        &format!("{}>{}", id(c.0, c.1), id(a.0, a.1)),
                        &id(c.0, c.1),
                        &id(a.0, a.1),
                        lanes,
                        13.889,
                    );
                }
            }
        }
    }
    let links: Vec<(String, String, String)> = b
        .package
        .links
        .iter()
        .map(|l| (l.id.clone(), l.from.clone(), l.to.clone()))
        .collect();
    let mut k = 0;
    for i in 0..n as i64 {
        for j in 0..n as i64 {
            let node = id(i, j);
            for (lin, from, _) in links.iter().filter(|(_, _, to)| *to == node) {
                let east_west = b.package.nodes.iter().find(|x| x.id == *from).unwrap().y == j as f64 * s;
                let priority = if east_west {
                    Priority::Major
                } else {
                    Priority::Minor
                };
                for (lout, _, to) in links.iter().filter(|(_, f, _)| *f == node) {
                    if to == from {
                        continue;
                    }
                    let ld = (
                        b.package
                            .links
                            .iter()
                            .find(|l| l.id == *lin)
                            .unwrap()
                            .geometry
                            .clone(),
                        b.package
                            .links
                            .iter()
                            .find(|l| l.id == *lout)
                            .unwrap()
                            .geometry
                            .clone(),
                    );
                    let din = unit(&ld.0[0], &ld.0[1]);
                    let dout = unit(&ld.1[0], &ld.1[1]);
                    let cross = din[0] * dout[1] - din[1] * dout[0];
                    let dot = din[0] * dout[0] + din[1] * dout[1];
                    let pairs: Vec<(u32, u32)> = if dot > 0.5 {
                        (0..lanes).map(|l| (l, l)).collect()
                    } else if cross > 0.0 {
                        vec![(lanes - 1, lanes - 1)]
                    } else {
                        vec![(0, 0)]
                    };
                    for (fl, tl) in pairs {
                        b.connect(&format!("k{k}"), lin, fl, lout, tl, priority);
                        k += 1;
                    }
                }
            }
            b.auto_conflicts(&node);
        }
    }
    b
}

fn inside_axis(i: i64, n: usize) -> bool {
    (0..n as i64).contains(&i)
}

/// [`grid`] with every junction signalised (90 s cycle, east-west green 0–42 s, north-south
/// 45–87 s, 3 s amber, offsets for a green wave towards the east): a city benchmark network.
pub fn signal_grid(n: usize, lanes: u32) -> NetBuilder {
    let mut b = grid(n, lanes);
    let junctions: Vec<(String, f64)> = b
        .package
        .nodes
        .iter_mut()
        .filter(|node| node.control == NodeControl::Priority)
        .map(|node| {
            node.control = NodeControl::Signal;
            (node.id.clone(), node.x)
        })
        .collect();
    for (node, x) in junctions {
        b.package.signals.push(SignalController {
            node: node.clone(),
            cycle: 90.0,
            offset: (x / 13.889).rem_euclid(90.0),
            groups: [("ew", 0.0, 42.0), ("ns", 45.0, 87.0)]
                .iter()
                .map(|&(g, start, end)| SignalGroup {
                    id: format!("{node}:{g}"),
                    green: vec![[start, end]],
                    amber: 3.0,
                })
                .collect(),
        });
        for c in b.package.connectors.iter_mut().filter(|c| c.node == node) {
            let group = if c.priority == Priority::Major { "ew" } else { "ns" };
            c.priority = Priority::Signal;
            c.signal_group = Some(format!("{node}:{group}"));
        }
    }
    b
}

/// A motorway of `units` weaving units: two-lane mainline (1000 m) followed by a 300 m section
/// whose auxiliary lane 0 starts at an on-ramp and ends at an off-ramp.
pub fn motorway_chain(units: usize) -> NetBuilder {
    let mut b = NetBuilder::new();
    let unit = 1300.0;
    b.node("A0", 0.0, 0.0, NodeControl::Boundary);
    for u in 0..units {
        let x = u as f64 * unit;
        let (a, m, next) = (format!("A{u}"), format!("M{u}"), format!("A{}", u + 1));
        b.node(&m, x + 1000.0, 0.0, NodeControl::None)
            .node(&next, x + unit, 0.0, NodeControl::None)
            .node(&format!("R{u}"), x + 700.0, -100.0, NodeControl::Boundary)
            .node(&format!("X{u}"), x + unit + 300.0, -100.0, NodeControl::Boundary)
            .link(&format!("main{u}"), &a, &m, 2, MOTORWAY_SPEED)
            .link(&format!("aux{u}"), &m, &next, 3, MOTORWAY_SPEED)
            .link(&format!("on{u}"), &format!("R{u}"), &m, 1, RAMP_SPEED)
            .link(&format!("off{u}"), &next, &format!("X{u}"), 1, RAMP_SPEED)
            .connect(
                &format!("m{u}a"),
                &format!("main{u}"),
                0,
                &format!("aux{u}"),
                1,
                Priority::Major,
            )
            .connect(
                &format!("m{u}b"),
                &format!("main{u}"),
                1,
                &format!("aux{u}"),
                2,
                Priority::Major,
            )
            .connect(
                &format!("r{u}"),
                &format!("on{u}"),
                0,
                &format!("aux{u}"),
                0,
                Priority::Major,
            )
            .connect(
                &format!("x{u}"),
                &format!("aux{u}"),
                0,
                &format!("off{u}"),
                0,
                Priority::Major,
            )
            .class(&[&format!("main{u}"), &format!("aux{u}")], RoadClass::Motorway)
            .class(&[&format!("on{u}"), &format!("off{u}")], RoadClass::MotorwayLink);
        if u > 0 {
            let prev = format!("aux{}", u - 1);
            b.connect(
                &format!("d{u}a"),
                &prev,
                1,
                &format!("main{u}"),
                0,
                Priority::Major,
            )
            .connect(
                &format!("d{u}b"),
                &prev,
                2,
                &format!("main{u}"),
                1,
                Priority::Major,
            );
        }
    }
    let last = format!("aux{}", units.max(1) - 1);
    b.node("B", units as f64 * unit + 1000.0, 0.0, NodeControl::Boundary)
        .link("exit", &format!("A{units}"), "B", 2, MOTORWAY_SPEED)
        .connect("e0", &last, 1, "exit", 0, Priority::Major)
        .connect("e1", &last, 2, "exit", 1, Priority::Major)
        .class(&["exit"], RoadClass::Motorway);
    b
}

fn unit(a: &Point, b: &Point) -> [f64; 2] {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l = (dx * dx + dy * dy).sqrt();
    [dx / l, dy / l]
}

/// Straight corridor A → M → B: two links of `length` m with `lanes` lanes, lane i continues in
/// lane i through the plain joint M.
pub fn corridor(lanes: u32, length: f64, speed: f64) -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("M", length, 0.0, NodeControl::None)
        .node("B", 2.0 * length, 0.0, NodeControl::Boundary)
        .link("up", "A", "M", lanes, speed)
        .link("down", "M", "B", lanes, speed);
    for i in 0..lanes {
        b.connect(&format!("c{i}"), "up", i, "down", i, Priority::Major);
    }
    b
}

const MOTORWAY_SPEED: f64 = 33.333;
const RAMP_SPEED: f64 = 22.222;

impl NetBuilder {
    fn class(&mut self, links: &[&str], class: RoadClass) -> &mut Self {
        for l in links {
            self.link_mut(l).road_class = class;
        }
        self
    }
}

/// Motorway on-ramp: two-lane mainline A → M1 (1000 m), a 300 m section M1 → M2 with an
/// acceleration lane (lane 0) fed by the ramp R → M1, and the two-lane mainline M2 → B where
/// the acceleration lane ends (lane drop).
pub fn motorway_merge() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("M1", 1000.0, 0.0, NodeControl::None)
        .node("M2", 1300.0, 0.0, NodeControl::None)
        .node("B", 2000.0, 0.0, NodeControl::Boundary)
        .node("R", 700.0, -100.0, NodeControl::Boundary)
        .link("main_in", "A", "M1", 2, MOTORWAY_SPEED)
        .link("accel", "M1", "M2", 3, MOTORWAY_SPEED)
        .link("main_out", "M2", "B", 2, MOTORWAY_SPEED)
        .link("ramp", "R", "M1", 1, RAMP_SPEED)
        .connect("m0", "main_in", 0, "accel", 1, Priority::Major)
        .connect("m1", "main_in", 1, "accel", 2, Priority::Major)
        .connect("r0", "ramp", 0, "accel", 0, Priority::Major)
        .connect("d0", "accel", 1, "main_out", 0, Priority::Major)
        .connect("d1", "accel", 2, "main_out", 1, Priority::Major)
        .class(&["main_in", "accel", "main_out"], RoadClass::Motorway)
        .class(&["ramp"], RoadClass::MotorwayLink);
    b
}

/// Lane drop: three lanes A → U → M (2 × 500 m), two lanes M → B (800 m); lane 0 ends at M.
pub fn lane_drop() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("U", 500.0, 0.0, NodeControl::None)
        .node("M", 1000.0, 0.0, NodeControl::None)
        .node("B", 1800.0, 0.0, NodeControl::Boundary)
        .link("approach", "A", "U", 3, MOTORWAY_SPEED)
        .link("wide", "U", "M", 3, MOTORWAY_SPEED)
        .link("narrow", "M", "B", 2, MOTORWAY_SPEED)
        .connect("u0", "approach", 0, "wide", 0, Priority::Major)
        .connect("u1", "approach", 1, "wide", 1, Priority::Major)
        .connect("u2", "approach", 2, "wide", 2, Priority::Major)
        .connect("c1", "wide", 1, "narrow", 0, Priority::Major)
        .connect("c2", "wide", 2, "narrow", 1, Priority::Major)
        .class(&["approach", "wide", "narrow"], RoadClass::Motorway);
    b
}

/// Weaving section: on-ramp R joins A → W1 as auxiliary lane 0 of the 400 m section W1 → W2,
/// which ends in the off-ramp W2 → X; the mainline continues W2 → B with two lanes.
pub fn weaving() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.node("A", 0.0, 0.0, NodeControl::Boundary)
        .node("W1", 1000.0, 0.0, NodeControl::None)
        .node("W2", 1400.0, 0.0, NodeControl::None)
        .node("B", 2400.0, 0.0, NodeControl::Boundary)
        .node("R", 700.0, -100.0, NodeControl::Boundary)
        .node("X", 1700.0, -100.0, NodeControl::Boundary)
        .link("main_in", "A", "W1", 2, MOTORWAY_SPEED)
        .link("weave", "W1", "W2", 3, MOTORWAY_SPEED)
        .link("main_out", "W2", "B", 2, MOTORWAY_SPEED)
        .link("on_ramp", "R", "W1", 1, RAMP_SPEED)
        .link("off_ramp", "W2", "X", 1, RAMP_SPEED)
        .connect("m0", "main_in", 0, "weave", 1, Priority::Major)
        .connect("m1", "main_in", 1, "weave", 2, Priority::Major)
        .connect("r0", "on_ramp", 0, "weave", 0, Priority::Major)
        .connect("o0", "weave", 0, "off_ramp", 0, Priority::Major)
        .connect("d0", "weave", 1, "main_out", 0, Priority::Major)
        .connect("d1", "weave", 2, "main_out", 1, Priority::Major)
        .class(&["main_in", "weave", "main_out"], RoadClass::Motorway)
        .class(&["on_ramp", "off_ramp"], RoadClass::MotorwayLink);
    b
}

/// T junction J: a two-way major road W–E and a two-way minor road from S. Minor movements
/// carry `minor_priority` (`Minor` or `Stop`); the major left turn yields to oncoming traffic.
pub fn t_junction(minor_priority: Priority) -> NetBuilder {
    let mut b = NetBuilder::new();
    let v = 13.889;
    b.node("J", 0.0, 0.0, NodeControl::Priority)
        .node("W", -300.0, 0.0, NodeControl::Boundary)
        .node("E", 300.0, 0.0, NodeControl::Boundary)
        .node("S", 0.0, -300.0, NodeControl::Boundary)
        .link("we", "W", "J", 1, v)
        .link("je", "J", "E", 1, v)
        .link("ew", "E", "J", 1, v)
        .link("jw", "J", "W", 1, v)
        .link("sj", "S", "J", 1, v)
        .link("js", "J", "S", 1, v)
        .connect("we_e", "we", 0, "je", 0, Priority::Major)
        .connect("ew_w", "ew", 0, "jw", 0, Priority::Major)
        .connect("we_s", "we", 0, "js", 0, Priority::Major)
        .connect("ew_s", "ew", 0, "js", 0, Priority::Major)
        .connect("sj_e", "sj", 0, "je", 0, minor_priority)
        .connect("sj_w", "sj", 0, "jw", 0, minor_priority)
        .conflict("sj_e", "we_e")
        .conflict("sj_w", "we_e")
        .conflict("sj_w", "ew_w")
        .conflict("sj_w", "ew_s")
        .conflict("ew_s", "we_e")
        .conflict("ew_s", "we_s");
    b
}

/// Single-lane roundabout (counter-clockwise ring E → N → W → S → E, radius 25 m) with four
/// two-way arms of 200 m. Entries yield to the ring (`roundabout_entry` vs `roundabout_ring`).
pub fn roundabout() -> NetBuilder {
    let mut b = NetBuilder::new();
    b.trim = 6.0;
    let r = 25.0;
    let arm = 225.0;
    let ring = [("rE", r, 0.0), ("rN", 0.0, r), ("rW", -r, 0.0), ("rS", 0.0, -r)];
    let outer = [
        ("aE", arm, 0.0),
        ("aN", 0.0, arm),
        ("aW", -arm, 0.0),
        ("aS", 0.0, -arm),
    ];
    for (id, x, y) in ring {
        b.node(id, x, y, NodeControl::Roundabout);
    }
    for (id, x, y) in outer {
        b.node(id, x, y, NodeControl::Boundary);
    }
    for i in 0..4 {
        let (from, to) = (ring[i].0, ring[(i + 1) % 4].0);
        let id = format!("ring{i}");
        b.link(&id, from, to, 1, 8.333);
        b.link_mut(&id).roundabout = true;
        b.link(&format!("in{i}"), outer[i].0, ring[i].0, 1, 13.889);
        b.link(&format!("out{i}"), ring[i].0, outer[i].0, 1, 13.889);
    }
    for i in 0..4 {
        let prev = format!("ring{}", (i + 3) % 4);
        let next = format!("ring{i}");
        let through = format!("t{i}");
        let entry = format!("e{i}");
        b.connect(&through, &prev, 0, &next, 0, Priority::RoundaboutRing)
            .connect(
                &format!("x{i}"),
                &prev,
                0,
                &format!("out{i}"),
                0,
                Priority::RoundaboutRing,
            )
            .connect(&entry, &format!("in{i}"), 0, &next, 0, Priority::RoundaboutEntry)
            .conflict(&entry, &through);
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_networks_are_valid() {
        let c = corridor(2, 300.0, 20.0).network();
        assert_eq!(c.links.len(), 2);
        assert_eq!(c.connectors.len(), 2);
        assert!(!c.connectors[0].needs_decision);
        let t = t_junction(Priority::Stop).network();
        assert_eq!(t.connectors.len(), 6);
        let we_e = t.connector_index("we_e").unwrap();
        assert_eq!(t.conflicts(we_e).len(), 3);
        assert_eq!(
            t.connectors[t.connector_index("sj_e").unwrap() as usize].turn,
            Turn::Right
        );
        assert_eq!(
            t.connectors[t.connector_index("sj_w").unwrap() as usize].turn,
            Turn::Left
        );
        assert_eq!(t.connectors[we_e as usize].turn, Turn::Through);
        let r = roundabout().network();
        assert_eq!(r.links.len(), 12);
        assert_eq!(r.connectors.len(), 12);
        assert_eq!(r.entry_links().len(), 4);
        assert_eq!(r.exit_links().len(), 4);
        let mut b = roundabout();
        b.signal("rE", 60.0, &[("g", 0.0, 30.0, 3.0)]);
        b.connector_mut("t0").priority = Priority::Signal;
        b.connector_mut("t0").signal_group = Some("g".into());
        assert_eq!(b.build().signals.len(), 1);
        assert!(b.network().connectors[0].needs_decision);
        assert!(NetBuilder::default().build().links.is_empty());
    }

    #[test]
    fn crossroads_and_grids_derive_conflicts() {
        let x = crossroads(
            NodeControl::RightBeforeLeft,
            Priority::RightBeforeLeft,
            Priority::Stop,
        )
        .network();
        assert_eq!(x.connectors.len(), 12);
        let we = x.connector_index("WE").unwrap();
        let sn = x.connector_index("SN").unwrap();
        assert!(
            x.conflicts(we).contains(&sn),
            "crossing through movements conflict"
        );
        let point = x.conflict_point(we, sn).unwrap();
        assert!(point > 0.0 && point < x.seg_length[x.connector_segment(we) as usize]);
        let g = grid(2, 2).network();
        assert_eq!(g.nodes.len(), 4 + 8);
        assert_eq!(g.links.len(), 2 * (4 + 8));
        assert_eq!(g.entry_links().len(), 8);
        assert!(
            g.connectors
                .iter()
                .all(|c| g.nodes[c.node as usize].control == NodeControl::Priority)
        );
    }

    #[test]
    fn reverse_turns_are_classified() {
        let mut b = NetBuilder::new();
        b.node("A", 0.0, 0.0, NodeControl::Boundary)
            .node("B", 100.0, 0.0, NodeControl::Priority)
            .link("ab", "A", "B", 1, 10.0)
            .link("ba", "B", "A", 1, 10.0)
            .connect("u", "ab", 0, "ba", 0, Priority::Major);
        assert_eq!(b.network().connectors[0].turn, Turn::Reverse);
    }
}
