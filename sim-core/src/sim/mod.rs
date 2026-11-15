//! Microscopic simulation on a runtime network (#41, #42, #44, #45, #46, #48).
//!
//! One step (fixed Δt) runs these phases in a fixed order, each iterating vehicles in a stable
//! order (insertion order, compacted with `retain`):
//!
//! 1. rebuild the per-segment occupant lists (sorted by position, ties by vehicle id),
//! 2. periodic travel-time update and commuter re-routing (`reroute`), queue sampling and
//!    phenomena detection (`observe`),
//! 3. signal aspects for the current time (fixed time, then `actuated` controllers),
//! 4. arrivals (one RNG stream per process, `demand`) and insertion when the gap is safe,
//! 5. lane changes (MOBIL + mandatory route changes + merging courtesy; continuous lateral motion
//!    with the vehicle on both lanes, aborts), applied sequentially,
//! 6. junction decisions (signals, priority, gap acceptance on conflict zones), claims and the
//!    conflict-zone safety net applied sequentially,
//! 7. distraction lapses, then accelerations for all vehicles from the same state (IDM with
//!    perception delay, `perception`; cooperative yielding to mergers),
//! 8. ballistic integration, segment transitions, arrivals at exits, travel-time reports and
//!    metric accumulation; perception history; lane-cell bucket flush.
//!
//! The core has no I/O, no wall clock and no global RNG; identical package, config and seed
//! give bit-identical states (see [`Simulation::state_checksum`]).

mod actuated;
mod demand;
mod junction;
pub use demand::DemandSource;
mod lane_change;
mod observe;
mod pedestrians;
mod perception;
mod reroute;
mod transit;
pub use observe::{
    ApproachMetrics, EventCounts, JunctionMetrics, LinkMetrics, MovementMetrics, NetworkKpis, Summary,
};
pub use pedestrians::{CrossingMetrics, PEDESTRIAN_STRIDE, PedestrianStats, PedestrianSummary};
pub use transit::TransitLineMetrics;

use std::collections::BTreeMap;

use serde::Serialize;

use crate::config::SimConfig;
use crate::driver::Fleet;
use crate::metrics::{Metrics, cells};
use crate::network::{NONE, Network};
use crate::rng::Pcg32;
use crate::routing::{Fit, Router};
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
    /// Lane change in progress (#108).
    pub const CHANGING_LANE: u8 = 4;
    /// On a connector (inside a junction).
    pub const IN_JUNCTION: u8 = 8;
    /// Holding at a stop line (red signal, stop sign or yielding) or before an occupied conflict
    /// zone (#109).
    pub const YIELDING: u8 = 16;
    /// Bus dwelling at a stop (#85).
    pub const DWELLING: u8 = 32;
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
    /// Connectors behind `claimed` claimed together with it because the lanes in between are too
    /// short to stop on clear of the junctions (#117), [`NONE`]-padded.
    pub ahead: [u32; junction::CHAIN],
    /// Distance to a stop line the vehicle must hold at, `INFINITY` if none.
    pub stop_dist: f64,
    /// Distance to the entry of a conflict zone the vehicle must hold at because a conflicting
    /// vehicle occupies it (#109), `INFINITY` if none.
    pub zone_hold: f64,
    /// Distance to hold at before a pedestrian crossing (ADR-0020), `INFINITY` if none.
    pub ped_hold: f64,
    /// Why the vehicle holds before a crossing (`pedestrians::cause`).
    ped_cause: u8,
    /// Came to a stop in the current crossing hold (counted once).
    ped_stopped: bool,
    /// Time spent waiting at the current stop line (s).
    pub wait: f64,
    /// Full stop at a stop sign completed.
    pub stop_done: bool,
    /// Time until the next lane change is allowed (s).
    pub lc_timer: f64,
    /// Lateral offset from the lane centre (m, positive = left): follows the lane-change progress
    /// (#108), or decays to 0 after an instantaneous change (`laneChange.duration = 0`).
    pub lat_offset: f64,
    /// Lane being left during a lane change (#108), [`NONE`] otherwise. While changing, the
    /// vehicle occupies this lane (as a *shadow*) and its current lane `seg`.
    pub lc_from: u32,
    /// Progress of the current lane change in [0, 1).
    pub lc_progress: f64,
    /// Progress per second of the current lane change (1 / duration).
    lc_rate: f64,
    /// Insertion time (s).
    pub depart: f64,
    /// Index in the occupant list of `seg` (0 = most downstream).
    pub rank: u32,
    pub flags: u8,
    /// Re-routing found no way to the destination; removed at the end of its lane.
    pub lost: bool,
    /// Distance travelled since insertion (m).
    pub odo: f64,
    /// Time the vehicle entered its current link (s).
    pub link_enter: f64,
    /// Seconds below 0.5 m/s and seconds lost against the speed limit on the current link
    /// (junction movement metrics, #58).
    pub link_wait: f64,
    pub link_delay: f64,
    /// Trip totals (#125): seconds lost against the speed limit, seconds at a standstill and
    /// number of stops; `halted` while standing in the current stop.
    pub lost_time: f64,
    pub stopped_time: f64,
    pub stops: u32,
    halted: bool,
    /// Seconds at a standstill without interruption (stuck timeout, #126).
    still: f64,
    /// End of the current distraction lapse (s); in the past when attentive.
    pub lapse_until: f64,
    /// Start of the next distraction lapse (s).
    pub next_lapse: f64,
    /// Step phase of the staggered discretionary lane-change evaluation (set at insertion, so it
    /// does not depend on other sources' traffic).
    lc_phase: u32,
    /// Per-vehicle random stream (distraction lapses).
    rng: Pcg32,
    alive: bool,
}

impl Vehicle {
    /// Holding at a stop line (or before an occupied conflict zone) at (nearly) standstill.
    fn holding(&self) -> bool {
        (self.stop_dist.is_finite() || self.zone_hold.is_finite()) && self.speed < 0.5
    }

    /// Completes a lane change in progress (#108): the vehicle leaves its source lane.
    fn end_lane_change(&mut self) {
        if self.lc_from != NONE {
            self.lc_from = NONE;
            self.lc_progress = 0.0;
            self.lat_offset = 0.0;
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Counters {
    spawned: u64,
    arrived: u64,
    rerouted: u64,
    stranded: u64,
    removed_stuck: u64,
    unroutable: u64,
    lane_changes: u64,
    lane_change_aborts: u64,
    forced_entries: u64,
    lapses: u64,
    commuter_reroutes: u64,
    travel_time_sum: f64,
}

/// One vehicle for the inspector (#125): type, dimensions, trip so far and its route.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleInfo {
    pub id: u32,
    pub vehicle_type: String,
    pub class: VehicleClass,
    pub length: f64,
    pub width: f64,
    pub height: f64,
    pub weight: f64,
    /// Insertion time (s).
    pub depart: f64,
    pub travel_time: f64,
    /// Metres since insertion.
    pub distance: f64,
    pub speed: f64,
    pub speed_limit: f64,
    /// Seconds lost against the speed limit.
    pub lost_time: f64,
    pub stopped_time: f64,
    pub stops: u32,
    /// Seconds waiting at the current stop line.
    pub waiting: f64,
    /// Current link (the link being entered while on a connector).
    pub link: String,
    pub on_connector: bool,
    /// Link ids from origin to destination.
    pub route: Vec<String>,
    /// Index of `link` in `route`.
    pub route_pos: u32,
    /// Routes on experienced travel times (commuter).
    pub familiar: bool,
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
    /// Vehicles taken out after standing still inside a junction (`junction.stuckTimeout`, #126).
    pub removed_stuck: u64,
    /// Generated vehicles dropped because no destination was reachable.
    pub unroutable: u64,
    pub lane_changes: u64,
    /// Lane changes reversed because a conflict appeared in their first half (#108).
    pub lane_change_aborts: u64,
    /// Junction entries forced by the deadlock breaker (`junction.maxWait`).
    pub forced_entries: u64,
    /// Distraction lapses started (#52).
    pub lapses: u64,
    /// Route changes of familiar drivers en route on experienced travel times (#55).
    pub commuter_reroutes: u64,
    /// Mean travel time of arrived vehicles (s).
    pub mean_travel_time: f64,
    /// Mean speed of active vehicles (m/s).
    pub mean_speed: f64,
    /// Pedestrians at crossings (ADR-0020); absent without pedestrians.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pedestrians: Option<PedestrianStats>,
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
    /// Router on experienced travel times (familiar drivers).
    informed: Router,
    travel_times: reroute::TravelTimes,
    config: SimConfig,
    dt: f64,
    time: f64,
    steps: u64,
    vehicles: Vec<Vehicle>,
    next_id: u32,
    /// Occupants per segment, most downstream first.
    seg_vehicles: Vec<Vec<u32>>,
    occupied: Vec<u32>,
    /// Per lane: vehicles changing away from it (#108), most downstream first by their position
    /// projected onto the lane ([`Simulation::pos_on`]).
    seg_shadows: Vec<Vec<u32>>,
    shadowed: Vec<u32>,
    /// Vehicles that claimed each connector but have not entered it yet.
    conn_claims: Vec<u32>,
    conn_last_claim: Vec<f64>,
    signal_state: Vec<SignalState>,
    demand: demand::Demand,
    routes: Vec<Vec<u32>>,
    /// Routes by (from, to, class + informed, [`Router::fit_key`]).
    route_cache: BTreeMap<(u32, u32, u8, u64), u32>,
    /// Reachable destinations per (entry link, class, destination set): (route, cumulative weight).
    dest_cache: BTreeMap<DestKey, Vec<(u32, f64)>>,
    counters: Counters,
    fleet: Fleet,
    seed: u64,
    /// Perception history per vehicle (same order as `vehicles`).
    history: Vec<perception::History>,
    /// Run metrics (#57, #58, #62), `None` when disabled.
    metrics: Option<Box<Metrics>>,
    /// Vehicle-actuated signal controllers (#82).
    actuated: Vec<actuated::Controller>,
    scratch_acc: Vec<f64>,
    log_events: bool,
    lane_change_log: Vec<LaneChangeEvent>,
    entry_log: Vec<EntryEvent>,
    /// Buses on public transport lines (#85).
    transit: transit::Transit,
    /// Pedestrians at crossings (ADR-0020), `None` without crossings or when disabled.
    peds: Option<Box<pedestrians::Pedestrians>>,
}

/// Distance travelled and new speed after `dt` with constant acceleration, never reversing.
fn ballistic(speed: f64, acc: f64, dt: f64) -> (f64, f64) {
    if speed + acc * dt < 0.0 {
        (-0.5 * speed * speed / acc, 0.0)
    } else {
        (speed * dt + 0.5 * acc * dt * dt, speed + acc * dt)
    }
}

use perception::exponential;

/// Destination choice cache key: entry link, class + informed, destination set, [`Router::fit_key`].
type DestKey = (u32, u8, u32, u64);

/// Route cache flag of routes for familiar drivers (bit above the class id).
const INFORMED: u8 = 0x80;

fn cache_class(class: VehicleClass, informed: bool) -> u8 {
    class.id() | if informed { INFORMED } else { 0 }
}

/// Uniform index into a list of `n` items (no random number drawn for a single item).
fn pick_index(rng: &mut Pcg32, n: usize) -> usize {
    if n <= 1 {
        0
    } else {
        ((rng.next_f64() * n as f64) as usize).min(n - 1)
    }
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
        let fleet = config.fleet()?;
        let demand = demand::Demand::build(&net, &config, &fleet, seed)?;
        let metrics = if config.metrics.enabled {
            let m = Metrics::new(&net, &config.metrics, config.time_step, demand.start_time)?;
            Some(Box::new(m))
        } else {
            None
        };
        if let crate::config::ActuatedSelection::Nodes(nodes) = &config.signal_control.actuated {
            for id in nodes {
                let node = net.node_index(id);
                if !net.signals.controllers.iter().any(|c| Some(c.node) == node) {
                    return Err(format!("signalControl.actuated: '{id}' has no signal controller"));
                }
            }
        }
        let actuated = actuated::Controller::build(&net, |id| config.signal_control.actuated.includes(id));
        let peds = pedestrians::Pedestrians::build(&net, &config, seed, demand.start_time)?;
        let segments = net.segment_count();
        let connectors = net.connectors.len();
        let mut sim = Self {
            router: Router::new(&net),
            informed: Router::new(&net),
            travel_times: reroute::TravelTimes::new(&net, &config),
            dt: config.time_step,
            config,
            time: 0.0,
            steps: 0,
            vehicles: Vec::new(),
            next_id: 0,
            seg_vehicles: vec![Vec::new(); segments],
            occupied: Vec::new(),
            seg_shadows: vec![Vec::new(); net.lane_count()],
            shadowed: Vec::new(),
            conn_claims: vec![0; connectors],
            conn_last_claim: vec![f64::NEG_INFINITY; connectors],
            signal_state: Vec::new(),
            demand,
            routes: Vec::new(),
            route_cache: BTreeMap::new(),
            dest_cache: BTreeMap::new(),
            counters: Counters::default(),
            fleet,
            seed,
            history: Vec::new(),
            metrics,
            actuated,
            scratch_acc: Vec::new(),
            log_events: false,
            lane_change_log: Vec::new(),
            entry_log: Vec::new(),
            transit: transit::Transit::default(),
            peds,
            net,
        };
        sim.init_transit()?;
        Ok(sim)
    }

    pub fn network(&self) -> &Network {
        &self.net
    }

    pub fn config(&self) -> &SimConfig {
        &self.config
    }

    /// Vehicle types and driver profiles of this run.
    pub fn fleet(&self) -> &Fleet {
        &self.fleet
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

    /// Sets the travel time used for routing new vehicles (Phase 5 hook). Cached routes are
    /// dropped; vehicles already on their way keep their routes.
    pub fn set_link_travel_time(&mut self, link_id: &str, seconds: f64) -> Result<(), String> {
        let link = self
            .net
            .link_index(link_id)
            .ok_or_else(|| format!("unknown link '{link_id}'"))?;
        self.router.set_link_travel_time(link, seconds);
        self.route_cache.retain(|k, _| k.2 & INFORMED != 0);
        self.dest_cache.retain(|k, _| k.1 & INFORMED != 0);
        Ok(())
    }

    /// Router of drivers that do not know the network (free-flow times and
    /// [`Self::set_link_travel_time`] overrides).
    pub fn router(&self) -> &Router {
        &self.router
    }

    /// Router of familiar drivers (commuters): experienced travel times (#55).
    pub fn informed_router(&self) -> &Router {
        &self.informed
    }

    fn router_for(&self, informed: bool) -> &Router {
        if informed { &self.informed } else { &self.router }
    }

    /// Whether a driver routes on experienced travel times.
    fn is_informed(&self, p: &VehicleParams) -> bool {
        p.familiar && self.config.re_routing.enabled
    }

    /// Cached route id from `from` to `to` for a vehicle that needs `fit`.
    fn route_id(&mut self, from: u32, to: u32, fit: Fit, informed: bool) -> Option<u32> {
        let key = (
            from,
            to,
            cache_class(fit.class, informed),
            self.router.fit_key(&fit),
        );
        if let Some(&id) = self.route_cache.get(&key) {
            return (id != NONE).then_some(id);
        }
        let id = match self.router_for(informed).route_for(from, to, &fit) {
            Some(route) => {
                self.routes.push(route);
                (self.routes.len() - 1) as u32
            }
            None => NONE,
        };
        self.route_cache.insert(key, id);
        (id != NONE).then_some(id)
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
        let mut rng = Pcg32::new(self.seed, 0x5000_0000 + u64::from(self.next_id));
        let next_lapse = if params.lapse_rate > 0.0 && self.config.perception.enabled {
            self.time + exponential(&mut rng, params.lapse_rate)
        } else {
            f64::INFINITY
        };
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
            ahead: [NONE; junction::CHAIN],
            stop_dist: f64::INFINITY,
            zone_hold: f64::INFINITY,
            ped_hold: f64::INFINITY,
            ped_cause: 0,
            ped_stopped: false,
            wait: 0.0,
            stop_done: false,
            lc_timer: 0.0,
            lat_offset: 0.0,
            lc_from: NONE,
            lc_progress: 0.0,
            lc_rate: 0.0,
            depart: self.time,
            rank: 0,
            flags: 0,
            lost: false,
            odo: 0.0,
            link_enter: self.time - pos / self.net.seg_speed_limit[lane as usize],
            link_wait: 0.0,
            link_delay: 0.0,
            lost_time: 0.0,
            stopped_time: 0.0,
            stops: 0,
            halted: speed < cells::STOP_SPEED,
            still: 0.0,
            lapse_until: f64::NEG_INFINITY,
            next_lapse,
            lc_phase: (self.steps % u64::from(self.config.lane_change.interval)) as u32,
            rng,
            alive: true,
        };
        v.next_conn = self.connector_on_route(&v, lane);
        self.next_id += 1;
        self.vehicles.push(v);
        self.history
            .push(perception::History::new(self.steps, 0.0, speed, self.dt));
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
            .route_id(link, dest, Fit::of(&params), false)
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
        self.update_travel_times();
        self.sample_metrics();
        self.net.signals.states_into(self.time, &mut self.signal_state);
        self.update_actuated();
        self.update_pedestrian_signals();
        self.spawn();
        self.spawn_transit();
        self.lane_change_phase();
        self.junction_phase();
        self.pedestrian_phase();
        if self.config.perception.enabled {
            self.update_lapses();
        }
        self.compute_accelerations();
        self.integrate();
        self.update_transit();
        self.steps += 1;
        self.time = self.steps as f64 * self.dt;
        self.record_history();
        if let Some(m) = self.metrics.as_deref_mut()
            && self.steps.is_multiple_of(m.bucket_steps)
        {
            m.flush();
        }
    }

    fn rebuild_lists(&mut self) {
        for &seg in &self.occupied {
            self.seg_vehicles[seg as usize].clear();
        }
        self.occupied.clear();
        for &lane in &self.shadowed {
            self.seg_shadows[lane as usize].clear();
        }
        self.shadowed.clear();
        for (i, v) in self.vehicles.iter().enumerate() {
            if self.transit.in_bay(v) {
                continue; // a bus standing in a bay is off its lane (#85)
            }
            let list = &mut self.seg_vehicles[v.seg as usize];
            if list.is_empty() {
                self.occupied.push(v.seg);
            }
            list.push(i as u32);
            if v.lc_from != NONE {
                let list = &mut self.seg_shadows[v.lc_from as usize];
                if list.is_empty() {
                    self.shadowed.push(v.lc_from);
                }
                list.push(i as u32);
            }
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
        for k in 0..self.shadowed.len() {
            let lane = self.shadowed[k];
            let mut list = std::mem::take(&mut self.seg_shadows[lane as usize]);
            list.sort_unstable_by(|&a, &b| {
                let (pa, pb) = (self.pos_on(a, lane), self.pos_on(b, lane));
                pb.total_cmp(&pa)
                    .then(self.vehicles[a as usize].id.cmp(&self.vehicles[b as usize].id))
            });
            self.seg_shadows[lane as usize] = list;
        }
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
        if self.transit.dwelling(v) {
            return 0.0;
        }
        let p = &v.params;
        let speed = v.speed;
        let idm = p.idm(net.seg_speed_limit[v.seg as usize]);
        let perceive = self.config.perception.enabled;
        let delay = if perceive {
            perception::Delay::new(p.reaction_time, self.dt)
        } else {
            None
        };
        let mut a = perception::Accel::new(idm.acceleration(speed, f64::INFINITY, 0.0));

        let mut leader_found = false;
        if v.rank > 0 {
            let j = self.seg_vehicles[v.seg as usize][v.rank as usize - 1];
            let l = &self.vehicles[j as usize];
            self.follow_vehicle(&mut a, &idm, speed, l.pos - l.params.length - v.pos, j, delay);
            leader_found = true;
        }
        // Vehicles changing away from this lane still occupy it (#108); a vehicle changing lanes
        // also follows the leader on the lane it is leaving.
        if net.is_lane(v.seg) {
            if let (Some((j, p)), _) = self.shadows_around(v.seg, v.pos, v.id) {
                let gap = p - self.vehicles[j as usize].params.length - v.pos;
                self.follow_vehicle(&mut a, &idm, speed, gap, j, delay);
                leader_found = true;
            }
            if v.lc_from != NONE {
                let s = self.pos_on(i as u32, v.lc_from);
                if let (Some((j, p)), _) = self.occupants_around(v.lc_from, s, v.id) {
                    let gap = p - self.vehicles[j as usize].params.length - s;
                    self.follow_vehicle(&mut a, &idm, speed, gap, j, delay);
                }
            }
        }
        if v.stop_dist.is_finite() {
            Self::stop_at(&mut a, &idm, speed, v.stop_dist);
        }
        if v.zone_hold.is_finite() {
            Self::stop_at(&mut a, &idm, speed, v.zone_hold);
        }
        self.transit_stop(&mut a, &idm, i);
        if v.ped_hold.is_finite() {
            Self::stop_at(&mut a, &idm, speed, v.ped_hold);
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
                        self.follow_vehicle(&mut a, &idm, speed, dist + l.pos - l.params.length, j, delay);
                    }
                }
            }
            if v.next_conn == NONE && self.has_next_link(v) && net.lane_outgoing(v.seg).is_empty() {
                Self::stop_at(&mut a, &idm, speed, dist);
            }
        }
        let horizon = (30.0 + speed * 7.0).min(250.0);
        // Vehicles ahead on connectors merging with ours (#109).
        if let Some(c) = net.segment_connector(v.seg)
            && let Some((j, gap)) = self.merging_leader(c, dist, i as u32)
        {
            self.follow_vehicle(&mut a, &idm, speed, gap, j, delay);
        }
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
            if let Some(c) = net.segment_connector(next)
                && let Some((j, gap)) = self.merging_leader(c, dist + net.seg_length[next as usize], i as u32)
            {
                self.follow_vehicle(&mut a, &idm, speed, gap, j, delay);
            }
            let target = p.desired_speed(net.seg_speed_limit[next as usize]);
            if speed > target {
                let needed = (speed * speed - target * target) / (2.0 * dist.max(0.1));
                if needed > 0.5 * p.comfortable_deceleration {
                    a.limit(-needed);
                }
            }
            if !leader_found && let Some((j, p)) = self.last_on(next) {
                let l = &self.vehicles[j as usize];
                self.follow_vehicle(&mut a, &idm, speed, dist + p - l.params.length, j, delay);
                leader_found = true;
            }
            dist += net.seg_length[next as usize];
            cur = next;
        }
        // Cooperative yielding (#81): let a merger slightly ahead on the ending lane to the right
        // in front of us, unless our own leader is between us and it or it would take harder
        // braking than `maxCooperativeDeceleration`.
        let merging = &self.config.merging;
        if merging.cooperation
            && let Some((j, m_pos)) = self.merger_near(i, 60.0, 5.0)
        {
            let own_leader_ahead = v.rank > 0 && {
                let l = self.seg_vehicles[v.seg as usize][v.rank as usize - 1];
                self.vehicles[l as usize].pos < m_pos
            };
            if !own_leader_ahead {
                let m = &self.vehicles[j as usize];
                let gap = m_pos - m.params.length - v.pos;
                let yield_acc = idm.acceleration(speed, gap, speed - m.speed);
                if yield_acc >= -merging.max_cooperative_deceleration {
                    a.limit(yield_acc);
                }
            }
        }
        let lapse = (perceive && self.time < v.lapse_until).then_some(v.acc);
        let acc = a.resolve(
            lapse,
            self.config.perception.emergency_factor * p.comfortable_deceleration,
        );
        // Gradients (#87): untouched on level segments.
        let grade = net.grade_at(v.seg, v.pos);
        if grade == 0.0 {
            acc
        } else {
            crate::grade::apply(acc, p.max_acceleration, p.specific_power, speed, grade)
        }
    }

    fn integrate(&mut self) {
        let dt = self.dt;
        let net = &self.net;
        let routes = &self.routes;
        let claims = &mut self.conn_claims;
        let counters = &mut self.counters;
        let travel_times = &mut self.travel_times;
        let lateral_rate = 3.25 / self.config.lane_change.visual_duration.max(dt);
        let stuck_timeout = self.config.junction.stuck_timeout;
        let arrival_time = self.time + dt;
        let mut metrics = self.metrics.as_deref_mut();
        let lane_count = net.lane_count() as u32;
        let step = self.steps;
        for v in &mut self.vehicles {
            let old = (v.seg, v.pos, v.speed);
            let (dist, speed) = ballistic(v.speed, v.acc, dt);
            v.speed = speed;
            v.pos += dist;
            v.odo += dist;
            v.lc_timer = (v.lc_timer - dt).max(0.0);
            if v.lc_from != NONE {
                v.lc_progress += v.lc_rate * dt;
                if v.lc_progress >= 1.0 {
                    v.end_lane_change();
                }
            }
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
                                travel_times
                                    .record(net.lanes[v.seg as usize].link, arrival_time - v.link_enter);
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
                        travel_times.record(info.from_link, arrival_time - v.link_enter);
                        if let Some(m) = &mut metrics {
                            let mv = &mut m.movements[c as usize];
                            mv.count += 1;
                            mv.wait += v.link_wait;
                            mv.delay += v.link_delay;
                        }
                        v.claimed = NONE;
                        v.pos -= len;
                        v.prev_seg = v.seg;
                        v.seg = net.connector_segment(c);
                        // Leaving the lane completes a lane change in progress.
                        v.end_lane_change();
                        v.route_pos += 1;
                        v.next_conn = match route.get(v.route_pos as usize + 1) {
                            Some(&next) => net.choose_connector(info.to_lane, next, v.params.class.mask()),
                            None => NONE,
                        };
                        v.stop_done = false;
                        v.wait = 0.0;
                        // Chained junctions (#117): the claim moves on to the next connector.
                        if v.ahead[0] != NONE {
                            if v.ahead[0] == v.next_conn {
                                v.claimed = v.ahead[0];
                                v.ahead.copy_within(1.., 0);
                                v.ahead[junction::CHAIN - 1] = NONE;
                            } else {
                                for a in v.ahead.iter_mut().filter(|a| **a != NONE) {
                                    claims[*a as usize] -= 1;
                                    *a = NONE;
                                }
                            }
                        }
                    }
                    Some(c) => {
                        v.pos -= len;
                        v.prev_seg = v.seg;
                        v.seg = net.connectors[c as usize].to_lane;
                        v.link_enter = arrival_time;
                        v.link_wait = 0.0;
                        v.link_delay = 0.0;
                    }
                }
            }
            if v.lc_from != NONE {
                v.lat_offset = lane_change::change_offset(net, v.lc_from, v.seg, v.lc_progress);
            } else {
                let lateral = lateral_rate * dt;
                v.lat_offset = if v.lat_offset.abs() <= lateral {
                    0.0
                } else {
                    v.lat_offset - lateral * v.lat_offset.signum()
                };
            }
            let lost = dt * (1.0 - v.speed / net.seg_speed_limit[v.seg as usize]).max(0.0);
            v.lost_time += lost;
            v.still = if v.speed < 0.1 { v.still + dt } else { 0.0 };
            if stuck_timeout > 0.0 && v.alive && v.still > stuck_timeout && !net.is_lane(v.seg) {
                counters.removed_stuck += 1;
                v.alive = false;
            }
            if v.speed < cells::STOP_SPEED {
                v.stopped_time += dt;
                if !v.halted {
                    v.halted = true;
                    v.stops += 1;
                }
            } else if v.speed > 2.0 * cells::STOP_SPEED {
                v.halted = false;
            }
            if v.seg < lane_count {
                v.link_delay += lost;
                if v.speed < cells::STOP_SPEED {
                    v.link_wait += dt;
                }
            }
            if let Some(m) = &mut metrics {
                m.observe(lane_count, old, (v.seg, v.pos, v.speed), v.alive, dt, step);
            }
            let mut f = 0;
            if v.acc < -1.0 {
                f |= flags::BRAKING;
            }
            if v.speed < 0.5 {
                f |= flags::WAITING;
            }
            if v.lc_from != NONE || v.lat_offset != 0.0 {
                f |= flags::CHANGING_LANE;
            }
            if !net.is_lane(v.seg) {
                f |= flags::IN_JUNCTION;
            }
            if v.stop_dist.is_finite() || v.zone_hold.is_finite() || v.ped_hold.is_finite() {
                f |= flags::YIELDING;
            }
            v.flags = f;
            if !v.alive {
                for &c in std::iter::once(&v.claimed)
                    .chain(&v.ahead)
                    .filter(|&&c| c != NONE)
                {
                    claims[c as usize] -= 1;
                }
            }
        }
        self.remove_departed();
    }

    /// Drops departed vehicles, keeping the order of the others (and their histories).
    fn remove_departed(&mut self) {
        let mut w = 0;
        for r in 0..self.vehicles.len() {
            if self.vehicles[r].alive {
                if w != r {
                    self.vehicles.swap(w, r);
                    self.history.swap(w, r);
                }
                w += 1;
            }
        }
        self.vehicles.truncate(w);
        self.history.truncate(w);
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
            waiting_to_enter: self.demand.waiting(),
            rerouted: c.rerouted,
            stranded: c.stranded,
            removed_stuck: c.removed_stuck,
            unroutable: c.unroutable,
            lane_changes: c.lane_changes,
            lane_change_aborts: c.lane_change_aborts,
            forced_entries: c.forced_entries,
            lapses: c.lapses,
            commuter_reroutes: c.commuter_reroutes,
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
            pedestrians: self.pedestrian_stats(),
        }
    }

    pub fn stats_json(&self) -> String {
        serde_json::to_string(&self.stats()).unwrap_or_default()
    }

    /// Aspect of every signal group, in package order (controllers, then groups):
    /// 0 = red, 1 = amber, 2 = green.
    pub fn signal_states(&self) -> Vec<u8> {
        let mut states = Vec::new();
        self.net.signals.states_into(self.time, &mut states);
        for c in &self.actuated {
            c.write_states(&mut states);
        }
        if let Some(p) = self.peds.as_deref() {
            p.write_signal_states(&mut states);
        }
        states.into_iter().map(|s| s as u8).collect()
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
            let mut heading = dir[1].atan2(dir[0]);
            if v.lc_from != NONE {
                // Yaw of the lateral motion (#108); lateral speed relative to at least 3 m/s so a
                // slow vehicle does not turn sideways.
                let lateral =
                    lane_change::change_lateral_speed(&self.net, v.lc_from, v.seg, v.lc_progress, v.lc_rate);
                heading += lateral.atan2(v.speed.max(3.0));
            }
            out.extend_from_slice(&[
                (point[0] + nx * v.lat_offset) as f32,
                (point[1] + ny * v.lat_offset) as f32,
                point[2] as f32,
                heading as f32,
                v.speed as f32,
                v.params.length as f32,
                f32::from(v.params.class.id()),
                f32::from(v.flags),
                v.id as f32,
            ]);
        }
    }

    /// State and trip so far of one vehicle (#125, for the vehicle inspector), `None` once it left.
    pub fn vehicle_info(&self, id: u32) -> Option<VehicleInfo> {
        let v = self.vehicles.iter().find(|v| v.id == id)?;
        let net = &self.net;
        let route = &self.routes[v.route as usize];
        let link = |l: u32| net.links[l as usize].id.clone();
        let p = &v.params;
        Some(VehicleInfo {
            id,
            vehicle_type: self.fleet.catalogue.name(p.vehicle_type).to_string(),
            class: p.class,
            length: p.length,
            width: p.width,
            height: p.height,
            weight: p.weight,
            depart: v.depart,
            travel_time: self.time - v.depart,
            distance: v.odo,
            speed: v.speed,
            speed_limit: net.seg_speed_limit[v.seg as usize],
            lost_time: v.lost_time,
            stopped_time: v.stopped_time,
            stops: v.stops,
            waiting: v.wait,
            link: link(net.segment_link(v.seg)),
            on_connector: !net.is_lane(v.seg),
            route: route.iter().map(|&l| link(l)).collect(),
            route_pos: v.route_pos,
            familiar: p.familiar,
        })
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
            // Only hashed when used, so states without chained junctions keep their checksums.
            for &a in v.ahead.iter().filter(|&&a| a != NONE) {
                h.u64(u64::from(a));
            }
            h.f64(v.lat_offset);
            h.u64(u64::from(v.lc_from));
            h.f64(v.lc_progress);
            h.f64(v.params.speed_factor);
            h.f64(v.odo);
            h.f64(v.lapse_until);
        }
        for &l in &self.conn_claims {
            h.u64(u64::from(l));
        }
        for s in &self.demand.sources {
            h.f64(s.next_arrival);
        }
        for q in &self.demand.queues {
            h.u64(q.queue.len() as u64);
        }
        let c = &self.counters;
        for x in [
            c.spawned,
            c.arrived,
            c.rerouted,
            c.stranded,
            c.unroutable,
            c.lane_changes,
            c.lane_change_aborts,
            c.forced_entries,
            c.lapses,
            c.commuter_reroutes,
        ] {
            h.u64(x);
        }
        for &t in &self.travel_times.smoothed {
            h.f64(t);
        }
        for c in &self.actuated {
            h.u64(c.phase as u64);
            h.f64(c.since);
        }
        h.f64(c.travel_time_sum);
        self.transit.hash(&mut h);
        if let Some(p) = self.peds.as_deref() {
            p.hash(&mut h);
        }
        h.0
    }
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
