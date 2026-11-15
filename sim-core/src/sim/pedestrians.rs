//! Pedestrians at crossings (ADR-0020, #86): crossing demand, not agents on a footway network.
//!
//! Per crossing, pedestrians arrive at either kerb (Poisson process from a per-crossing seeded
//! stream), wait, and cross at their walking speed; everybody waiting at a kerb starts together
//! (groups). The crossing is split into the lateral *spans* of the crossed links. Before entering
//! a span, a pedestrian checks it against the vehicles of that link (see [`Rule`]):
//!
//! - **priority** (zebra): nothing on the crossing and every approaching vehicle can still stop
//!   comfortably; vehicles stop for pedestrians on the crossing and for pedestrians waiting to step
//!   onto their span;
//! - **gap** (uncontrolled, unmarked): the next vehicle reaches the crossing no earlier than the
//!   span's crossing time plus `pedestrians.gapMargin`;
//! - **signal**: the first span only on the walk aspect (parallel green, or the pedestrian phase of
//!   a push-button signal), then like a zebra crossing without the waiting pedestrians' priority.
//!
//! Vehicles hold before a blocked crossing (a standing obstacle as at a red line) when they can
//! still stop, and stop before a signalised crosswalk rather than on it when they hold at the line
//! anyway. Push-button signals (`request` mode) replace the fixed-time plan of their group: after
//! `minVehicleGreen` a waiting pedestrian turns it amber, all-red, walk, clearance, green.
//!
//! Runs after the junction phase; it only reads the vehicle state of the step and writes the
//! vehicles' crossing holds, so the step order stays deterministic. Without crossings (or with
//! `pedestrians.enabled = false`) nothing here runs.

use serde::Serialize;

use super::perception::exponential;
use super::{Fnv, Simulation};
use crate::config::SimConfig;
use crate::crossings::{CrossingKind, Rule, SignalMode};
use crate::demand::{TimeProfile, resolve_profile};
use crate::network::{NONE, Network};
use crate::rng::Pcg32;
use crate::signals::SignalState;

/// Floats per pedestrian in [`Simulation::pedestrian_snapshot_into`].
pub const PEDESTRIAN_STRIDE: usize = 5;

/// Pedestrians within this distance (m) of a span block its vehicles.
const SPAN_BUFFER: f64 = 1.0;
/// Distance (m) a holding vehicle keeps from the crossing (on top of the IDM standstill gap).
const HOLD_MARGIN: f64 = 1.0;
/// Pedestrians step out while approaching vehicles need at most this multiple of their
/// comfortable deceleration to stop.
const STEP_OUT_TOLERANCE: f64 = 1.2;
/// Vehicles stop for waiting pedestrians (and before crosswalks at red) up to this multiple of
/// their comfortable deceleration.
const YIELD_FACTOR: f64 = 1.5;
/// Arrival re-check interval (s) while a crossing has no demand.
const IDLE_RECHECK: f64 = 60.0;
/// A vehicle holding at a stop line stops before a signalised crosswalk this close (m) to it.
const STOP_LINE_REACH: f64 = 15.0;
/// RNG stream base of the crossings (one stream per crossing).
const STREAM: u64 = 0x6000_0000;

/// Why a vehicle holds before a crossing.
pub(super) mod cause {
    pub const NONE: u8 = 0;
    /// Pedestrians on (or waiting to step onto) the crossing.
    pub const PEDESTRIANS: u8 = 1;
    /// Holding at the stop line anyway: stop before the crosswalk, not on it.
    pub const STOP_LINE: u8 = 2;
}

#[derive(Debug, Clone, PartialEq)]
struct Waiting {
    arrival: f64,
    speed: f64,
}

#[derive(Debug, Clone, PartialEq)]
struct Walker {
    /// Distance from the first kerb (m).
    pos: f64,
    /// +1 from the first kerb to the second, -1 back.
    dir: f64,
    speed: f64,
    arrival: f64,
    /// Waiting at a span boundary for entry `next`.
    paused: bool,
    next: u32,
    slot: u32,
}

#[derive(Debug, Clone, PartialEq)]
struct CrossingState {
    rng: Pcg32,
    /// Pedestrians per second before the time-of-day curve.
    rate: f64,
    next_arrival: f64,
    waiting: [Vec<Waiting>; 2],
    walking: Vec<Walker>,
    /// Request controller index, [`NONE`] if none.
    controller: u32,
    arrived: u64,
    served: u64,
    delay: f64,
    max_waiting: u32,
    next_slot: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    VehicleGreen,
    VehicleAmber,
    AllRed,
    Walk,
    Clearance,
}

/// Warning time before the walk phase of a push button without a vehicle signal (#152).
const STANDALONE_AMBER: f64 = 3.0;

/// Push-button signal: a pedestrian phase on request (replaces the group's fixed-time plan).
#[derive(Debug, Clone, PartialEq)]
struct RequestController {
    group: u32,
    crossings: Vec<u32>,
    stage: Stage,
    since: f64,
    amber: f64,
    clearance: f64,
    phases: u64,
}

/// What a crossing entry's pedestrians see of the link's vehicles in this step.
#[derive(Debug, Clone, Copy, PartialEq)]
struct EntryView {
    /// A vehicle is on the crossing.
    occupied: bool,
    /// An approaching vehicle could not stop comfortably before it.
    cannot_stop: bool,
    /// Earliest arrival (s) of an approaching vehicle at the crossing.
    min_time: f64,
}

const CLEAR: EntryView = EntryView {
    occupied: false,
    cannot_stop: false,
    min_time: f64::INFINITY,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Block {
    None,
    /// Pedestrians waiting to step onto the span (priority crossings).
    Committed,
    /// Pedestrians on the span.
    OnCrossing,
}

/// Pedestrian state of a run.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Pedestrians {
    crossings: Vec<CrossingState>,
    controllers: Vec<RequestController>,
    curve: Option<TimeProfile>,
    start_time: f64,
    views: Vec<EntryView>,
    active: Vec<bool>,
    walk: Vec<bool>,
    /// (vehicle index, entry, distance from the vehicle front to the crossing) in path order.
    upcoming: Vec<(u32, u32, f64)>,
    vehicle_stops: u64,
    vehicle_delay: f64,
}

/// Network-wide pedestrian KPIs of the run summary.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PedestrianSummary {
    /// Pedestrians that arrived at a crossing.
    pub arrived: u64,
    /// Pedestrians that completed their crossing.
    pub served: u64,
    /// Currently waiting and crossing.
    pub waiting: u64,
    pub crossing: u64,
    /// Mean delay of served pedestrians (s): time to cross minus the walking time.
    pub mean_delay: Option<f64>,
    /// Vehicles that came to a stop for pedestrians, and their delay (vehicle-hours).
    pub vehicle_stops: u64,
    pub vehicle_delay_hours: f64,
    /// Pedestrian phases served by push-button signals.
    pub signal_phases: u64,
    pub crossings: Vec<CrossingMetrics>,
}

/// Per-crossing pedestrian KPIs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossingMetrics {
    pub id: String,
    pub kind: String,
    pub arrived: u64,
    pub served: u64,
    pub mean_delay: Option<f64>,
    pub max_waiting: u32,
}

/// Live pedestrian counts (`statsJson`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PedestrianStats {
    pub served: u64,
    pub waiting: u64,
    pub crossing: u64,
    pub mean_delay: f64,
}

fn kind_name(kind: CrossingKind) -> &'static str {
    match kind {
        CrossingKind::Zebra => "zebra",
        CrossingKind::Signal => "signal",
        CrossingKind::Uncontrolled => "uncontrolled",
        CrossingKind::Unmarked => "unmarked",
    }
}

impl Pedestrians {
    /// Pedestrian state for a run; `None` without crossings or with pedestrians disabled.
    pub(super) fn build(
        net: &Network,
        config: &SimConfig,
        seed: u64,
        start_time: f64,
    ) -> Result<Option<Box<Self>>, String> {
        let pc = &config.pedestrians;
        if !pc.enabled || net.crossings.is_empty() {
            return Ok(None);
        }
        // Unknown ids in `pedestrians.crossings` are ignored: scenario demand outlives network
        // edits that renumber crossings.
        let curve = match &pc.curve {
            Some(name) => Some(resolve_profile(&config.curves, name)?),
            None => None,
        };
        let slowest = pc.walk_speed * (1.0 - pc.walk_speed_spread);
        let mut controllers: Vec<RequestController> = Vec::new();
        let mut crossings = Vec::with_capacity(net.crossings.len());
        for (x, info) in net.crossings.list.iter().enumerate() {
            let demand = pc.crossings.get(&info.id).copied().unwrap_or(info.demand);
            let mut controller = NONE;
            if info.kind == CrossingKind::Signal && info.signal_group == NONE {
                // No vehicle signal (#152: crossing=traffic_signals on an unsignalled junction): a push
                // button of its own; vehicles give way to the pedestrians walking in its phases.
                controllers.push(RequestController {
                    group: NONE,
                    crossings: vec![x as u32],
                    stage: Stage::VehicleGreen,
                    since: 0.0,
                    amber: STANDALONE_AMBER,
                    clearance: info.width / slowest,
                    phases: 0,
                });
                controller = (controllers.len() - 1) as u32;
            } else if info.mode == SignalMode::Request {
                let clearance = info.width / slowest;
                let k = match controllers
                    .iter()
                    .position(|c| c.group != NONE && c.group == info.signal_group)
                {
                    Some(k) => k,
                    None => {
                        controllers.push(RequestController {
                            group: info.signal_group,
                            crossings: Vec::new(),
                            stage: Stage::VehicleGreen,
                            since: 0.0,
                            amber: net.signals.groups[info.signal_group as usize].amber,
                            clearance: 0.0,
                            phases: 0,
                        });
                        controllers.len() - 1
                    }
                };
                controllers[k].crossings.push(x as u32);
                controllers[k].clearance = controllers[k].clearance.max(clearance);
                controller = k as u32;
            }
            crossings.push(CrossingState {
                rng: Pcg32::new(seed, STREAM + x as u64),
                rate: demand * pc.demand_factor / 3600.0,
                next_arrival: 0.0,
                waiting: [Vec::new(), Vec::new()],
                walking: Vec::new(),
                controller,
                arrived: 0,
                served: 0,
                delay: 0.0,
                max_waiting: 0,
                next_slot: 0,
            });
        }
        let mut p = Self {
            crossings,
            controllers,
            curve,
            start_time,
            views: vec![CLEAR; net.crossings.entries.len()],
            active: vec![false; net.crossings.len()],
            walk: vec![false; net.crossings.len()],
            upcoming: Vec::new(),
            vehicle_stops: 0,
            vehicle_delay: 0.0,
        };
        for x in 0..p.crossings.len() {
            p.schedule(x, 0.0);
        }
        Ok(Some(Box::new(p)))
    }

    /// Draws the next arrival after `now` at the current (curve-scaled) rate.
    fn schedule(&mut self, x: usize, now: f64) {
        let factor = self
            .curve
            .as_ref()
            .map_or(1.0, |c| c.factor(self.start_time + now));
        let s = &mut self.crossings[x];
        let rate = s.rate * factor;
        s.next_arrival = if rate > 0.0 {
            now + exponential(&mut s.rng, rate)
        } else {
            now + IDLE_RECHECK
        };
    }

    /// Request controllers' aspects over the fixed-time states of their groups.
    pub(super) fn write_signal_states(&self, out: &mut [SignalState]) {
        for c in self.controllers.iter().filter(|c| c.group != NONE) {
            out[c.group as usize] = match c.stage {
                Stage::VehicleGreen => SignalState::Green,
                Stage::VehicleAmber => SignalState::Amber,
                _ => SignalState::Red,
            };
        }
    }

    pub(super) fn reset_totals(&mut self) {
        for s in &mut self.crossings {
            s.arrived = 0;
            s.served = 0;
            s.delay = 0.0;
            s.max_waiting = 0;
        }
        for c in &mut self.controllers {
            c.phases = 0;
        }
        self.vehicle_stops = 0;
        self.vehicle_delay = 0.0;
    }

    pub(super) fn hash(&self, h: &mut Fnv) {
        for s in &self.crossings {
            h.f64(s.next_arrival);
            h.u64(s.waiting[0].len() as u64);
            h.u64(s.waiting[1].len() as u64);
            for w in &s.walking {
                h.f64(w.pos);
                h.u64(u64::from(w.paused));
            }
            h.u64(s.served);
        }
        for c in &self.controllers {
            h.u64(c.stage as u64);
            h.f64(c.since);
        }
        h.u64(self.vehicle_stops);
    }

    /// Which pedestrians block entry `e` for its vehicles.
    fn blocked(&self, net: &Network, e: u32) -> Block {
        let cr = &net.crossings;
        let entry = &cr.entries[e as usize];
        let x = entry.crossing as usize;
        let rule = cr.list[x].rule();
        let s = &self.crossings[x];
        let (a, b) = entry.span;
        let mut block = Block::None;
        for w in &s.walking {
            if w.paused {
                if w.next == e && rule != Rule::Gap {
                    block = Block::Committed;
                }
                continue;
            }
            // Entered the span (its boundary check passed) and not yet a buffer beyond it.
            let (entered, cleared, near) = if w.dir > 0.0 {
                (
                    w.pos >= a - 1e-9,
                    w.pos > b + SPAN_BUFFER,
                    w.pos >= a - SPAN_BUFFER,
                )
            } else {
                (
                    w.pos <= b + 1e-9,
                    w.pos < a - SPAN_BUFFER,
                    w.pos <= b + SPAN_BUFFER,
                )
            };
            if entered && !cleared {
                return Block::OnCrossing;
            }
            // About to step onto the span (not at gap-acceptance crossings: they check it first).
            if !entered && near && rule != Rule::Gap {
                block = Block::Committed;
            }
        }
        if rule == Rule::Priority {
            let range = cr.entries_of(x as u32);
            if (!s.waiting[0].is_empty() && e as usize == range.start)
                || (!s.waiting[1].is_empty() && e as usize == range.end - 1)
            {
                block = Block::Committed;
            }
        }
        block
    }
}

/// Whether a pedestrian at `speed` may enter a span seen as `view`.
fn span_open(view: EntryView, rule: Rule, span: (f64, f64), speed: f64, gap_margin: f64) -> bool {
    if view.occupied {
        return false;
    }
    match rule {
        Rule::Priority | Rule::Signal => !view.cannot_stop,
        Rule::Gap => view.min_time >= (span.1 - span.0) / speed.max(0.1) + gap_margin,
    }
}

impl Simulation {
    /// Advances the push-button signals and overwrites their groups' aspects (after the fixed-time
    /// and actuated states of the step).
    pub(super) fn update_pedestrian_signals(&mut self) {
        let Some(p) = self.peds.as_deref_mut() else {
            return;
        };
        if p.controllers.is_empty() {
            return;
        }
        let t = self.time;
        let pc = &self.config.pedestrians;
        let all_red = self.config.signal_control.all_red;
        let Pedestrians {
            controllers,
            crossings,
            ..
        } = p;
        for c in controllers.iter_mut() {
            let request = c
                .crossings
                .iter()
                .any(|&x| crossings[x as usize].waiting.iter().any(|w| !w.is_empty()));
            let elapsed = t - c.since;
            let next = match c.stage {
                Stage::VehicleGreen if request && elapsed >= pc.min_vehicle_green => {
                    Some(Stage::VehicleAmber)
                }
                Stage::VehicleAmber if elapsed >= c.amber => Some(Stage::AllRed),
                Stage::AllRed if elapsed >= all_red => Some(Stage::Walk),
                Stage::Walk if elapsed >= pc.walk_time => Some(Stage::Clearance),
                Stage::Clearance if elapsed >= c.clearance => Some(Stage::VehicleGreen),
                _ => None,
            };
            if let Some(stage) = next {
                if stage == Stage::Walk {
                    c.phases += 1;
                }
                c.stage = stage;
                c.since = t;
            }
        }
        p.write_signal_states(&mut self.signal_state);
    }

    /// Remaining green (s) of a fixed-time group; infinite for actuated controllers.
    fn remaining_green(&self, group: u32) -> f64 {
        let plans = &self.net.signals;
        let g = &plans.groups[group as usize];
        let c = &plans.controllers[g.controller as usize];
        if self
            .config
            .signal_control
            .actuated
            .includes(&self.net.nodes[c.node as usize].id)
        {
            return f64::INFINITY;
        }
        let t = (self.time - c.offset).rem_euclid(c.cycle);
        g.green
            .iter()
            .find(|&&(s, e)| t >= s && t < e)
            .map_or(0.0, |&(_, e)| e - t)
    }

    /// Whether pedestrians may start crossing `x` on its signal (true for unsignalised crossings).
    fn walk_aspect(&self, p: &Pedestrians, x: usize) -> bool {
        let info = &self.net.crossings.list[x];
        let controller = p.crossings[x].controller;
        if info.signal_group == NONE && controller != NONE {
            return p.controllers[controller as usize].stage == Stage::Walk;
        }
        match info.mode {
            SignalMode::None => true,
            SignalMode::Request => p.controllers[p.crossings[x].controller as usize].stage == Stage::Walk,
            SignalMode::Parallel => {
                self.signal_state[info.signal_group as usize] == SignalState::Green
                    && self.remaining_green(info.signal_group)
                        >= 0.5 * info.width / self.config.pedestrians.walk_speed
            }
        }
    }

    /// Arrivals, crossing decisions and walking of the pedestrians, then the vehicles' crossing
    /// holds and the vehicle KPIs (after the junction phase).
    pub(super) fn pedestrian_phase(&mut self) {
        let Some(mut p) = self.peds.take() else {
            return;
        };
        self.pedestrian_arrivals(&mut p);
        let cr = &self.net.crossings;
        for x in 0..cr.len() {
            let s = &p.crossings[x];
            p.active[x] = !s.walking.is_empty()
                || s.waiting.iter().any(|w| !w.is_empty())
                || cr.list[x].rule() == Rule::Signal;
            if p.active[x] {
                for e in cr.entries_of(x as u32) {
                    p.views[e] = CLEAR;
                }
            }
        }
        p.upcoming.clear();
        for i in 0..self.vehicles.len() {
            self.scan_crossings(i, &mut p);
        }
        for x in 0..cr.len() {
            p.walk[x] = p.active[x] && self.walk_aspect(&p, x);
        }
        self.move_pedestrians(&mut p);
        self.apply_crossing_holds(&mut p);
        self.peds = Some(p);
    }

    fn pedestrian_arrivals(&mut self, p: &mut Pedestrians) {
        let now = self.time;
        let pc = &self.config.pedestrians;
        for x in 0..p.crossings.len() {
            while p.crossings[x].next_arrival <= now {
                let at = p.crossings[x].next_arrival;
                let s = &mut p.crossings[x];
                if s.rate > 0.0 && p.curve.as_ref().is_none_or(|c| c.factor(p.start_time + at) > 0.0) {
                    let side = usize::from(s.rng.next_f64() >= 0.5);
                    let speed = pc.walk_speed * (1.0 + pc.walk_speed_spread * (2.0 * s.rng.next_f64() - 1.0));
                    s.waiting[side].push(Waiting { arrival: at, speed });
                    s.arrived += 1;
                    let n = (s.waiting[0].len() + s.waiting[1].len()) as u32;
                    s.max_waiting = s.max_waiting.max(n);
                }
                p.schedule(x, at);
            }
        }
    }

    /// Records what vehicle `i` means for the crossings on its path (occupancy, arrival times,
    /// whether it can stop) and its upcoming crossings.
    fn scan_crossings(&self, i: usize, p: &mut Pedestrians) {
        let net = &self.net;
        let cr = &net.crossings;
        let v = &self.vehicles[i];
        let len_v = v.params.length;
        let b = v.params.comfortable_deceleration;
        let lane_pos = |e: usize, lane: u32| {
            let entry = &cr.entries[e];
            entry.pos * net.seg_length[lane as usize] / net.links[entry.link as usize].length.max(1e-9)
        };
        let half = |e: usize| 0.5 * cr.list[cr.entries[e].crossing as usize].depth;
        // Rear still on a crossing at the end of the previous lane.
        if v.prev_seg != NONE && v.pos < len_v + 5.0 {
            let (lane, extra) = match net.segment_connector(v.seg) {
                Some(_) => (v.prev_seg, 0.0),
                None => match net.segment_connector(v.prev_seg) {
                    Some(c) => (
                        net.connectors[c as usize].from_lane,
                        net.seg_length[v.prev_seg as usize],
                    ),
                    None => (NONE, 0.0),
                },
            };
            if lane != NONE && net.is_lane(lane) {
                for &e in cr.on_link(net.lanes[lane as usize].link) {
                    let e = e as usize;
                    if p.active[cr.entries[e].crossing as usize] {
                        let end = lane_pos(e, lane) + half(e);
                        if v.pos + extra + net.seg_length[lane as usize] - end < len_v {
                            p.views[e].occupied = true;
                        }
                    }
                }
            }
        }
        let horizon = (v.speed * v.speed / (2.0 * b) + 30.0)
            .max(v.speed * 10.0)
            .min(150.0);
        let route = &self.routes[v.route as usize];
        let mask = v.params.class.mask();
        let mut base = -v.pos;
        let mut seg = v.seg;
        let mut rp = v.route_pos as usize;
        let mut first = true;
        for _ in 0..6 {
            if net.is_lane(seg) {
                for &e in cr.on_link(net.lanes[seg as usize].link) {
                    let e = e as usize;
                    if !p.active[cr.entries[e].crossing as usize] {
                        continue;
                    }
                    let centre = base + lane_pos(e, seg);
                    let (start, end) = (centre - half(e), centre + half(e));
                    if end + len_v <= 0.0 {
                        continue;
                    }
                    if start <= 0.0 {
                        p.views[e].occupied = true;
                        continue;
                    }
                    if start > horizon {
                        break;
                    }
                    let view = &mut p.views[e];
                    if v.speed >= 0.5 {
                        view.min_time = view.min_time.min(start / v.speed);
                        if v.speed * v.speed / (2.0 * start) > STEP_OUT_TOLERANCE * b {
                            view.cannot_stop = true;
                        }
                    }
                    p.upcoming.push((i as u32, e as u32, start));
                }
                base += net.seg_length[seg as usize];
                if base > horizon {
                    break;
                }
                let c = if first {
                    first = false;
                    v.next_conn
                } else {
                    super::choose_on_route(net, route, seg, rp + 1, mask)
                };
                if c == NONE {
                    break;
                }
                rp += 1;
                seg = net.connector_segment(c);
            } else {
                base += net.seg_length[seg as usize];
                seg = net.connectors[net.segment_connector(seg).unwrap_or(0) as usize].to_lane;
            }
        }
    }

    /// Pedestrians step out, walk and finish their crossing.
    fn move_pedestrians(&self, p: &mut Pedestrians) {
        let cr = &self.net.crossings;
        let (dt, end_time) = (self.dt, self.time + self.dt);
        let gap = self.config.pedestrians.gap_margin;
        for x in 0..cr.len() {
            if !p.active[x] {
                continue;
            }
            let info = &cr.list[x];
            let rule = info.rule();
            let range = cr.entries_of(x as u32);
            let views = &p.views;
            let s = &mut p.crossings[x];
            for side in 0..2 {
                if s.waiting[side].is_empty() || (rule == Rule::Signal && !p.walk[x]) {
                    continue;
                }
                let first = if side == 0 { range.start } else { range.end - 1 };
                let slowest = s.waiting[side]
                    .iter()
                    .map(|w| w.speed)
                    .fold(f64::INFINITY, f64::min);
                if !span_open(views[first], rule, cr.entries[first].span, slowest, gap) {
                    continue;
                }
                // The span after the first one, if any.
                let next = match (side, range.len()) {
                    (_, 0 | 1) => NONE,
                    (0, _) => (range.start + 1) as u32,
                    _ => (range.end - 2) as u32,
                };
                for w in std::mem::take(&mut s.waiting[side]) {
                    s.walking.push(Walker {
                        pos: if side == 0 { 0.0 } else { info.width },
                        dir: if side == 0 { 1.0 } else { -1.0 },
                        speed: w.speed,
                        arrival: w.arrival,
                        paused: false,
                        next,
                        slot: s.next_slot,
                    });
                    s.next_slot = (s.next_slot + 1) % 8;
                }
            }
            // The span after `e` in walking direction `dir`, if any.
            let after = |e: u32, dir: f64| -> u32 {
                let e = e as usize;
                if dir > 0.0 && e + 1 < range.end {
                    (e + 1) as u32
                } else if dir < 0.0 && e > range.start {
                    (e - 1) as u32
                } else {
                    NONE
                }
            };
            let mut k = 0;
            while k < s.walking.len() {
                let w = &mut s.walking[k];
                if w.paused {
                    let e = w.next as usize;
                    if !span_open(views[e], rule, cr.entries[e].span, w.speed, gap) {
                        k += 1;
                        continue;
                    }
                    w.paused = false;
                    w.next = after(w.next, w.dir);
                }
                let new = w.pos + w.dir * w.speed * dt;
                // Entering the next span: its boundary is reached in this step.
                if w.next != NONE {
                    let e = w.next as usize;
                    let span = cr.entries[e].span;
                    let (at, reached) = if w.dir > 0.0 {
                        (span.0, new >= span.0)
                    } else {
                        (span.1, new <= span.1)
                    };
                    if reached {
                        if !span_open(views[e], rule, span, w.speed, gap) {
                            w.pos = at;
                            w.paused = true;
                            k += 1;
                            continue;
                        }
                        w.next = after(w.next, w.dir);
                    }
                }
                w.pos = new.clamp(0.0, info.width);
                if (w.dir > 0.0 && w.pos >= info.width) || (w.dir < 0.0 && w.pos <= 0.0) {
                    let done = s.walking.remove(k);
                    s.served += 1;
                    s.delay += (end_time - done.arrival - info.width / done.speed).max(0.0);
                } else {
                    k += 1;
                }
            }
        }
    }

    /// Vehicles hold before blocked crossings (nearest first) and before signalised crosswalks when
    /// they hold at the stop line; vehicle stops and delay caused by pedestrians.
    fn apply_crossing_holds(&mut self, p: &mut Pedestrians) {
        let emergency = self.config.perception.emergency_factor;
        for v in &mut self.vehicles {
            v.ped_hold = f64::INFINITY;
            v.ped_cause = cause::NONE;
        }
        for &(i, e, d) in &p.upcoming {
            let v = &self.vehicles[i as usize];
            if v.ped_hold.is_finite() {
                continue;
            }
            let b = v.params.comfortable_deceleration;
            let target = (d - HOLD_MARGIN).max(0.0);
            let need = v.speed * v.speed / (2.0 * target.max(0.1));
            let rule =
                self.net.crossings.list[self.net.crossings.entries[e as usize].crossing as usize].rule();
            let hold = match p.blocked(&self.net, e) {
                Block::OnCrossing if need <= emergency * b => cause::PEDESTRIANS,
                Block::Committed if need <= YIELD_FACTOR * b => cause::PEDESTRIANS,
                _ if rule == Rule::Signal
                    && v.stop_dist.is_finite()
                    && v.stop_dist > d
                    && v.stop_dist - d < STOP_LINE_REACH
                    && need <= YIELD_FACTOR * b =>
                {
                    cause::STOP_LINE
                }
                _ => cause::NONE,
            };
            if hold != cause::NONE {
                let v = &mut self.vehicles[i as usize];
                v.ped_hold = target;
                v.ped_cause = hold;
            }
        }
        let dt = self.dt;
        for v in &mut self.vehicles {
            if v.ped_cause == cause::PEDESTRIANS {
                let limit = self.net.seg_speed_limit[v.seg as usize];
                p.vehicle_delay += dt * (1.0 - v.speed / limit).max(0.0);
                if v.speed < 0.5 && !v.ped_stopped {
                    v.ped_stopped = true;
                    p.vehicle_stops += 1;
                }
            } else {
                v.ped_stopped = false;
            }
        }
    }

    /// Places a waiting pedestrian at a kerb (`side` 0 = first kerb) of crossing `crossing_id`
    /// (scenario scripting and tests).
    pub fn add_pedestrian(&mut self, crossing_id: &str, side: u8, speed: f64) -> Result<(), String> {
        let x = self
            .net
            .crossings
            .index(crossing_id)
            .ok_or_else(|| format!("unknown crossing '{crossing_id}'"))?;
        let p = self.peds.as_deref_mut().ok_or("pedestrians are disabled")?;
        let s = &mut p.crossings[x as usize];
        s.waiting[usize::from(side.min(1))].push(Waiting {
            arrival: self.time,
            speed,
        });
        s.arrived += 1;
        Ok(())
    }

    /// Packed pedestrians, [`PEDESTRIAN_STRIDE`] floats each: crossing index (package order),
    /// progress from the first kerb (0) to the second (1), direction (+1 / -1), state (0 waiting,
    /// 1 walking, 2 waiting on the crossing), slot (small index for spreading a group).
    pub fn pedestrian_snapshot_into(&self, out: &mut Vec<f32>) {
        out.clear();
        let Some(p) = self.peds.as_deref() else {
            return;
        };
        for (x, s) in p.crossings.iter().enumerate() {
            let width = self.net.crossings.list[x].width;
            for (side, list) in s.waiting.iter().enumerate() {
                for k in 0..list.len() {
                    let dir = if side == 0 { 1.0 } else { -1.0 };
                    out.extend_from_slice(&[x as f32, side as f32, dir, 0.0, k as f32]);
                }
            }
            for w in &s.walking {
                let state = if w.paused { 2.0 } else { 1.0 };
                out.extend_from_slice(&[
                    x as f32,
                    (w.pos / width) as f32,
                    w.dir as f32,
                    state,
                    w.slot as f32,
                ]);
            }
        }
    }

    pub fn pedestrian_snapshot(&self) -> Vec<f32> {
        let mut out = Vec::new();
        self.pedestrian_snapshot_into(&mut out);
        out
    }

    /// Live pedestrian counts, `None` without pedestrians.
    pub(super) fn pedestrian_stats(&self) -> Option<PedestrianStats> {
        let p = self.peds.as_deref()?;
        let served: u64 = p.crossings.iter().map(|s| s.served).sum();
        let delay: f64 = p.crossings.iter().map(|s| s.delay).sum();
        Some(PedestrianStats {
            served,
            waiting: p
                .crossings
                .iter()
                .map(|s| (s.waiting[0].len() + s.waiting[1].len()) as u64)
                .sum(),
            crossing: p.crossings.iter().map(|s| s.walking.len() as u64).sum(),
            mean_delay: if served > 0 { delay / served as f64 } else { 0.0 },
        })
    }

    /// Pedestrian KPIs of the run summary, `None` without pedestrians.
    pub fn pedestrian_summary(&self) -> Option<PedestrianSummary> {
        let p = self.peds.as_deref()?;
        let stats = self.pedestrian_stats()?;
        let delay: f64 = p.crossings.iter().map(|s| s.delay).sum();
        Some(PedestrianSummary {
            arrived: p.crossings.iter().map(|s| s.arrived).sum(),
            served: stats.served,
            waiting: stats.waiting,
            crossing: stats.crossing,
            mean_delay: (stats.served > 0).then(|| delay / stats.served as f64),
            vehicle_stops: p.vehicle_stops,
            vehicle_delay_hours: p.vehicle_delay / 3600.0,
            signal_phases: p.controllers.iter().map(|c| c.phases).sum(),
            crossings: p
                .crossings
                .iter()
                .zip(&self.net.crossings.list)
                .map(|(s, info)| CrossingMetrics {
                    id: info.id.clone(),
                    kind: kind_name(info.kind).into(),
                    arrived: s.arrived,
                    served: s.served,
                    mean_delay: (s.served > 0).then(|| s.delay / s.served as f64),
                    max_waiting: s.max_waiting,
                })
                .collect(),
        })
    }
}

#[cfg(test)]
mod tests;
