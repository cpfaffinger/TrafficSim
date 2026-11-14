//! Shortest-travel-time routing on the link/connector graph (#43).
//!
//! Costs are link travel times (free flow `length / speed limit` initially, replaceable through
//! [`Router::set_link_travel_time`] for Phase 5 re-routing) plus connector traversal times.
//! A route respects the vehicle class (`allowed`) and `throughTraffic = false`: such links may
//! only form a contiguous prefix (leaving the origin area) or suffix (reaching the destination)
//! of a route, never the middle.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::network::Network;
use crate::vehicle::VehicleClass;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Edge {
    to: u32,
    time: f64,
    mask: u8,
}

#[derive(Debug, Clone)]
pub struct Router {
    free_flow: Vec<f64>,
    link_time: Vec<f64>,
    link_mask: Vec<u8>,
    through: Vec<bool>,
    edge_range: Vec<(u32, u32)>,
    edges: Vec<Edge>,
}

/// Route phases for the through-traffic rule.
const ORIGIN_AREA: usize = 0;
const THROUGH: usize = 1;
const DESTINATION_AREA: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Entry {
    cost: f64,
    state: u32,
}

impl Eq for Entry {}

impl Ord for Entry {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap on cost, ties broken by state index for determinism.
        other
            .cost
            .total_cmp(&self.cost)
            .then_with(|| other.state.cmp(&self.state))
    }
}

impl PartialOrd for Entry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Router {
    pub fn new(net: &Network) -> Self {
        let free_flow: Vec<f64> = net.links.iter().map(|l| l.length / l.speed_limit).collect();
        let mut per_link: Vec<Vec<Edge>> = vec![Vec::new(); net.links.len()];
        for (i, c) in net.connectors.iter().enumerate() {
            let seg = net.connector_segment(i as u32) as usize;
            per_link[c.from_link as usize].push(Edge {
                to: c.to_link,
                time: net.seg_length[seg] / net.seg_speed_limit[seg],
                mask: c.class_mask,
            });
        }
        let mut edges = Vec::new();
        let mut edge_range = Vec::with_capacity(per_link.len());
        for list in per_link {
            let start = edges.len() as u32;
            edges.extend(list);
            edge_range.push((start, edges.len() as u32));
        }
        Self {
            link_time: free_flow.clone(),
            free_flow,
            link_mask: net.links.iter().map(|l| l.class_mask).collect(),
            through: net.links.iter().map(|l| l.through_traffic).collect(),
            edge_range,
            edges,
        }
    }

    pub fn link_travel_time(&self, link: u32) -> f64 {
        self.link_time[link as usize]
    }

    pub fn free_flow_time(&self, link: u32) -> f64 {
        self.free_flow[link as usize]
    }

    /// Replaces the travel time of a link (e.g. measured mean travel time). Values are clamped
    /// to at least 1 ms; non-finite values are ignored.
    pub fn set_link_travel_time(&mut self, link: u32, seconds: f64) {
        if seconds.is_finite() {
            self.link_time[link as usize] = seconds.max(1e-3);
        }
    }

    pub fn reset_travel_times(&mut self) {
        self.link_time.copy_from_slice(&self.free_flow);
    }

    fn phase_after(&self, phase: usize, link: u32) -> Option<usize> {
        match (phase, self.through[link as usize]) {
            (ORIGIN_AREA | THROUGH, true) => Some(THROUGH),
            (_, true) => None,
            (ORIGIN_AREA, false) => Some(ORIGIN_AREA),
            (_, false) => Some(DESTINATION_AREA),
        }
    }

    /// Fastest route from `from` to `to` (both inclusive) for `class`, or `None`.
    pub fn route(&self, from: u32, to: u32, class: VehicleClass) -> Option<Vec<u32>> {
        let mask = class.mask();
        if self.link_mask[from as usize] & mask == 0 || self.link_mask[to as usize] & mask == 0 {
            return None;
        }
        if from == to {
            return Some(vec![from]);
        }
        let n = self.link_time.len();
        let mut dist = vec![f64::INFINITY; 3 * n];
        let mut prev = vec![u32::MAX; 3 * n];
        let start_phase = if self.through[from as usize] {
            THROUGH
        } else {
            ORIGIN_AREA
        };
        let start = (start_phase * n + from as usize) as u32;
        dist[start as usize] = 0.0;
        let mut heap = BinaryHeap::new();
        heap.push(Entry {
            cost: 0.0,
            state: start,
        });
        let mut goal = None;
        while let Some(Entry { cost, state }) = heap.pop() {
            if cost > dist[state as usize] {
                continue;
            }
            let (phase, link) = (state as usize / n, (state as usize % n) as u32);
            if link == to {
                goal = Some(state);
                break;
            }
            let (a, b) = self.edge_range[link as usize];
            for e in &self.edges[a as usize..b as usize] {
                if e.mask & mask == 0 || self.link_mask[e.to as usize] & mask == 0 {
                    continue;
                }
                // A no-through link is fine as the destination itself, whatever the phase.
                let next_phase = if e.to == to && !self.through[e.to as usize] {
                    Some(DESTINATION_AREA)
                } else {
                    self.phase_after(phase, e.to)
                };
                let Some(next_phase) = next_phase else { continue };
                let next = (next_phase * n + e.to as usize) as u32;
                let c = cost + e.time + self.link_time[e.to as usize];
                if c < dist[next as usize] {
                    dist[next as usize] = c;
                    prev[next as usize] = state;
                    heap.push(Entry { cost: c, state: next });
                }
            }
        }
        let mut state = goal?;
        let mut route = vec![(state as usize % n) as u32];
        while prev[state as usize] != u32::MAX {
            state = prev[state as usize];
            route.push((state as usize % n) as u32);
        }
        route.reverse();
        Some(route)
    }

    /// Travel time of a route under the current link times (excluding the first link).
    pub fn route_cost(&self, route: &[u32]) -> f64 {
        route
            .windows(2)
            .map(|w| {
                let (a, b) = self.edge_range[w[0] as usize];
                let conn = self.edges[a as usize..b as usize]
                    .iter()
                    .filter(|e| e.to == w[1])
                    .map(|e| e.time)
                    .fold(f64::INFINITY, f64::min);
                conn + self.link_time[w[1] as usize]
            })
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package::{NodeControl, Priority, VehicleClassDto};
    use crate::testnet::{NetBuilder, fixture_network};

    fn ids(net: &Network, route: &[u32]) -> Vec<String> {
        route.iter().map(|&l| net.links[l as usize].id.clone()).collect()
    }

    #[test]
    fn routes_through_the_fixture_junction() {
        let net = fixture_network();
        let router = Router::new(&net);
        let l = |id| net.link_index(id).unwrap();
        let r = router.route(l("l1"), l("l2"), VehicleClass::Car).unwrap();
        assert_eq!(ids(&net, &r), ["l1", "l2"]);
        let r = router.route(l("l5"), l("l2"), VehicleClass::Truck).unwrap();
        assert_eq!(ids(&net, &r), ["l5", "l2"]);
        assert!(router.route_cost(&r) > router.free_flow_time(l("l2")));
        // No U-turn connectors: l1 cannot reach l4, the bridge is disconnected from the junction.
        assert_eq!(router.route(l("l1"), l("l4"), VehicleClass::Car), None);
        assert_eq!(router.route(l("l1"), l("l9"), VehicleClass::Car), None);
        assert_eq!(
            router.route(l("l9"), l("l9"), VehicleClass::Car).unwrap(),
            vec![l("l9")]
        );
    }

    /// A → B either via a short "private" link (throughTraffic = false) or a long detour.
    fn shortcut_network(private: bool) -> NetBuilder {
        let mut b = NetBuilder::new();
        b.node("A", 0.0, 0.0, NodeControl::Boundary)
            .node("X", 100.0, 0.0, NodeControl::Priority)
            .node("Y", 200.0, 0.0, NodeControl::Priority)
            .node("D", 150.0, 400.0, NodeControl::Priority)
            .node("B", 300.0, 0.0, NodeControl::Boundary)
            .node("P", 200.0, -100.0, NodeControl::Boundary)
            .link("ax", "A", "X", 1, 10.0)
            .link("xy", "X", "Y", 1, 10.0)
            .link("xd", "X", "D", 1, 10.0)
            .link("dy", "D", "Y", 1, 10.0)
            .link("yb", "Y", "B", 1, 10.0)
            .link("yp", "Y", "P", 1, 10.0)
            .connect("c1", "ax", 0, "xy", 0, Priority::Major)
            .connect("c2", "ax", 0, "xd", 0, Priority::Major)
            .connect("c3", "xd", 0, "dy", 0, Priority::Major)
            .connect("c4", "xy", 0, "yb", 0, Priority::Major)
            .connect("c5", "dy", 0, "yb", 0, Priority::Major)
            .connect("c6", "xy", 0, "yp", 0, Priority::Major);
        b.link_mut("xy").through_traffic = !private;
        b
    }

    #[test]
    fn prefers_the_fastest_route() {
        let net = shortcut_network(false).network();
        let router = Router::new(&net);
        let r = router
            .route(0, net.link_index("yb").unwrap(), VehicleClass::Car)
            .unwrap();
        assert_eq!(ids(&net, &r), ["ax", "xy", "yb"]);
    }

    #[test]
    fn avoids_no_through_links_as_transit_but_allows_them_as_destination_access() {
        let net = shortcut_network(true).network();
        let router = Router::new(&net);
        let yb = net.link_index("yb").unwrap();
        let r = router.route(0, yb, VehicleClass::Car).unwrap();
        assert_eq!(ids(&net, &r), ["ax", "xd", "dy", "yb"]);
        // Destination is the private link itself.
        let xy = net.link_index("xy").unwrap();
        assert_eq!(
            ids(&net, &router.route(0, xy, VehicleClass::Car).unwrap()),
            ["ax", "xy"]
        );
        // Starting on the private link is fine (origin access).
        assert_eq!(
            ids(&net, &router.route(xy, yb, VehicleClass::Car).unwrap()),
            ["xy", "yb"]
        );
    }

    #[test]
    fn suffix_of_no_through_links_is_allowed() {
        let mut b = shortcut_network(false);
        b.link_mut("yp").through_traffic = false;
        b.link_mut("xy").through_traffic = true;
        let net = b.network();
        let router = Router::new(&net);
        let yp = net.link_index("yp").unwrap();
        assert_eq!(
            ids(&net, &router.route(0, yp, VehicleClass::Car).unwrap()),
            ["ax", "xy", "yp"]
        );
    }

    #[test]
    fn through_link_after_destination_area_is_rejected() {
        // ax (private origin) -> xy (private) -> yb: prefix of private links is fine,
        // but private xd in the middle of through links is not used.
        let mut b = shortcut_network(false);
        b.link_mut("ax").through_traffic = false;
        b.link_mut("xd").through_traffic = false;
        b.link_mut("xy").through_traffic = true;
        let net = b.network();
        let mut router = Router::new(&net);
        let (xy, yb) = (net.link_index("xy").unwrap(), net.link_index("yb").unwrap());
        // Make the direct link slow so the detour would win if it were allowed.
        router.set_link_travel_time(xy, 1e6);
        let r = router.route(0, yb, VehicleClass::Car).unwrap();
        assert_eq!(
            ids(&net, &r),
            ["ax", "xd", "dy", "yb"],
            "private prefix ax, xd is allowed"
        );
        let mut b = shortcut_network(false);
        b.link_mut("xd").through_traffic = false;
        let net = b.network();
        let mut router = Router::new(&net);
        router.set_link_travel_time(net.link_index("xy").unwrap(), 1e6);
        let r = router
            .route(0, net.link_index("yb").unwrap(), VehicleClass::Car)
            .unwrap();
        assert_eq!(
            ids(&net, &r),
            ["ax", "xy", "yb"],
            "private xd may not be used for transit"
        );
    }

    #[test]
    fn travel_time_updates_change_routes() {
        let net = shortcut_network(false).network();
        let mut router = Router::new(&net);
        let (xy, yb) = (net.link_index("xy").unwrap(), net.link_index("yb").unwrap());
        router.set_link_travel_time(xy, 1000.0);
        router.set_link_travel_time(xy, f64::NAN);
        assert_eq!(router.link_travel_time(xy), 1000.0);
        let r = router.route(0, yb, VehicleClass::Car).unwrap();
        assert_eq!(ids(&net, &r), ["ax", "xd", "dy", "yb"]);
        router.reset_travel_times();
        assert_eq!(router.link_travel_time(xy), router.free_flow_time(xy));
        router.set_link_travel_time(xy, -5.0);
        assert_eq!(router.link_travel_time(xy), 1e-3);
    }

    #[test]
    fn respects_vehicle_classes() {
        let mut b = shortcut_network(false);
        b.link_mut("xy").lanes[0].allowed = vec![VehicleClassDto::Bus];
        let net = b.network();
        let router = Router::new(&net);
        let yb = net.link_index("yb").unwrap();
        assert_eq!(
            ids(&net, &router.route(0, yb, VehicleClass::Bus).unwrap()),
            ["ax", "xy", "yb"]
        );
        assert_eq!(
            ids(&net, &router.route(0, yb, VehicleClass::Car).unwrap()),
            ["ax", "xd", "dy", "yb"]
        );
        let xy = net.link_index("xy").unwrap();
        assert_eq!(router.route(0, xy, VehicleClass::Car), None);
        assert_eq!(router.route(xy, yb, VehicleClass::Car), None);
    }

    #[test]
    fn heap_entries_order_by_cost_then_state() {
        let a = Entry { cost: 1.0, state: 3 };
        let b = Entry { cost: 2.0, state: 1 };
        let c = Entry { cost: 1.0, state: 4 };
        assert!(a > b, "lower cost pops first");
        assert!(a > c, "lower state wins ties");
        assert_eq!(a.partial_cmp(&a), Some(Ordering::Equal));
    }
}
