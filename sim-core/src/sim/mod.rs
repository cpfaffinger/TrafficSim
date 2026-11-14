//! Microscopic simulation on a runtime network (#41, #42, #44, #45, #46, #48).
//!
//! One step (fixed Δt) runs these phases in a fixed order, each iterating vehicles in a stable
//! order (insertion order, compacted with `retain`):
//!
//! 1. rebuild the per-segment occupant lists (sorted by position, ties by vehicle id),
//! 2. signal aspects for the current time,
//! 3. arrivals (Poisson per entry, per-entry RNG stream) and insertion when the gap is safe,
//! 4. lane changes (MOBIL + mandatory route changes), applied sequentially,
//! 5. junction decisions (signals, priority, gap acceptance), claims applied sequentially,
//! 6. IDM accelerations for all vehicles from the same state (parallel update),
//! 7. ballistic integration, segment transitions, arrivals at exits.
//!
//! The core has no I/O, no wall clock and no global RNG; identical package, config and seed
//! give bit-identical states (see [`Simulation::state_checksum`]).

mod junction;
mod lane_change;

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;

use crate::config::SimConfig;
use crate::detmath;
use crate::idm::MAX_EMERGENCY_DECELERATION;
use crate::network::{NONE, Network};
use crate::rng::Pcg32;
use crate::routing::Router;
use crate::signals::SignalState;
use crate::vehicle::{VehicleClass, VehicleParams};

/// Floats per vehicle in [`Simulation::snapshot_into`].
pub const SNAPSHOT_STRIDE: usize = 9;

/// Bits of the per-vehicle state flags in snapshots.
pub mod flags {
    /// Decelerating harder than 1 m/s².
    pub const BRAKING: u8 = 1;
    /// Slower than 0.5 m/s.
    pub const WAITING: u8 = 2;
    /// Visual lateral transition of a lane change in progress.
    pub const CHANGING_LANE: u8 = 4;
    /// On a connector (inside a junction).
    pub const IN_JUNCTION: u8 = 8;
    /// Holding at a stop line (red signal, stop sign or yielding).
    pub const YIELDING: u8 = 16;
}

/// Stop this far (m) before a stop line obstacle.
const STOP_LINE_MARGIN: f64 = 0.5;

/// State of one vehicle. Positions are front-bumper distances along the current segment.
#[derive(Debug, Clone, PartialEq)]
pub struct Vehicle {
    /// Stable id (never reused within a run).
    pub id: u32,
    pub params: VehicleParams,
    /// Current segment (lane or connector, see [`Network`]).
    pub seg: u32,
    /// Previous segment (for drawing a vehicle that straddles a segment boundary).
    pub prev_seg: u32,
    pub pos: f64,
    pub speed: f64,
    pub acc: f64,
    /// Route id (index into the route table) and index of the current link in it. On a
    /// connector, `route_pos` already points at the link being entered.
    pub route: u32,
    pub route_pos: u32,
    /// Next connector ahead (from the current lane, or from the lane after the current connector).
    pub next_conn: u32,
    /// Connector the vehicle has committed to enter (claimed), [`NONE`] otherwise.
    pub claimed: u32,
    /// Distance to a stop line the vehicle must hold at, `INFINITY` if none.
    pub stop_dist: f64,
    /// Time spent waiting at the current stop line (s).
    pub wait: f64,
    /// Full stop at a stop sign completed.
    pub stop_done: bool,
    /// Time until the next lane change is allowed (s).
    pub lc_timer: f64,
    /// Visual lateral offset from the lane centre (m, positive = left), decays to 0.
    pub lat_offset: f64,
    /// Insertion time (s).
    pub depart: f64,
    /// Index in the occupant list of `seg` (0 = most downstream).
    pub rank: u32,
    pub flags: u8,
    /// Re-routing found no way to the destination; removed at the end of its lane.
    pub lost: bool,
    /// Step phase of the staggered discretionary lane-change evaluation (set at insertion, so it
    /// does not depend on other sources' traffic).
    lc_phase: u32,
    alive: bool,
}

#[derive(Debug, Clone)]
struct Pending {
    params: VehicleParams,
    link: u32,
    route: u32,
}

#[derive(Debug, Clone)]
struct Source {
    node: u32,
    links: Vec<u32>,
    /// Vehicles per second.
    rate: f64,
    next_arrival: f64,
    rng: Pcg32,
    queue: VecDeque<Pending>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Counters {
    spawned: u64,
    arrived: u64,
    rerouted: u64,
    stranded: u64,
    unroutable: u64,
    lane_changes: u64,
    forced_entries: u64,
    travel_time_sum: f64,
}

/// Aggregate run statistics (`stats_json`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub time: f64,
    /// Vehicles inserted into the network.
    pub spawned: u64,
    /// Vehicles that reached their destination exit.
    pub arrived: u64,
    /// Vehicles currently in the network.
    pub active: u64,
    /// Generated vehicles queued at their entry because the gap was not safe yet.
    pub waiting_to_enter: u64,
    /// Route recomputations after a missed mandatory lane change.
    pub rerouted: u64,
    /// Vehicles removed at a dead end without reaching their destination.
    pub stranded: u64,
    /// Generated vehicles dropped because no destination was reachable.
    pub unroutable: u64,
    pub lane_changes: u64,
    /// Junction entries forced by the deadlock breaker (`junction.maxWait`).
    pub forced_entries: u64,
    /// Mean travel time of arrived vehicles (s).
    pub mean_travel_time: f64,
    /// Mean speed of active vehicles (m/s).
    pub mean_speed: f64,
}

/// A lane change, recorded when event logging is enabled (tests, debugging).
#[derive(Debug, Clone, PartialEq)]
pub struct LaneChangeEvent {
    pub vehicle: u32,
    pub link: u32,
    pub from_index: u32,
    pub to_index: u32,
    pub pos: f64,
    pub mandatory: bool,
}

/// A junction entry commitment (claim), recorded when event logging is enabled.
#[derive(Debug, Clone, PartialEq)]
pub struct EntryEvent {
    pub vehicle: u32,
    pub connector: u32,
    pub time: f64,
    pub signal: Option<SignalState>,
    pub forced: bool,
}

/// A running simulation.
#[derive(Debug, Clone)]
pub struct Simulation {
    net: Network,
    router: Router,
    config: SimConfig,
    dt: f64,
    time: f64,
    steps: u64,
    vehicles: Vec<Vehicle>,
    next_id: u32,
    /// Occupants per segment, most downstream first.
    seg_vehicles: Vec<Vec<u32>>,
    occupied: Vec<u32>,
    /// Vehicles that claimed each connector but have not entered it yet.
    conn_claims: Vec<u32>,
    conn_last_claim: Vec<f64>,
    signal_state: Vec<SignalState>,
    sources: Vec<Source>,
    dest_weight: Vec<f64>,
    routes: Vec<Vec<u32>>,
    route_cache: BTreeMap<(u32, u32, u8), u32>,
    dest_cache: BTreeMap<(u32, u8), Vec<(u32, f64)>>,
    counters: Counters,
    scratch_acc: Vec<f64>,
    log_events: bool,
    lane_change_log: Vec<LaneChangeEvent>,
    entry_log: Vec<EntryEvent>,
}

/// Distance travelled and new speed after `dt` with constant acceleration, never reversing.
fn ballistic(speed: f64, acc: f64, dt: f64) -> (f64, f64) {
    if speed + acc * dt < 0.0 {
        (-0.5 * speed * speed / acc, 0.0)
    } else {
        (speed * dt + 0.5 * acc * dt * dt, speed + acc * dt)
    }
}

/// Exponentially distributed inter-arrival time for `rate` events per second.
fn exponential(rng: &mut Pcg32, rate: f64) -> f64 {
    -detmath::ln(1.0 - rng.next_f64()) / rate
}

impl Simulation {
    /// Builds a simulation from JSON inputs.
    pub fn from_json(package_json: &str, config_json: &str, seed: u64) -> Result<Self, String> {
        let net = Network::from_json(package_json).map_err(|e| e.0)?;
        let config = SimConfig::from_json(config_json)?;
        Self::new(net, config, seed)
    }

    pub fn new(net: Network, config: SimConfig, seed: u64) -> Result<Self, String> {
        config.validate()?;
        let mut by_node: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for link in net.entry_links() {
            by_node
                .entry(net.links[link as usize].from)
                .or_default()
                .push(link);
        }
        for id in config.demand.keys() {
            match net.node_index(id) {
                Some(n) if by_node.contains_key(&n) => {}
                _ => return Err(format!("demand references '{id}', which is not an entry node")),
            }
        }
        let mut sources = Vec::with_capacity(by_node.len());
        for (node, links) in by_node {
            let mut src = Source {
                node,
                links,
                rate: 0.0,
                next_arrival: f64::INFINITY,
                rng: Pcg32::new(seed, 0x1000 + u64::from(node)),
                queue: VecDeque::new(),
            };
            let vph = *config
                .demand
                .get(&net.nodes[node as usize].id)
                .unwrap_or(&config.default_demand);
            set_rate(&mut src, vph, 0.0);
            sources.push(src);
        }
        let mut dest_weight = vec![0.0; net.links.len()];
        for exit in net.exit_links() {
            let node = &net.nodes[net.links[exit as usize].to as usize].id;
            dest_weight[exit as usize] = *config.destination_weights.get(node).unwrap_or(&1.0);
        }
        let segments = net.segment_count();
        let connectors = net.connectors.len();
        Ok(Self {
            router: Router::new(&net),
            dt: config.time_step,
            config,
            time: 0.0,
            steps: 0,
            vehicles: Vec::new(),
            next_id: 0,
            seg_vehicles: vec![Vec::new(); segments],
            occupied: Vec::new(),
            conn_claims: vec![0; connectors],
            conn_last_claim: vec![f64::NEG_INFINITY; connectors],
            signal_state: Vec::new(),
            sources,
            dest_weight,
            routes: Vec::new(),
            route_cache: BTreeMap::new(),
            dest_cache: BTreeMap::new(),
            counters: Counters::default(),
            scratch_acc: Vec::new(),
            log_events: false,
            lane_change_log: Vec::new(),
            entry_log: Vec::new(),
            net,
        })
    }

    pub fn network(&self) -> &Network {
        &self.net
    }

    pub fn config(&self) -> &SimConfig {
        &self.config
    }

    pub fn time(&self) -> f64 {
        self.time
    }

    pub fn time_step(&self) -> f64 {
        self.dt
    }

    pub fn steps(&self) -> u64 {
        self.steps
    }

    pub fn vehicles(&self) -> &[Vehicle] {
        &self.vehicles
    }

    pub fn vehicle_count(&self) -> usize {
        self.vehicles.len()
    }

    /// Vehicles that claimed connector `c` and have not entered it yet.
    pub fn connector_claims(&self, c: u32) -> u32 {
        self.conn_claims[c as usize]
    }

    /// Route (link indices) of a vehicle.
    pub fn route_of(&self, v: &Vehicle) -> &[u32] {
        &self.routes[v.route as usize]
    }

    /// Records lane changes and junction entries (for tests and debugging; unbounded).
    pub fn set_event_logging(&mut self, enabled: bool) {
        self.log_events = enabled;
    }

    pub fn lane_change_log(&self) -> &[LaneChangeEvent] {
        &self.lane_change_log
    }

    pub fn entry_log(&self) -> &[EntryEvent] {
        &self.entry_log
    }

    /// Changes the arrival rate (vehicles per hour) of an entry node at runtime.
    pub fn set_demand(&mut self, node_id: &str, vehicles_per_hour: f64) -> Result<(), String> {
        if !(vehicles_per_hour.is_finite() && vehicles_per_hour >= 0.0) {
            return Err("demand must be finite and non-negative".into());
        }
        let node = self.net.node_index(node_id);
        let src = self
            .sources
            .iter_mut()
            .find(|s| Some(s.node) == node)
            .ok_or_else(|| format!("'{node_id}' is not an entry node"))?;
        set_rate(src, vehicles_per_hour, self.time);
        Ok(())
    }

    /// Current arrival rate (vehicles per hour) of an entry node.
    pub fn demand(&self, node_id: &str) -> Option<f64> {
        let node = self.net.node_index(node_id)?;
        self.sources
            .iter()
            .find(|s| s.node == node)
            .map(|s| s.rate * 3600.0)
    }

    /// Sets the travel time used for routing new vehicles (Phase 5 hook). Cached routes are
    /// dropped; vehicles already on their way keep their routes.
    pub fn set_link_travel_time(&mut self, link_id: &str, seconds: f64) -> Result<(), String> {
        let link = self
            .net
            .link_index(link_id)
            .ok_or_else(|| format!("unknown link '{link_id}'"))?;
        self.router.set_link_travel_time(link, seconds);
        self.route_cache.clear();
        self.dest_cache.clear();
        Ok(())
    }

    pub fn router(&self) -> &Router {
        &self.router
    }

    /// Cached route id from `from` to `to` for `class`.
    fn route_id(&mut self, from: u32, to: u32, class: VehicleClass) -> Option<u32> {
        let key = (from, to, class.id());
        if let Some(&id) = self.route_cache.get(&key) {
            return (id != NONE).then_some(id);
        }
        let id = match self.router.route(from, to, class) {
            Some(route) => {
                self.routes.push(route);
                (self.routes.len() - 1) as u32
            }
            None => NONE,
        };
        self.route_cache.insert(key, id);
        (id != NONE).then_some(id)
    }

    /// Reachable destinations from an entry link: (route id, cumulative weight).
    fn destinations(&mut self, entry: u32, class: VehicleClass) -> Vec<(u32, f64)> {
        if let Some(d) = self.dest_cache.get(&(entry, class.id())) {
            return d.clone();
        }
        let origin = self.net.links[entry as usize].from;
        let mut list = Vec::new();
        let mut acc = 0.0;
        for exit in 0..self.net.links.len() as u32 {
            let w = self.dest_weight[exit as usize];
            if w <= 0.0 || self.net.links[exit as usize].to == origin {
                continue;
            }
            if let Some(route) = self.route_id(entry, exit, class) {
                acc += w;
                list.push((route, acc));
            }
        }
        self.dest_cache.insert((entry, class.id()), list.clone());
        list
    }

    /// Next connector of a vehicle on (or about to enter) `lane`, following its route.
    fn connector_on_route(&self, v: &Vehicle, lane: u32) -> u32 {
        match self.routes[v.route as usize].get(v.route_pos as usize + 1) {
            Some(&next) => self.net.choose_connector(lane, next, v.params.class.mask()),
            None => NONE,
        }
    }

    fn has_next_link(&self, v: &Vehicle) -> bool {
        (v.route_pos as usize + 1) < self.routes[v.route as usize].len()
    }

    fn new_vehicle(&mut self, params: VehicleParams, lane: u32, pos: f64, speed: f64, route: u32) -> usize {
        let mut v = Vehicle {
            id: self.next_id,
            params,
            seg: lane,
            prev_seg: NONE,
            pos,
            speed,
            acc: 0.0,
            route,
            route_pos: 0,
            next_conn: NONE,
            claimed: NONE,
            stop_dist: f64::INFINITY,
            wait: 0.0,
            stop_done: false,
            lc_timer: 0.0,
            lat_offset: 0.0,
            depart: self.time,
            rank: 0,
            flags: 0,
            lost: false,
            lc_phase: (self.steps % u64::from(self.config.lane_change.interval)) as u32,
            alive: true,
        };
        v.next_conn = self.connector_on_route(&v, lane);
        self.next_id += 1;
        self.vehicles.push(v);
        self.vehicles.len() - 1
    }

    /// Places a vehicle directly (scenario scripting and tests): no gap check, routed from the
    /// lane's link to `dest_link_id`.
    pub fn place_vehicle(
        &mut self,
        link_id: &str,
        lane_index: u32,
        pos: f64,
        speed: f64,
        dest_link_id: &str,
        params: VehicleParams,
    ) -> Result<u32, String> {
        let link = self
            .net
            .link_index(link_id)
            .ok_or_else(|| format!("unknown link '{link_id}'"))?;
        let dest = self
            .net
            .link_index(dest_link_id)
            .ok_or_else(|| format!("unknown link '{dest_link_id}'"))?;
        let lane = self.net.link_lane(link, lane_index).ok_or("unknown lane")?;
        let route = self
            .route_id(link, dest, params.class)
            .ok_or("destination not reachable")?;
        let i = self.new_vehicle(params, lane, pos, speed, route);
        self.counters.spawned += 1;
        Ok(self.vehicles[i].id)
    }

    /// Advances the simulation by `n` steps.
    pub fn run(&mut self, n: usize) {
        for _ in 0..n {
            self.step();
        }
    }

    /// Advances the simulation by one time step.
    pub fn step(&mut self) {
        self.rebuild_lists();
        self.net.signals.states_into(self.time, &mut self.signal_state);
        self.spawn();
        self.lane_change_phase();
        self.junction_phase();
        self.compute_accelerations();
        self.integrate();
        self.steps += 1;
        self.time = self.steps as f64 * self.dt;
    }

    fn rebuild_lists(&mut self) {
        for &seg in &self.occupied {
            self.seg_vehicles[seg as usize].clear();
        }
        self.occupied.clear();
        for (i, v) in self.vehicles.iter().enumerate() {
            let list = &mut self.seg_vehicles[v.seg as usize];
            if list.is_empty() {
                self.occupied.push(v.seg);
            }
            list.push(i as u32);
        }
        let vehicles = &mut self.vehicles;
        for &seg in &self.occupied {
            let list = &mut self.seg_vehicles[seg as usize];
            list.sort_unstable_by(|&a, &b| {
                let (va, vb) = (&vehicles[a as usize], &vehicles[b as usize]);
                vb.pos.total_cmp(&va.pos).then(va.id.cmp(&vb.id))
            });
            for (rank, &i) in list.iter().enumerate() {
                vehicles[i as usize].rank = rank as u32;
            }
        }
    }

    fn spawn(&mut self) {
        for si in 0..self.sources.len() {
            while self.sources[si].next_arrival <= self.time {
                self.generate(si);
            }
            if self.vehicles.len() < self.config.max_vehicles as usize
                && let Some(pending) = self.sources[si].queue.front().cloned()
                && self.try_insert(&pending)
            {
                self.sources[si].queue.pop_front();
            }
        }
    }

    /// One arrival at source `si`: class, parameters, entry link and destination are drawn
    /// from the source's own RNG stream.
    fn generate(&mut self, si: usize) {
        let mut rng = self.sources[si].rng.clone();
        let u = rng.next_f64();
        let class = self
            .config
            .class_cdf()
            .iter()
            .find(|(_, cum)| u < *cum)
            .map_or(VehicleClass::Car, |(c, _)| *c);
        let params = VehicleParams::sample(class, self.config.heterogeneity, &mut rng);
        let links = &self.sources[si].links;
        let link = if links.len() == 1 {
            links[0]
        } else {
            links[((rng.next_f64() * links.len() as f64) as usize).min(links.len() - 1)]
        };
        let u_dest = rng.next_f64();
        let rate = self.sources[si].rate;
        let gap = exponential(&mut rng, rate);
        let src = &mut self.sources[si];
        src.next_arrival += gap;
        src.rng = rng;
        let dests = self.destinations(link, class);
        match dests.last() {
            Some(&(_, total)) => {
                let target = u_dest * total;
                let route = dests
                    .iter()
                    .find(|(_, cum)| target < *cum)
                    .unwrap_or(&dests[dests.len() - 1])
                    .0;
                self.sources[si].queue.push_back(Pending { params, link, route });
            }
            None => self.counters.unroutable += 1,
        }
    }

    /// Inserts a pending vehicle at the start of its entry link if a lane has a safe gap.
    fn try_insert(&mut self, p: &Pending) -> bool {
        let link = &self.net.links[p.link as usize];
        let mask = p.params.class.mask();
        let route = &self.routes[p.route as usize];
        let next = route.get(1).copied();
        let lanes = link.first_lane..link.first_lane + link.lane_count;
        let allowed = |l: &u32| self.net.lanes[*l as usize].class_mask & mask != 0;
        let on_route = |l: &u32| next.is_none_or(|n| self.net.choose_connector(*l, n, mask) != NONE);
        let candidates: Vec<u32> = if lanes.clone().any(|l| allowed(&l) && on_route(&l)) {
            lanes.filter(|l| allowed(l) && on_route(l)).collect()
        } else {
            lanes.filter(allowed).collect()
        };
        // Lane with the largest free space at its start (ties: rightmost).
        let mut best: Option<(u32, f64, f64)> = None;
        for lane in candidates {
            let (gap, leader_speed) = match self.seg_vehicles[lane as usize].last() {
                Some(&j) => {
                    let l = &self.vehicles[j as usize];
                    (l.pos - l.params.length, l.speed)
                }
                None => (f64::INFINITY, f64::INFINITY),
            };
            if best.is_none_or(|(_, g, _)| gap > g) {
                best = Some((lane, gap, leader_speed));
            }
        }
        let Some((lane, gap, leader_speed)) = best else {
            return false;
        };
        // Insert at the leader's speed (capped by the desired speed) once the equilibrium gap
        // for that speed is available.
        let pr = &p.params;
        let speed = pr
            .desired_speed(self.net.seg_speed_limit[lane as usize])
            .min(leader_speed);
        if gap < (pr.minimum_gap + speed * pr.time_headway).max(pr.minimum_gap + 0.5) {
            return false;
        }
        let i = self.new_vehicle(p.params, lane, 0.0, speed, p.route);
        let list = &mut self.seg_vehicles[lane as usize];
        if list.is_empty() {
            self.occupied.push(lane);
        }
        self.vehicles[i].rank = list.len() as u32;
        list.push(i as u32);
        self.counters.spawned += 1;
        true
    }

    fn compute_accelerations(&mut self) {
        let mut acc = std::mem::take(&mut self.scratch_acc);
        acc.clear();
        acc.extend((0..self.vehicles.len()).map(|i| self.acceleration(i)));
        for (v, a) in self.vehicles.iter_mut().zip(&acc) {
            v.acc = *a;
        }
        self.scratch_acc = acc;
    }

    /// IDM acceleration of vehicle `i`: leader along its path (lane → connector → lane …)
    /// within a look-ahead horizon, stop-line obstacles, dead ends and speed-limit changes.
    fn acceleration(&self, i: usize) -> f64 {
        let net = &self.net;
        let v = &self.vehicles[i];
        let p = &v.params;
        let speed = v.speed;
        let idm = p.idm(net.seg_speed_limit[v.seg as usize]);
        let mut a = idm.acceleration(speed, f64::INFINITY, 0.0);
        let follow =
            |a: f64, gap: f64, leader_speed: f64| a.min(idm.acceleration(speed, gap, speed - leader_speed));

        let mut leader_found = false;
        if v.rank > 0 {
            let l = &self.vehicles[self.seg_vehicles[v.seg as usize][v.rank as usize - 1] as usize];
            a = follow(a, l.pos - l.params.length - v.pos, l.speed);
            leader_found = true;
        }
        if v.stop_dist.is_finite() {
            a = follow(a, v.stop_dist - STOP_LINE_MARGIN, 0.0);
        }
        let mut dist = net.seg_length[v.seg as usize] - v.pos;
        if net.is_lane(v.seg) {
            // Vehicles that left this lane through another connector but still overlap it.
            for &c in net.lane_outgoing(v.seg) {
                if c == v.next_conn {
                    continue;
                }
                if let Some(&j) = self.seg_vehicles[net.connector_segment(c) as usize].last() {
                    let l = &self.vehicles[j as usize];
                    if l.pos < l.params.length {
                        a = follow(a, dist + l.pos - l.params.length, l.speed);
                    }
                }
            }
            if v.next_conn == NONE && self.has_next_link(v) && net.lane_outgoing(v.seg).is_empty() {
                a = follow(a, dist - STOP_LINE_MARGIN, 0.0);
            }
        }
        let horizon = (30.0 + speed * 7.0).min(250.0);
        let route = &self.routes[v.route as usize];
        let mask = p.class.mask();
        let mut rp = v.route_pos as usize;
        let mut cur = v.seg;
        let mut first = true;
        for _ in 0..8 {
            if dist > horizon {
                break;
            }
            let next = if net.is_lane(cur) {
                let c = if first {
                    first = false;
                    v.next_conn
                } else {
                    route
                        .get(rp + 1)
                        .map_or(NONE, |&l| net.choose_connector(cur, l, mask))
                };
                if c == NONE {
                    break;
                }
                rp += 1;
                net.connector_segment(c)
            } else {
                net.connectors[net.segment_connector(cur).unwrap_or(0) as usize].to_lane
            };
            let target = p.desired_speed(net.seg_speed_limit[next as usize]);
            if speed > target {
                let needed = (speed * speed - target * target) / (2.0 * dist.max(0.1));
                if needed > 0.5 * p.comfortable_deceleration {
                    a = a.min(-needed);
                }
            }
            if !leader_found && let Some(&j) = self.seg_vehicles[next as usize].last() {
                let l = &self.vehicles[j as usize];
                a = follow(a, dist + l.pos - l.params.length, l.speed);
                leader_found = true;
            }
            dist += net.seg_length[next as usize];
            cur = next;
        }
        a.max(-MAX_EMERGENCY_DECELERATION)
    }

    fn integrate(&mut self) {
        let dt = self.dt;
        let net = &self.net;
        let routes = &self.routes;
        let claims = &mut self.conn_claims;
        let counters = &mut self.counters;
        let lateral_rate = 3.25 / self.config.lane_change.visual_duration.max(dt);
        let arrival_time = self.time + dt;
        for v in &mut self.vehicles {
            let (dist, speed) = ballistic(v.speed, v.acc, dt);
            v.speed = speed;
            v.pos += dist;
            v.lc_timer = (v.lc_timer - dt).max(0.0);
            let lateral = lateral_rate * dt;
            v.lat_offset = if v.lat_offset.abs() <= lateral {
                0.0
            } else {
                v.lat_offset - lateral * v.lat_offset.signum()
            };
            loop {
                let len = net.seg_length[v.seg as usize];
                if v.pos <= len {
                    break;
                }
                match net.segment_connector(v.seg) {
                    None => {
                        let c = v.next_conn;
                        let route = &routes[v.route as usize];
                        if c == NONE {
                            if v.route_pos as usize + 1 >= route.len() && !v.lost {
                                counters.arrived += 1;
                                counters.travel_time_sum += arrival_time - v.depart;
                            } else {
                                counters.stranded += 1;
                            }
                            v.alive = false;
                            break;
                        }
                        let info = &net.connectors[c as usize];
                        if info.needs_decision && v.claimed != c {
                            // Hard stop line: never enter a controlled connector unclaimed.
                            v.pos = len;
                            v.speed = 0.0;
                            break;
                        }
                        if v.claimed == c {
                            claims[c as usize] -= 1;
                        }
                        v.claimed = NONE;
                        v.pos -= len;
                        v.prev_seg = v.seg;
                        v.seg = net.connector_segment(c);
                        v.route_pos += 1;
                        v.next_conn = match route.get(v.route_pos as usize + 1) {
                            Some(&next) => net.choose_connector(info.to_lane, next, v.params.class.mask()),
                            None => NONE,
                        };
                        v.stop_done = false;
                        v.wait = 0.0;
                    }
                    Some(c) => {
                        v.pos -= len;
                        v.prev_seg = v.seg;
                        v.seg = net.connectors[c as usize].to_lane;
                    }
                }
            }
            let mut f = 0;
            if v.acc < -1.0 {
                f |= flags::BRAKING;
            }
            if v.speed < 0.5 {
                f |= flags::WAITING;
            }
            if v.lat_offset != 0.0 {
                f |= flags::CHANGING_LANE;
            }
            if !net.is_lane(v.seg) {
                f |= flags::IN_JUNCTION;
            }
            if v.stop_dist.is_finite() {
                f |= flags::YIELDING;
            }
            v.flags = f;
            if !v.alive && v.claimed != NONE {
                claims[v.claimed as usize] -= 1;
            }
        }
        self.vehicles.retain(|v| v.alive);
    }

    /// Current statistics.
    pub fn stats(&self) -> Stats {
        let c = &self.counters;
        let n = self.vehicles.len();
        Stats {
            time: self.time,
            spawned: c.spawned,
            arrived: c.arrived,
            active: n as u64,
            waiting_to_enter: self.sources.iter().map(|s| s.queue.len() as u64).sum(),
            rerouted: c.rerouted,
            stranded: c.stranded,
            unroutable: c.unroutable,
            lane_changes: c.lane_changes,
            forced_entries: c.forced_entries,
            mean_travel_time: if c.arrived > 0 {
                c.travel_time_sum / c.arrived as f64
            } else {
                0.0
            },
            mean_speed: if n > 0 {
                self.vehicles.iter().map(|v| v.speed).sum::<f64>() / n as f64
            } else {
                0.0
            },
        }
    }

    pub fn stats_json(&self) -> String {
        serde_json::to_string(&self.stats()).unwrap_or_default()
    }

    /// Aspect of every signal group, in package order (controllers, then groups):
    /// 0 = red, 1 = amber, 2 = green.
    pub fn signal_states(&self) -> Vec<u8> {
        (0..self.net.signals.group_count())
            .map(|g| self.net.signals.state(g, self.time) as u8)
            .collect()
    }

    /// Ids of the signal groups in the order of [`Self::signal_states`].
    pub fn signal_group_ids(&self) -> Vec<String> {
        self.net.signals.groups.iter().map(|g| g.id.clone()).collect()
    }

    /// Packed vehicle state, [`SNAPSHOT_STRIDE`] floats per vehicle:
    /// `x, y, z` (vehicle centre, m), `heading` (rad, counter-clockwise from +x/east),
    /// `speed` (m/s), `length` (m), `class id`, `flags` (see [`flags`]), `vehicle id`.
    pub fn snapshot_into(&self, out: &mut Vec<f32>) {
        out.clear();
        out.reserve(self.vehicles.len() * SNAPSHOT_STRIDE);
        for v in &self.vehicles {
            let centre = v.pos - 0.5 * v.params.length;
            let (point, dir) = if centre >= 0.0 || v.prev_seg == NONE {
                self.net.point_at(v.seg, centre)
            } else {
                self.net
                    .point_at(v.prev_seg, self.net.seg_length[v.prev_seg as usize] + centre)
            };
            // Left normal of the driving direction.
            let (nx, ny) = (-dir[1], dir[0]);
            out.extend_from_slice(&[
                (point[0] + nx * v.lat_offset) as f32,
                (point[1] + ny * v.lat_offset) as f32,
                point[2] as f32,
                dir[1].atan2(dir[0]) as f32,
                v.speed as f32,
                v.params.length as f32,
                f32::from(v.params.class.id()),
                f32::from(v.flags),
                v.id as f32,
            ]);
        }
    }

    pub fn snapshot(&self) -> Vec<f32> {
        let mut out = Vec::new();
        self.snapshot_into(&mut out);
        out
    }

    /// FNV-1a hash over the complete dynamic state (time, vehicles, junction claims, sources,
    /// counters). Equal checksums after equal steps mean bit-identical runs.
    pub fn state_checksum(&self) -> u64 {
        let mut h = Fnv::new();
        h.u64(self.steps);
        h.f64(self.time);
        for v in &self.vehicles {
            h.u64(u64::from(v.id));
            h.u64(u64::from(v.seg));
            h.f64(v.pos);
            h.f64(v.speed);
            h.f64(v.acc);
            h.u64(u64::from(v.route_pos));
            h.u64(u64::from(v.claimed));
            h.f64(v.lat_offset);
            h.f64(v.params.speed_factor);
        }
        for &l in &self.conn_claims {
            h.u64(u64::from(l));
        }
        for s in &self.sources {
            h.f64(s.next_arrival);
            h.u64(s.queue.len() as u64);
        }
        let c = &self.counters;
        for x in [
            c.spawned,
            c.arrived,
            c.rerouted,
            c.stranded,
            c.unroutable,
            c.lane_changes,
            c.forced_entries,
        ] {
            h.u64(x);
        }
        h.f64(c.travel_time_sum);
        h.0
    }
}

fn set_rate(src: &mut Source, vehicles_per_hour: f64, now: f64) {
    src.rate = vehicles_per_hour / 3600.0;
    src.next_arrival = if src.rate > 0.0 {
        now + exponential(&mut src.rng, src.rate)
    } else {
        f64::INFINITY
    };
}

struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn u64(&mut self, x: u64) {
        for b in x.to_le_bytes() {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn f64(&mut self, x: f64) {
        self.u64(x.to_bits());
    }
}

#[cfg(test)]
mod tests;
