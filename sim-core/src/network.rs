//! Runtime lane graph built from a network package (#40).
//!
//! Lanes and connectors are both *segments* the vehicles drive on: segment ids `0..lane_count`
//! are lanes, `lane_count..lane_count + connector_count` are connectors. Hot per-segment data
//! (length, speed limit, occupant lists in the simulation) is stored as flat arrays indexed by
//! segment id; adjacency is stored as index ranges into shared vectors. All id lookups use
//! `BTreeMap`, so nothing depends on hash iteration order.

use std::collections::BTreeMap;
use std::fmt;

use crate::package::{self, NodeControl, Package, Point, Priority, RoadClass, Turn};
use crate::signals::SignalPlans;
use crate::vehicle::VehicleClass;

/// Sentinel for "no index".
pub const NONE: u32 = u32::MAX;

/// Lateral acceleration used to derive connector curve speeds (m/s²).
const CURVE_LATERAL_ACCELERATION: f64 = 2.5;
/// Lowest speed assigned to a connector curve (m/s).
const MIN_CURVE_SPEED: f64 = 3.0;
/// Shortest segment length; zero-length connectors are stretched to this (m).
const MIN_SEGMENT_LENGTH: f64 = 0.01;
/// Widest swept path of a connector for conflict zones (m): widest vehicle (2.55 m) plus 0.25 m
/// lateral clearance on each side.
const MAX_SWEPT_WIDTH: f64 = 3.05;
/// Two swept paths overlap when their centrelines are closer than the sum of their half widths
/// minus this tolerance (m), so parallel paths of adjacent lanes never overlap.
const ZONE_TOLERANCE: f64 = 0.05;
/// Sampling step (m) of conflict-zone detection along a connector (at most 256 samples).
const ZONE_SAMPLE_STEP: f64 = 0.25;

/// A package that cannot be turned into a runtime network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkError(pub String);

impl fmt::Display for NetworkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NetworkError {}

fn err<T>(message: String) -> Result<T, NetworkError> {
    Err(NetworkError(message))
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeInfo {
    pub id: String,
    pub control: NodeControl,
    pub position: Point,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinkInfo {
    pub id: String,
    pub from: u32,
    pub to: u32,
    pub road_class: RoadClass,
    pub layer: i32,
    pub roundabout: bool,
    pub through_traffic: bool,
    pub length: f64,
    pub speed_limit: f64,
    /// Global index of lane 0 (rightmost); lanes of a link are contiguous.
    pub first_lane: u32,
    pub lane_count: u32,
    /// Metres before the link end in which lane changes are forbidden.
    pub no_lane_change_zone: f64,
    /// Union of the lanes' class masks.
    pub class_mask: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LaneInfo {
    pub link: u32,
    pub index: u32,
    pub width: f64,
    pub class_mask: u8,
    /// Vehicles may change from this lane to the lane on its left (`allowLeft`).
    pub can_change_left: bool,
    /// Vehicles may change from this lane to the lane on its right (`allowRight`).
    pub can_change_right: bool,
    out_range: (u32, u32),
    in_range: (u32, u32),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConnectorInfo {
    pub id: String,
    pub node: u32,
    pub from_link: u32,
    pub to_link: u32,
    /// Global lane indices.
    pub from_lane: u32,
    pub to_lane: u32,
    pub turn: Turn,
    pub priority: Priority,
    /// Signal group index, [`NONE`] if not signalised.
    pub signal_group: u32,
    /// Classes allowed on both the incoming and the outgoing lane.
    pub class_mask: u8,
    /// Unit driving direction (x, y) at the end of the incoming lane.
    pub approach: [f64; 2],
    /// Vehicles must decide (signal, stop sign, conflicts) before entering.
    pub needs_decision: bool,
    conflict_range: (u32, u32),
    merge_range: (u32, u32),
}

/// The runtime network: topology, geometry and signal plans.
#[derive(Debug, Clone)]
pub struct Network {
    pub nodes: Vec<NodeInfo>,
    pub links: Vec<LinkInfo>,
    pub lanes: Vec<LaneInfo>,
    pub connectors: Vec<ConnectorInfo>,
    pub signals: SignalPlans,
    /// Pedestrian crossings (ADR-0020).
    pub crossings: crate::crossings::Crossings,
    /// Per segment (lanes, then connectors): length (m).
    pub seg_length: Vec<f64>,
    /// Per segment: speed limit (m/s). Connectors get a curve speed derived from their geometry.
    pub seg_speed_limit: Vec<f64>,
    geom_range: Vec<(u32, u32)>,
    points: Vec<Point>,
    cumulative: Vec<f64>,
    /// Per point: clamped grade of the piece starting there (see [`crate::grade`]).
    piece_grade: Vec<f64>,
    /// Some piece has a non-zero grade.
    relief: bool,
    lane_out: Vec<u32>,
    lane_in: Vec<u32>,
    conflict_list: Vec<u32>,
    /// Per conflict_list entry: distance along the owning connector to the conflict point.
    conflict_pos: Vec<f64>,
    /// Per conflict_list entry: conflict zone on the owning connector (entry, exit distance).
    conflict_zone: Vec<(f64, f64)>,
    /// Conflicting connectors that merge into the same lane, per connector (subset of the
    /// conflicts, same order).
    merge_list: Vec<u32>,
    node_index: BTreeMap<String, u32>,
    link_index: BTreeMap<String, u32>,
    connector_index: BTreeMap<String, u32>,
    /// Public transport lines (#85), resolved from the package.
    pub transit: Vec<crate::transit::Line>,
}

fn class_mask(allowed: &[package::VehicleClassDto]) -> u8 {
    allowed
        .iter()
        .filter_map(|c| VehicleClass::from_dto(*c))
        .fold(0, |mask, c| mask | c.mask())
}

fn finite_point(p: &Point) -> bool {
    p.iter().all(|v| v.is_finite())
}

fn distance(a: &Point, b: &Point) -> f64 {
    let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    (dx * dx + dy * dy + dz * dz).sqrt()
}

fn direction(a: &Point, b: &Point) -> [f64; 2] {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        [1.0, 0.0]
    } else {
        [dx / len, dy / len]
    }
}

/// Radius of the circle through three points (x/y plane); infinite for (nearly) collinear points.
fn circumradius(a: &Point, b: &Point, c: &Point) -> f64 {
    let ab = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    let bc = ((c[0] - b[0]).powi(2) + (c[1] - b[1]).powi(2)).sqrt();
    let ca = ((a[0] - c[0]).powi(2) + (a[1] - c[1]).powi(2)).sqrt();
    let cross = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs();
    if cross < 1e-6 * (ab * bc).max(1e-12) {
        f64::INFINITY
    } else {
        ab * bc * ca / (2.0 * cross)
    }
}

impl Network {
    /// Parses and validates a JSON package.
    pub fn from_json(json: &str) -> Result<Self, NetworkError> {
        let package = Package::from_json(json).map_err(NetworkError)?;
        Self::from_package(&package)
    }

    /// Builds and validates the runtime network.
    pub fn from_package(p: &Package) -> Result<Self, NetworkError> {
        if p.format_version != package::FORMAT_VERSION {
            return err(format!(
                "unsupported formatVersion {} (expected {})",
                p.format_version,
                package::FORMAT_VERSION
            ));
        }
        let mut net = Network {
            nodes: Vec::with_capacity(p.nodes.len()),
            links: Vec::with_capacity(p.links.len()),
            lanes: Vec::new(),
            connectors: Vec::with_capacity(p.connectors.len()),
            signals: SignalPlans::default(),
            crossings: crate::crossings::Crossings::default(),
            seg_length: Vec::new(),
            seg_speed_limit: Vec::new(),
            geom_range: Vec::new(),
            points: Vec::new(),
            cumulative: Vec::new(),
            piece_grade: Vec::new(),
            relief: false,
            lane_out: Vec::new(),
            lane_in: Vec::new(),
            conflict_list: Vec::new(),
            conflict_pos: Vec::new(),
            conflict_zone: Vec::new(),
            merge_list: Vec::new(),
            node_index: BTreeMap::new(),
            link_index: BTreeMap::new(),
            connector_index: BTreeMap::new(),
            transit: Vec::new(),
        };

        for node in &p.nodes {
            let idx = net.nodes.len() as u32;
            if net.node_index.insert(node.id.clone(), idx).is_some() {
                return err(format!("duplicate node id '{}'", node.id));
            }
            net.nodes.push(NodeInfo {
                id: node.id.clone(),
                control: node.control,
                position: [node.x, node.y, node.z],
            });
        }

        let mut lane_geometries: Vec<&[Point]> = Vec::new();
        for link in &p.links {
            let idx = net.links.len() as u32;
            if net.link_index.insert(link.id.clone(), idx).is_some() {
                return err(format!("duplicate link id '{}'", link.id));
            }
            let node = |id: &str| {
                net.node_index
                    .get(id)
                    .copied()
                    .ok_or_else(|| NetworkError(format!("link '{}' references unknown node '{id}'", link.id)))
            };
            let (from, to) = (node(&link.from)?, node(&link.to)?);
            if link.lanes.is_empty() {
                return err(format!("link '{}' has no lanes", link.id));
            }
            if !(link.speed_limit.is_finite() && link.speed_limit > 0.0) {
                return err(format!("link '{}' has an invalid speed limit", link.id));
            }
            let first_lane = net.lanes.len() as u32;
            let mut link_mask = 0;
            for (i, lane) in link.lanes.iter().enumerate() {
                if lane.index as usize != i {
                    return err(format!("lanes of link '{}' are not ordered by index", link.id));
                }
                if lane.geometry.len() < 2 || !lane.geometry.iter().all(finite_point) {
                    return err(format!(
                        "lane {i} of link '{}' needs at least two finite points",
                        link.id
                    ));
                }
                if !(lane.length.is_finite() && lane.length > 0.0) {
                    return err(format!(
                        "lane {i} of link '{}' has a non-positive length",
                        link.id
                    ));
                }
                let speed = if lane.speed_limit.is_finite() && lane.speed_limit > 0.0 {
                    lane.speed_limit
                } else {
                    link.speed_limit
                };
                let mask = class_mask(&lane.allowed);
                link_mask |= mask;
                net.lanes.push(LaneInfo {
                    link: idx,
                    index: i as u32,
                    width: if lane.width.is_finite() && lane.width > 0.0 {
                        lane.width
                    } else {
                        3.25
                    },
                    class_mask: mask,
                    can_change_left: false,
                    can_change_right: false,
                    out_range: (0, 0),
                    in_range: (0, 0),
                });
                net.seg_length.push(lane.length);
                net.seg_speed_limit.push(speed);
                lane_geometries.push(&lane.geometry);
            }
            let lane_count = link.lanes.len() as u32;
            for b in &link.boundaries {
                if b.left_lane != b.right_lane + 1 || b.left_lane >= lane_count {
                    return err(format!("link '{}' has an invalid lane boundary", link.id));
                }
                net.lanes[(first_lane + b.right_lane) as usize].can_change_left = b.allow_left;
                net.lanes[(first_lane + b.left_lane) as usize].can_change_right = b.allow_right;
            }
            net.links.push(LinkInfo {
                id: link.id.clone(),
                from,
                to,
                road_class: link.road_class,
                layer: link.layer,
                roundabout: link.roundabout,
                through_traffic: link.through_traffic,
                length: link.length,
                speed_limit: link.speed_limit,
                first_lane,
                lane_count,
                no_lane_change_zone: if link.no_lane_change_zone.is_finite() {
                    link.no_lane_change_zone.max(0.0)
                } else {
                    0.0
                },
                class_mask: link_mask,
            });
        }
        for geometry in lane_geometries {
            net.push_geometry(geometry);
        }

        let (signals, group_index) =
            SignalPlans::from_package(&p.signals, &net.node_index).map_err(NetworkError)?;
        net.signals = signals;

        let mut conflict_names: Vec<&[String]> = Vec::with_capacity(p.connectors.len());
        let mut connector_geometries: Vec<Vec<Point>> = Vec::with_capacity(p.connectors.len());
        for c in &p.connectors {
            let idx = net.connectors.len() as u32;
            if net.connector_index.insert(c.id.clone(), idx).is_some() {
                return err(format!("duplicate connector id '{}'", c.id));
            }
            let node = *net.node_index.get(&c.node).ok_or_else(|| {
                NetworkError(format!(
                    "connector '{}' references unknown node '{}'",
                    c.id, c.node
                ))
            })?;
            let link = |id: &str| {
                net.link_index.get(id).copied().ok_or_else(|| {
                    NetworkError(format!("connector '{}' references unknown link '{id}'", c.id))
                })
            };
            let (from_link, to_link) = (link(&c.from_link)?, link(&c.to_link)?);
            let (fl, tl) = (&net.links[from_link as usize], &net.links[to_link as usize]);
            if c.from_lane >= fl.lane_count || c.to_lane >= tl.lane_count {
                return err(format!(
                    "connector '{}' references a lane that does not exist",
                    c.id
                ));
            }
            if fl.to != node || tl.from != node {
                return err(format!(
                    "connector '{}' does not pass through node '{}'",
                    c.id, c.node
                ));
            }
            let signal_group = match (c.priority, &c.signal_group) {
                (Priority::Signal, Some(group)) => *group_index.get(group).ok_or_else(|| {
                    NetworkError(format!(
                        "connector '{}' references unknown signal group '{group}'",
                        c.id
                    ))
                })?,
                (Priority::Signal, None) => {
                    return err(format!("signalised connector '{}' has no signal group", c.id));
                }
                _ => NONE,
            };
            let from_lane = fl.first_lane + c.from_lane;
            let to_lane = tl.first_lane + c.to_lane;
            let from_geom = lane_geometries_end(&net, from_lane);
            let to_geom = net.segment_points(to_lane)[0];
            let geometry = if c.geometry.len() >= 2 && c.geometry.iter().all(finite_point) {
                c.geometry.clone()
            } else {
                vec![from_geom.1, to_geom]
            };
            let length = if c.length.is_finite() && c.length > 0.0 {
                c.length
            } else {
                geometry.windows(2).map(|w| distance(&w[0], &w[1])).sum::<f64>()
            }
            .max(MIN_SEGMENT_LENGTH);
            let lane_limit =
                net.seg_speed_limit[from_lane as usize].min(net.seg_speed_limit[to_lane as usize]);
            let mid = &geometry[geometry.len() / 2];
            let radius = circumradius(&geometry[0], mid, &geometry[geometry.len() - 1]);
            let curve_speed = (CURVE_LATERAL_ACCELERATION * radius).sqrt().max(MIN_CURVE_SPEED);
            net.connectors.push(ConnectorInfo {
                id: c.id.clone(),
                node,
                from_link,
                to_link,
                from_lane,
                to_lane,
                turn: c.turn,
                priority: c.priority,
                signal_group,
                class_mask: net.lanes[from_lane as usize].class_mask & net.lanes[to_lane as usize].class_mask,
                approach: direction(&from_geom.0, &from_geom.1),
                needs_decision: false,
                conflict_range: (0, 0),
                merge_range: (0, 0),
            });
            net.seg_length.push(length);
            net.seg_speed_limit.push(curve_speed.min(lane_limit));
            conflict_names.push(&c.conflicts);
            connector_geometries.push(geometry);
        }
        for geometry in &connector_geometries {
            net.push_geometry(geometry);
        }

        // Conflicts: resolve, check same node, symmetrise, sort, deduplicate.
        let mut conflicts: Vec<Vec<u32>> = vec![Vec::new(); net.connectors.len()];
        for (a, names) in conflict_names.iter().enumerate() {
            for name in names.iter() {
                let b = *net.connector_index.get(name).ok_or_else(|| {
                    NetworkError(format!(
                        "connector '{}' lists unknown conflict '{name}'",
                        net.connectors[a].id
                    ))
                })? as usize;
                if net.connectors[b].node != net.connectors[a].node {
                    return err(format!(
                        "conflicting connectors '{}' and '{name}' are at different nodes",
                        net.connectors[a].id
                    ));
                }
                if a != b {
                    conflicts[a].push(b as u32);
                    conflicts[b].push(a as u32);
                }
            }
        }
        for (c, mut list) in conflicts.into_iter().enumerate() {
            list.sort_unstable();
            list.dedup();
            let start = net.conflict_list.len() as u32;
            for &k in &list {
                let merge = net.connectors[c].to_lane == net.connectors[k as usize].to_lane;
                let (a, b) = (&connector_geometries[c], &connector_geometries[k as usize]);
                let pos = conflict_point(a, b, merge);
                let seg = net.connector_segment(c as u32) as usize;
                // Geometric distance mapped onto the nominal connector length.
                let geom_len: f64 = a.windows(2).map(|w| distance(&w[0], &w[1])).sum();
                let nominal = net.seg_length[seg];
                let scale = if geom_len > 1e-9 { nominal / geom_len } else { 0.0 };
                net.conflict_pos.push(match pos {
                    Some(p) if geom_len > 1e-9 => (p * scale).min(nominal),
                    _ => nominal,
                });
                let reach = 0.5 * (net.zone_width(c as u32) + net.zone_width(k)) - ZONE_TOLERANCE;
                net.conflict_zone.push(if geom_len > 1e-9 {
                    let (entry, exit) = conflict_zone(a, b, reach, pos, merge);
                    ((entry * scale).min(nominal), (exit * scale).min(nominal))
                } else {
                    (0.0, nominal)
                });
            }
            net.conflict_list.extend_from_slice(&list);
            net.connectors[c].conflict_range = (start, net.conflict_list.len() as u32);
            let merge_start = net.merge_list.len() as u32;
            let to_lane = net.connectors[c].to_lane;
            for &k in &list {
                if net.connectors[k as usize].to_lane == to_lane {
                    net.merge_list.push(k);
                }
            }
            net.connectors[c].merge_range = (merge_start, net.merge_list.len() as u32);
            let info = &mut net.connectors[c];
            info.needs_decision =
                !list.is_empty() || matches!(info.priority, Priority::Signal | Priority::Stop);
        }

        // Lane adjacency through connectors (sorted by connector index).
        let mut outgoing: Vec<Vec<u32>> = vec![Vec::new(); net.lanes.len()];
        let mut incoming: Vec<Vec<u32>> = vec![Vec::new(); net.lanes.len()];
        for (i, c) in net.connectors.iter().enumerate() {
            outgoing[c.from_lane as usize].push(i as u32);
            incoming[c.to_lane as usize].push(i as u32);
        }
        for (lane, (out, inc)) in outgoing.into_iter().zip(incoming).enumerate() {
            let start = net.lane_out.len() as u32;
            net.lane_out.extend_from_slice(&out);
            net.lanes[lane].out_range = (start, net.lane_out.len() as u32);
            let start = net.lane_in.len() as u32;
            net.lane_in.extend_from_slice(&inc);
            net.lanes[lane].in_range = (start, net.lane_in.len() as u32);
        }
        net.transit = crate::transit::resolve(&net, &p.transit_lines);
        net.crossings =
            crate::crossings::Crossings::build(p.crossings.as_deref().unwrap_or(&[]), &net, &group_index)?;
        Ok(net)
    }

    fn push_geometry(&mut self, geometry: &[Point]) {
        let start = self.points.len() as u32;
        let mut acc = 0.0;
        for (i, p) in geometry.iter().enumerate() {
            if i > 0 {
                acc += distance(&geometry[i - 1], p);
            }
            let grade = geometry
                .get(i + 1)
                .map_or(0.0, |q| crate::grade::piece_grade(p, q));
            self.relief |= grade != 0.0;
            self.points.push(*p);
            self.cumulative.push(acc);
            self.piece_grade.push(grade);
        }
        self.geom_range.push((start, self.points.len() as u32));
    }

    pub fn lane_count(&self) -> usize {
        self.lanes.len()
    }

    pub fn segment_count(&self) -> usize {
        self.seg_length.len()
    }

    /// Segment id of connector `c`.
    pub fn connector_segment(&self, c: u32) -> u32 {
        self.lanes.len() as u32 + c
    }

    /// Connector index if `seg` is a connector segment.
    pub fn segment_connector(&self, seg: u32) -> Option<u32> {
        let lanes = self.lanes.len() as u32;
        (seg >= lanes).then(|| seg - lanes)
    }

    pub fn is_lane(&self, seg: u32) -> bool {
        (seg as usize) < self.lanes.len()
    }

    /// Link a segment belongs to (for a connector: the incoming link).
    pub fn segment_link(&self, seg: u32) -> u32 {
        match self.segment_connector(seg) {
            Some(c) => self.connectors[c as usize].from_link,
            None => self.lanes[seg as usize].link,
        }
    }

    pub fn node_index(&self, id: &str) -> Option<u32> {
        self.node_index.get(id).copied()
    }

    pub fn link_index(&self, id: &str) -> Option<u32> {
        self.link_index.get(id).copied()
    }

    pub fn connector_index(&self, id: &str) -> Option<u32> {
        self.connector_index.get(id).copied()
    }

    /// Outgoing connectors of a lane, sorted by connector index.
    pub fn lane_outgoing(&self, lane: u32) -> &[u32] {
        let (a, b) = self.lanes[lane as usize].out_range;
        &self.lane_out[a as usize..b as usize]
    }

    /// Incoming connectors of a lane, sorted by connector index.
    pub fn lane_incoming(&self, lane: u32) -> &[u32] {
        let (a, b) = self.lanes[lane as usize].in_range;
        &self.lane_in[a as usize..b as usize]
    }

    /// Conflicting connectors (same node, symmetric, sorted).
    pub fn conflicts(&self, connector: u32) -> &[u32] {
        let (a, b) = self.connectors[connector as usize].conflict_range;
        &self.conflict_list[a as usize..b as usize]
    }

    /// Distance along `connector` to the point where it meets conflicting connector `other`
    /// (first crossing of the geometries; the connector end for merges or when the geometries do
    /// not intersect). `None` if they do not conflict.
    pub fn conflict_point(&self, connector: u32, other: u32) -> Option<f64> {
        let (a, _) = self.connectors[connector as usize].conflict_range;
        let list = self.conflicts(connector);
        list.binary_search(&other)
            .ok()
            .map(|i| self.conflict_pos[a as usize + i])
    }

    /// Conflict zone of `connector` with conflicting connector `other` (#109): (entry, exit)
    /// distances along `connector`. A vehicle occupies it from the moment its front passes the
    /// entry until its rear passes the exit. `None` if they do not conflict.
    pub fn conflict_zone(&self, connector: u32, other: u32) -> Option<(f64, f64)> {
        let (a, _) = self.connectors[connector as usize].conflict_range;
        let list = self.conflicts(connector);
        list.binary_search(&other)
            .ok()
            .map(|i| self.conflict_zone[a as usize + i])
    }

    /// Conflicting connectors merging into the same lane as `connector` (sorted).
    pub fn merging(&self, connector: u32) -> &[u32] {
        let (a, b) = self.connectors[connector as usize].merge_range;
        &self.merge_list[a as usize..b as usize]
    }

    /// Whether two connectors merge into the same lane.
    pub fn merges(&self, a: u32, b: u32) -> bool {
        self.connectors[a as usize].to_lane == self.connectors[b as usize].to_lane
    }

    /// Conflict zones of `connector`, in the order of [`Self::conflicts`].
    pub fn conflict_zones(&self, connector: u32) -> &[(f64, f64)] {
        let (a, b) = self.connectors[connector as usize].conflict_range;
        &self.conflict_zone[a as usize..b as usize]
    }

    /// Width (m) of the swept path of a connector for conflict zones: its lane width, at most
    /// the widest vehicle plus lateral clearance.
    fn zone_width(&self, c: u32) -> f64 {
        let info = &self.connectors[c as usize];
        let lanes =
            0.5 * (self.lanes[info.from_lane as usize].width + self.lanes[info.to_lane as usize].width);
        lanes.min(MAX_SWEPT_WIDTH)
    }

    /// Whether `lane` ends inside the network without a connector (acceleration lane, lane drop):
    /// vehicles on it have to change lanes.
    pub fn lane_ends(&self, lane: u32) -> bool {
        let to = self.links[self.lanes[lane as usize].link as usize].to;
        self.lane_outgoing(lane).is_empty() && self.nodes[to as usize].control != NodeControl::Boundary
    }

    /// Global lane index of lane `index` of `link`, if it exists.
    pub fn link_lane(&self, link: u32, index: u32) -> Option<u32> {
        let l = &self.links[link as usize];
        (index < l.lane_count).then_some(l.first_lane + index)
    }

    /// The connector a vehicle of class `mask` takes from `lane` to reach `next_link`
    /// (lowest connector index wins), or [`NONE`].
    pub fn choose_connector(&self, lane: u32, next_link: u32, mask: u8) -> u32 {
        self.lane_outgoing(lane)
            .iter()
            .copied()
            .find(|&c| {
                let info = &self.connectors[c as usize];
                info.to_link == next_link && info.class_mask & mask != 0
            })
            .unwrap_or(NONE)
    }

    /// Links whose start node is a network boundary (vehicle sources).
    pub fn entry_links(&self) -> Vec<u32> {
        (0..self.links.len() as u32)
            .filter(|&l| self.nodes[self.links[l as usize].from as usize].control == NodeControl::Boundary)
            .collect()
    }

    /// Links whose end node is a network boundary (vehicle sinks).
    pub fn exit_links(&self) -> Vec<u32> {
        (0..self.links.len() as u32)
            .filter(|&l| self.nodes[self.links[l as usize].to as usize].control == NodeControl::Boundary)
            .collect()
    }

    fn segment_points(&self, seg: u32) -> &[Point] {
        let (a, b) = self.geom_range[seg as usize];
        &self.points[a as usize..b as usize]
    }

    /// True when some segment is not level (terrain or grade-separation ramps).
    pub fn has_relief(&self) -> bool {
        self.relief
    }

    /// Clamped road grade (rise over run) at distance `s` along a segment (#87); `s` is mapped
    /// like in [`Self::point_at`].
    pub fn grade_at(&self, seg: u32, s: f64) -> f64 {
        if !self.relief {
            return 0.0;
        }
        let (a, b) = self.geom_range[seg as usize];
        let cum = &self.cumulative[a as usize..b as usize];
        let total = cum[cum.len() - 1];
        let t = (s * total / self.seg_length[seg as usize]).clamp(0.0, total);
        let i = cum.partition_point(|&c| c <= t).clamp(1, cum.len() - 1);
        self.piece_grade[a as usize + i - 1]
    }

    /// Point and unit direction (x, y) at distance `s` along a segment. `s` is measured in the
    /// segment's nominal length and mapped proportionally onto its geometry.
    pub fn point_at(&self, seg: u32, s: f64) -> (Point, [f64; 2]) {
        let (a, b) = self.geom_range[seg as usize];
        let (a, b) = (a as usize, b as usize);
        let cum = &self.cumulative[a..b];
        let pts = &self.points[a..b];
        let total = cum[cum.len() - 1];
        let t = (s * total / self.seg_length[seg as usize]).clamp(0.0, total);
        let i = cum.partition_point(|&c| c <= t).clamp(1, cum.len() - 1);
        let (p, q) = (&pts[i - 1], &pts[i]);
        let span = cum[i] - cum[i - 1];
        let f = if span > 1e-12 {
            (t - cum[i - 1]) / span
        } else {
            0.0
        };
        let point = [
            p[0] + (q[0] - p[0]) * f,
            p[1] + (q[1] - p[1]) * f,
            p[2] + (q[2] - p[2]) * f,
        ];
        (point, direction(p, q))
    }
}

/// Geometric distance along `a` to its first crossing with `b` (x/y plane); `None` for merges
/// (`same_target`) and non-intersecting paths.
fn conflict_point(a: &[Point], b: &[Point], same_target: bool) -> Option<f64> {
    if same_target {
        return None;
    }
    let mut along = 0.0;
    for w in a.windows(2) {
        let (p, q) = (&w[0], &w[1]);
        let seg_len = distance(p, q);
        let mut first: Option<f64> = None;
        for v in b.windows(2) {
            let (r, s) = (&v[0], &v[1]);
            let d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
            if d.abs() < 1e-12 {
                continue;
            }
            let t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
            let u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
            if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
                first = Some(first.map_or(t, |f: f64| f.min(t)));
            }
        }
        if let Some(t) = first {
            return Some(along + t * seg_len);
        }
        along += seg_len;
    }
    None
}

/// Point at geometric distance `t` along a polyline.
fn point_along(path: &[Point], t: f64) -> Point {
    let mut along = 0.0;
    for w in path.windows(2) {
        let len = distance(&w[0], &w[1]);
        if t <= along + len && len > 1e-12 {
            let f = ((t - along) / len).clamp(0.0, 1.0);
            return [
                w[0][0] + (w[1][0] - w[0][0]) * f,
                w[0][1] + (w[1][1] - w[0][1]) * f,
                w[0][2] + (w[1][2] - w[0][2]) * f,
            ];
        }
        along += len;
    }
    path[path.len() - 1]
}

/// Planar (x/y) distance from `p` to a polyline.
fn distance_to_path(p: &Point, path: &[Point]) -> f64 {
    path.windows(2)
        .map(|w| {
            let (ax, ay) = (w[0][0], w[0][1]);
            let (dx, dy) = (w[1][0] - ax, w[1][1] - ay);
            let len2 = dx * dx + dy * dy;
            let f = if len2 > 1e-18 {
                (((p[0] - ax) * dx + (p[1] - ay) * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let (ex, ey) = (p[0] - ax - f * dx, p[1] - ay - f * dy);
            (ex * ex + ey * ey).sqrt()
        })
        .fold(f64::INFINITY, f64::min)
}

/// Conflict zone on path `a` with path `b` (#109), as geometric distances (entry, exit) along `a`:
/// the stretch where the centreline of `a` is closer than `reach` (the sum of both half widths)
/// to the centreline of `b`, i.e. where vehicles on both paths would overlap. Crossings take the
/// stretch around their crossing point `cross`, merges the stretch that reaches the end of `a`
/// (merge point to connector end); other declared conflicts the hull of all overlapping
/// stretches, or the whole path if the paths never come close.
fn conflict_zone(a: &[Point], b: &[Point], reach: f64, cross: Option<f64>, merge: bool) -> (f64, f64) {
    let total: f64 = a.windows(2).map(|w| distance(&w[0], &w[1])).sum();
    let n = ((total / ZONE_SAMPLE_STEP).ceil() as usize).clamp(8, 256);
    let samples: Vec<(f64, f64)> = (0..=n)
        .map(|i| {
            let t = total * i as f64 / n as f64;
            (t, distance_to_path(&point_along(a, t), b) - reach)
        })
        .collect();
    // Overlapping stretches; boundaries interpolated between samples.
    let mut zones: Vec<(f64, f64)> = Vec::new();
    let mut start: Option<f64> = None;
    for (i, &(t, d)) in samples.iter().enumerate() {
        let boundary = || {
            let (t0, d0) = samples[i - 1];
            t0 + (t - t0) * d0 / (d0 - d)
        };
        match (start, d < 0.0) {
            (None, true) => start = Some(if i == 0 { 0.0 } else { boundary() }),
            (Some(s), false) => {
                zones.push((s, boundary()));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        zones.push((s, total));
    }
    let (Some(first), Some(last)) = (zones.first(), zones.last()) else {
        return match cross {
            Some(p) => ((p - reach).max(0.0), (p + reach).min(total)),
            None if merge => (total, total),
            None => (0.0, total),
        };
    };
    match cross {
        Some(p) => *zones
            .iter()
            .min_by(|x, y| {
                let gap = |z: &&(f64, f64)| (z.0 - p).max(p - z.1).max(0.0);
                gap(x).total_cmp(&gap(y))
            })
            .unwrap_or(first),
        None if merge => *last,
        None => (first.0, last.1),
    }
}

/// Last two points of a lane geometry (for the approach direction and connector fallback).
fn lane_geometries_end(net: &Network, lane: u32) -> (Point, Point) {
    let pts = net.segment_points(lane);
    (pts[pts.len() - 2], pts[pts.len() - 1])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synth::{FIXTURE, NetBuilder, fixture_network, fixture_package};

    fn fixture() -> Network {
        fixture_network()
    }

    #[test]
    fn parses_json_directly() {
        let net = Network::from_json(FIXTURE).unwrap();
        assert_eq!(net.links.len(), fixture().links.len());
    }

    fn expect_error(mutate: impl FnOnce(&mut Package), needle: &str) {
        let mut p = fixture_package();
        mutate(&mut p);
        let e = Network::from_package(&p).unwrap_err();
        assert!(e.to_string().contains(needle), "expected '{needle}' in '{e}'");
    }

    #[test]
    fn builds_the_fixture_graph() {
        let net = fixture();
        assert_eq!(net.nodes.len(), 9);
        assert_eq!(net.links.len(), 10);
        assert_eq!(net.lane_count(), 16);
        assert_eq!(net.connectors.len(), 14);
        assert_eq!(net.segment_count(), 30);
        let l1 = net.link_index("l1").unwrap();
        let lane0 = net.link_lane(l1, 0).unwrap();
        let lane1 = net.link_lane(l1, 1).unwrap();
        assert_eq!(net.link_lane(l1, 2), None);
        // l1:0 -> c0 (through), c2 (right); l1:1 -> c1 (through), c3 (left).
        let names = |cs: &[u32]| {
            cs.iter()
                .map(|&c| net.connectors[c as usize].id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(net.lane_outgoing(lane0)), ["c0", "c2"]);
        assert_eq!(names(net.lane_outgoing(lane1)), ["c1", "c3"]);
        let l8 = net.link_index("l8").unwrap();
        assert_eq!(
            names(net.lane_incoming(net.link_lane(l8, 0).unwrap())),
            ["c3", "c7", "c13"]
        );
        assert!(net.lanes[lane0 as usize].can_change_left);
        assert!(net.lanes[lane1 as usize].can_change_right);
        let l3 = net.link_index("l3").unwrap();
        let l3_1 = net.link_lane(l3, 1).unwrap();
        assert!(
            !net.lanes[l3_1 as usize].can_change_right,
            "solid_dashed forbids right"
        );
        assert!(net.lanes[(l3_1 - 1) as usize].can_change_left);
        assert_eq!(net.links[l1 as usize].no_lane_change_zone, 30.0);
        assert_eq!(net.lanes[lane0 as usize].class_mask, 0b11111);
        assert_eq!(net.signals.group_count(), 2);
        let c3 = net.connector_index("c3").unwrap();
        assert_eq!(net.connectors[c3 as usize].signal_group, 0);
        assert!(net.connectors[c3 as usize].needs_decision);
        assert_eq!(net.segment_connector(net.connector_segment(c3)), Some(c3));
        assert_eq!(net.segment_connector(lane0), None);
        assert!(net.is_lane(lane0) && !net.is_lane(net.connector_segment(c3)));
        assert_eq!(net.segment_link(net.connector_segment(c3)), l1);
        assert_eq!(net.segment_link(lane1), l1);
        assert_eq!(net.choose_connector(lane1, l8, VehicleClass::Car.mask()), c3);
        assert_eq!(net.choose_connector(lane0, l8, VehicleClass::Car.mask()), NONE);
        assert_eq!(net.node_index("n0"), Some(0));
        assert_eq!(net.node_index("nx"), None);
        assert_eq!(net.connector_index("nope"), None);
    }

    #[test]
    fn conflicts_are_symmetric_and_sorted() {
        let net = fixture();
        for c in 0..net.connectors.len() as u32 {
            let list = net.conflicts(c);
            assert!(list.windows(2).all(|w| w[0] < w[1]));
            for &k in list {
                assert!(net.conflicts(k).contains(&c));
                assert_eq!(net.connectors[k as usize].node, net.connectors[c as usize].node);
            }
        }
    }

    #[test]
    fn entries_and_exits_are_boundary_links() {
        let net = fixture();
        let ids = |ls: Vec<u32>| {
            ls.into_iter()
                .map(|l| net.links[l as usize].id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(net.entry_links()), ["l1", "l3", "l5", "l7", "l9", "l10"]);
        assert_eq!(ids(net.exit_links()), ["l2", "l4", "l6", "l8", "l9", "l10"]);
    }

    #[test]
    fn connector_speed_follows_curvature() {
        let net = fixture();
        let speed =
            |id: &str| net.seg_speed_limit[net.connector_segment(net.connector_index(id).unwrap()) as usize];
        let through = speed("c0");
        let right = speed("c2");
        let left = speed("c3");
        assert!(
            (through - 13.889).abs() < 1e-9,
            "through keeps the lane limit: {through}"
        );
        assert!(right < left && left < through, "right {right} left {left}");
        assert!(right >= MIN_CURVE_SPEED);
    }

    #[test]
    fn interpolates_positions_along_segments() {
        let net = fixture();
        let lane = net.link_lane(net.link_index("l1").unwrap(), 0).unwrap();
        let (p, d) = net.point_at(lane, 70.0);
        assert!((p[0] - -80.0).abs() < 1e-9 && (p[1] - -4.875).abs() < 1e-9);
        assert_eq!(d, [1.0, 0.0]);
        let (start, _) = net.point_at(lane, -5.0);
        assert_eq!(start[0], -150.0);
        let (end, _) = net.point_at(lane, 1e9);
        assert_eq!(end[0], -10.0);
        let bridge = net.link_lane(net.link_index("l9").unwrap(), 0).unwrap();
        assert_eq!(net.point_at(bridge, 10.0).0[2], 6.0);
    }

    #[test]
    fn rejects_unsupported_versions_and_bad_json() {
        expect_error(|p| p.format_version = 2, "formatVersion");
        assert!(
            Network::from_json("[]")
                .unwrap_err()
                .0
                .contains("invalid network package")
        );
    }

    #[test]
    fn rejects_duplicate_ids() {
        expect_error(|p| p.nodes.push(p.nodes[0].clone()), "duplicate node");
        expect_error(|p| p.links.push(p.links[0].clone()), "duplicate link");
        expect_error(
            |p| p.connectors.push(p.connectors[0].clone()),
            "duplicate connector",
        );
    }

    #[test]
    fn rejects_dangling_references() {
        expect_error(|p| p.links[0].to = "zz".into(), "unknown node 'zz'");
        expect_error(|p| p.connectors[0].node = "zz".into(), "unknown node 'zz'");
        expect_error(|p| p.connectors[0].to_link = "zz".into(), "unknown link 'zz'");
        expect_error(|p| p.connectors[0].to_lane = 7, "lane that does not exist");
        expect_error(
            |p| p.connectors[0].conflicts.push("zz".into()),
            "unknown conflict 'zz'",
        );
        expect_error(
            |p| p.connectors[0].signal_group = Some("zz".into()),
            "unknown signal group",
        );
        expect_error(|p| p.connectors[0].signal_group = None, "has no signal group");
        expect_error(|p| p.signals[0].node = "zz".into(), "unknown node 'zz'");
    }

    #[test]
    fn rejects_inconsistent_topology_and_values() {
        // c0 goes l1 -> l2 through n0; claiming it passes n1 is inconsistent.
        expect_error(|p| p.connectors[0].node = "n1".into(), "does not pass through");
        expect_error(|p| p.links[0].lanes.clear(), "no lanes");
        expect_error(|p| p.links[0].speed_limit = 0.0, "speed limit");
        expect_error(|p| p.links[0].lanes.swap(0, 1), "ordered by index");
        expect_error(|p| p.links[0].lanes[0].geometry.truncate(1), "two finite points");
        expect_error(|p| p.links[0].lanes[0].length = -1.0, "non-positive length");
        expect_error(
            |p| p.links[0].boundaries[0].left_lane = 5,
            "invalid lane boundary",
        );
        expect_error(|p| p.signals[0].cycle = -1.0, "cycle");
    }

    #[test]
    fn rejects_conflicts_across_nodes() {
        let mut b = NetBuilder::new();
        b.node("A", 0.0, 0.0, NodeControl::Boundary)
            .node("M1", 100.0, 0.0, NodeControl::Priority)
            .node("M2", 200.0, 0.0, NodeControl::Priority)
            .node("B", 300.0, 0.0, NodeControl::Boundary)
            .link("a", "A", "M1", 1, 10.0)
            .link("b", "M1", "M2", 1, 10.0)
            .link("c", "M2", "B", 1, 10.0)
            .connect("x", "a", 0, "b", 0, Priority::Major)
            .connect("y", "b", 0, "c", 0, Priority::Major);
        assert!(Network::from_package(&b.build()).is_ok());
        b.conflict("x", "y");
        let e = Network::from_package(&b.build()).unwrap_err();
        assert!(e.0.contains("different nodes"), "{e}");
        // A connector listing itself is ignored.
        let mut b2 = NetBuilder::new();
        b2.package = b.build();
        b2.connector_mut("x").conflicts = vec!["x".into()];
        assert!(b2.network().conflicts(0).is_empty());
    }

    #[test]
    fn tolerates_missing_or_degenerate_optional_values() {
        let mut p = fixture_package();
        p.connectors[0].geometry.clear();
        p.connectors[0].length = 0.0;
        p.links[0].lanes[0].speed_limit = f64::NAN;
        p.links[0].lanes[0].width = -1.0;
        p.links[0].no_lane_change_zone = f64::NAN;
        let net = Network::from_package(&p).unwrap();
        let c0 = net.connector_segment(0);
        assert!(
            (net.seg_length[c0 as usize] - 20.0).abs() < 1e-9,
            "fallback straight geometry"
        );
        assert_eq!(net.seg_speed_limit[0], net.links[0].speed_limit);
        assert_eq!(net.lanes[0].width, 3.25);
        assert_eq!(net.links[0].no_lane_change_zone, 0.0);
    }

    #[test]
    fn conflict_zones_span_the_overlap_of_both_swept_paths() {
        use crate::synth::{crossroads, t_junction};
        let x = crossroads(NodeControl::Priority, Priority::Major, Priority::Minor).network();
        let c = |id: &str| x.connector_index(id).unwrap();
        let len = |id: &str| x.seg_length[x.connector_segment(c(id)) as usize];
        // Perpendicular through movements: the zone extends ±(3.05 − 0.05) m around the crossing.
        let point = x.conflict_point(c("WE"), c("SN")).unwrap();
        let (entry, exit) = x.conflict_zone(c("WE"), c("SN")).unwrap();
        assert!(entry < point && point < exit, "{entry} {point} {exit}");
        assert!((exit - entry - 6.0).abs() < 0.5, "{entry} {exit}");
        assert!(entry > 0.0 && exit < len("WE"));
        let (e2, x2) = x.conflict_zone(c("SN"), c("WE")).unwrap();
        assert!((x2 - e2 - 6.0).abs() < 0.5, "symmetric extent: {e2} {x2}");
        assert_eq!(x.conflict_zone(c("WE"), c("WS")), None, "no conflict");
        assert_eq!(x.conflict_zones(c("WE")).len(), x.conflicts(c("WE")).len());

        // Merge: from where the paths come within reach to the end of the connector.
        let t = t_junction(Priority::Minor).network();
        let c = |id: &str| t.connector_index(id).unwrap();
        let end = t.seg_length[t.connector_segment(c("sj_e")) as usize];
        let (entry, exit) = t.conflict_zone(c("sj_e"), c("we_e")).unwrap();
        assert!(entry > 0.2 * end && entry < 0.8 * end, "{entry} of {end}");
        assert_eq!(exit, end);
        let end = t.seg_length[t.connector_segment(c("we_e")) as usize];
        let (entry, exit) = t.conflict_zone(c("we_e"), c("sj_e")).unwrap();
        assert!(entry > 0.0 && entry < end && exit == end, "{entry} {exit} {end}");
    }

    #[test]
    fn conflict_zone_fallbacks() {
        let line = |y: f64| vec![[0.0, y, 0.0], [10.0, y, 0.0]];
        // Parallel paths farther apart than the reach: whole path (declared conflict), the end
        // (merge) or around the crossing point.
        assert_eq!(
            conflict_zone(&line(0.0), &line(5.0), 3.0, None, false),
            (0.0, 10.0)
        );
        assert_eq!(
            conflict_zone(&line(0.0), &line(5.0), 3.0, None, true),
            (10.0, 10.0)
        );
        assert_eq!(
            conflict_zone(&line(0.0), &line(5.0), 3.0, Some(4.0), false),
            (1.0, 7.0)
        );
        // Parallel overlapping paths: the hull of the overlap.
        let (a, b) = conflict_zone(&line(0.0), &line(1.0), 3.0, None, false);
        assert_eq!((a, b), (0.0, 10.0));
        // Paths that converge: overlap starts where the distance drops below the reach.
        let converging = vec![[0.0, 10.0, 0.0], [10.0, 0.0, 0.0]];
        let (a, b) = conflict_zone(&line(0.0), &converging, 3.0 * 2f64.sqrt(), None, true);
        assert!((a - 4.0).abs() < 0.05 && b == 10.0, "{a} {b}");
        assert_eq!(point_along(&line(0.0), 99.0), [10.0, 0.0, 0.0]);
        assert_eq!(
            distance_to_path(&[0.0, 3.0, 0.0], &[[1.0, 1.0, 0.0], [1.0, 1.0, 0.0]]),
            5f64.sqrt()
        );
    }

    #[test]
    fn circumradius_of_right_angle_and_line() {
        let r = circumradius(&[0.0, 0.0, 0.0], &[1.0, 1.0, 0.0], &[2.0, 0.0, 0.0]);
        assert!((r - 1.0).abs() < 1e-12);
        assert!(circumradius(&[0.0, 0.0, 0.0], &[1.0, 0.0, 0.0], &[2.0, 0.0, 0.0]).is_infinite());
        assert_eq!(direction(&[0.0, 0.0, 0.0], &[0.0, 0.0, 0.0]), [1.0, 0.0]);
        assert_eq!(NetworkError("x".into()).to_string(), "x");
    }
}
