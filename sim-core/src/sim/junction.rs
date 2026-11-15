//! Junction control (#44, #45, #109): fixed-time signals with the amber dilemma-zone rule,
//! priority rules, gap acceptance on conflict zones and deadlock avoidance.
//!
//! Model: a vehicle that is first in line for its next controlled connector decides every step
//! whether it may enter. A positive decision is turned into a *claim* once the vehicle reaches
//! its point of no return (yielding movements: comfortable braking distance + 3 m + its length;
//! prioritised movements: just before the line). Claims are applied sequentially in vehicle
//! order, which also breaks ties deterministically. A negative decision puts a virtual standing
//! obstacle at the stop line.
//!
//! Conflict zones (#109): every conflicting connector pair has a zone on each connector (entry
//! and exit distance, see [`crate::network::Network::conflict_zone`]); a vehicle occupies it from
//! the moment its front passes the entry until its rear passes the exit. A decision compares
//! occupancy *times* (kinematic estimates: entries as early as possible, exits as late as
//! plausible):
//!
//! - **committed** vehicles of a conflicting connector (claimed, on it, or with the rear still on
//!   it) block a crossing unless the deciding vehicle enters its zone at least
//!   `junction.clearanceTime` after they have left theirs, or leaves its zone that long before
//!   they can reach theirs; on a merge the zone entries must be `clearanceTime` apart (the second
//!   vehicle then follows the first, see [`Simulation::merging_leader`]);
//! - **approaching** prioritised vehicles are subject to gap acceptance (HCM definition): the
//!   deciding vehicle goes if the next one reaches its conflict zone at least the critical gap
//!   after the deciding vehicle departs from the line. A vehicle still approaching (a queue
//!   follower rolling up, or one arriving at speed) adds how much later than a standing vehicle
//!   it reaches its own zone. A higher-ranked stream that is queued at its line offers no gap.
//! - a yielding merge leaves room on the exit lane for the prioritised vehicles about to merge
//!   and never fills the exit lane completely (no gridlock on a congested roundabout ring); off
//!   the ring an empty exit lane always admits, however short it is (#116).
//!
//! Physical safety net, computed sequentially here and applied by the IDM: a committed vehicle
//! stops before a crossing zone while its counterpart is occupied, before a merge zone until the
//! vehicle in the counterpart has moved far enough ahead to be followed, and - within
//! [`HOLD_HORIZON`] - lets a committed conflicting vehicle go first that reaches its zone earlier.
//! So two vehicles are never inside the two zones of a crossing at the same time, and vehicles
//! inside a merge never overlap towards the common end.

use super::{EntryEvent, STOP_LINE_MARGIN, Simulation};
use crate::network::NONE;
use crate::package::{Priority, Turn};
use crate::signals::SignalState;

/// Within this time (s) of its conflict zone, a committed vehicle lets a committed conflicting
/// vehicle go first that can reach its own zone earlier.
const HOLD_HORIZON: f64 = 2.0;
/// Lowest speed (m/s) assumed for vehicles in occupancy-time estimates.
const MIN_ESTIMATE_SPEED: f64 = 0.5;
/// A prioritised vehicle slower than this (m/s) within [`QUEUE_DISTANCE`] of its stop line is
/// queued: its stream offers no gap.
const QUEUE_SPEED: f64 = 2.0;
const QUEUE_DISTANCE: f64 = 15.0;
/// A yielding merge keeps exit-lane room for a prioritised vehicle this close (m) to its line.
const RESERVE_DISTANCE: f64 = 30.0;
/// Vehicles behind a connector end overlap it with their rear up to this distance (m, longer
/// than any vehicle).
const MAX_OVERHANG: f64 = 30.0;
/// Most connectors claimed together with the next one (#117: junction nodes a few metres apart,
/// e.g. dual carriageways or slip roads joining near a junction).
pub(super) const CHAIN: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Decision {
    /// Hold at the stop line.
    Stop,
    /// Allowed; claim when within the commit distance.
    Enter,
    /// Must go now (amber, cannot stop comfortably).
    EnterNow,
}

/// 0 for movements that yield to opposing traffic of the same rank (left turns, U-turns).
fn turn_rank(turn: Turn) -> u8 {
    match turn {
        Turn::Left | Turn::SharpLeft | Turn::Reverse => 0,
        _ => 1,
    }
}

fn priority_level(p: Priority) -> u8 {
    match p {
        Priority::Major | Priority::RoundaboutRing | Priority::Signal => 2,
        _ => 1,
    }
}

/// Time to cover `d` metres from speed `v` accelerating with `a` (pure arithmetic).
pub(super) fn time_to_reach(d: f64, v: f64, a: f64) -> f64 {
    if d <= 0.0 {
        return 0.0;
    }
    let a = a.max(0.1);
    (-v + (v * v + 2.0 * a * d).sqrt()) / a
}

/// Time to cover `d` metres from speed `v`, accelerating with `a` (0 = constant speed) up to
/// `vmax`; faster vehicles are assumed to slow down to `vmax` at once. Speeds below
/// [`MIN_ESTIMATE_SPEED`] count as that speed.
pub(super) fn travel_time(d: f64, v: f64, a: f64, vmax: f64) -> f64 {
    if d <= 0.0 {
        return 0.0;
    }
    let vmax = vmax.max(MIN_ESTIMATE_SPEED);
    if v >= vmax {
        return d / vmax;
    }
    if a <= 0.0 {
        return d / v.max(MIN_ESTIMATE_SPEED);
    }
    let t1 = (vmax - v) / a;
    let d1 = 0.5 * (v + vmax) * t1;
    if d <= d1 {
        time_to_reach(d, v, a)
    } else {
        t1 + (d - d1) / vmax
    }
}

/// Occupancy window of a conflict zone: (earliest entry, latest plausible exit) in seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Window {
    pub enter: f64,
    pub leave: f64,
}

impl Simulation {
    pub(super) fn junction_phase(&mut self) {
        let max_wait = self.config.junction.max_wait;
        for i in 0..self.vehicles.len() {
            self.vehicles[i].stop_dist = f64::INFINITY;
            if self.transit_dwelling(i) {
                self.vehicles[i].zone_hold = f64::INFINITY;
                continue;
            }
            self.vehicles[i].zone_hold = self.zone_hold(i);
            let Some((c, d)) = self.upcoming_decision(i) else {
                continue;
            };
            let info = &self.net.connectors[c as usize];
            let signalised = info.priority == Priority::Signal;
            let v = &self.vehicles[i];
            if info.priority == Priority::Stop && !v.stop_done && v.speed < 0.3 && d < 4.0 {
                self.vehicles[i].stop_done = true;
            }
            let forced = !signalised && self.vehicles[i].wait > max_wait;
            let mut decision = self.decide(i, c, d, forced);
            // Chained junctions (#117): enter only if the vehicle may also pass the junctions
            // right behind, whose stop lines it could not wait at clear of this one. A vehicle that
            // waited twice `maxWait` no longer waits for a red signal in the chain and stops at it on
            // the short lane instead, so signals that are never green together cannot hold it
            // forever (#126); gaps and space in the chain are still waited for.
            let mut chain = [NONE; CHAIN];
            if decision != Decision::Stop {
                let impatient = self.vehicles[i].wait > 2.0 * max_wait;
                let (next, n) = self.chain_after(i, c, d);
                for (k, &(c2, d2)) in next[..n].iter().enumerate() {
                    if self.decide_with(i, c2, d2, forced, true) == Decision::Stop {
                        let info2 = &self.net.connectors[c2 as usize];
                        let red = info2.priority == Priority::Signal
                            && self.signal_state[info2.signal_group as usize] != SignalState::Green;
                        if impatient && red {
                            // Stops at that signal: nothing behind it is claimed now.
                            break;
                        }
                        decision = Decision::Stop;
                        break;
                    }
                    chain[k] = c2;
                }
            }
            let v = &self.vehicles[i];
            // Yielding movements commit at their point of no return; prioritised movements
            // claim only when about to cross the stop line, so they do not block others early.
            let yielding = self.net.conflicts(c).iter().any(|&k| self.yields(c, k));
            let commit = if yielding {
                v.speed * v.speed / (2.0 * v.params.comfortable_deceleration) + 3.0 + v.params.length
            } else {
                v.speed * self.dt + 2.0
            };
            match decision {
                Decision::EnterNow => {
                    self.claim(i, c, false);
                    self.claim_ahead(i, chain);
                }
                Decision::Enter if d <= commit => {
                    self.claim(i, c, forced);
                    self.claim_ahead(i, chain);
                }
                Decision::Enter => {}
                Decision::Stop => {
                    let v = &mut self.vehicles[i];
                    v.stop_dist = d;
                    if v.speed < 0.5 {
                        v.wait += self.dt;
                    }
                }
            }
        }
    }

    /// The controlled connector a vehicle has to decide about and its distance, if the vehicle
    /// is first in line for it and within the decision horizon.
    fn upcoming_decision(&self, i: usize) -> Option<(u32, f64)> {
        let v = &self.vehicles[i];
        let c = v.next_conn;
        if c == NONE || v.claimed == c || v.rank != 0 || !self.net.connectors[c as usize].needs_decision {
            return None;
        }
        let net = &self.net;
        let d = match net.segment_connector(v.seg) {
            None => net.seg_length[v.seg as usize] - v.pos,
            Some(cur) => {
                let lane = net.connectors[cur as usize].to_lane;
                if self.last_on(lane).is_some() {
                    return None;
                }
                net.seg_length[v.seg as usize] - v.pos + net.seg_length[lane as usize]
            }
        };
        let horizon = v.speed * v.speed / (2.0 * v.params.comfortable_deceleration) + 2.0 * v.speed + 15.0;
        (d <= horizon).then_some((c, d))
    }

    /// Controlled connectors right behind `c` (with their distances from vehicle `i`, `d` metres
    /// before `c`) that the vehicle has to pass without stopping: the lanes in between are too
    /// short to hold it clear of the junctions (#117).
    fn chain_after(&self, i: usize, c: u32, d: f64) -> ([(u32, f64); CHAIN], usize) {
        let net = &self.net;
        let v = &self.vehicles[i];
        let route = &self.routes[v.route as usize];
        let room = v.params.length + v.params.minimum_gap + STOP_LINE_MARGIN;
        let mut out = [(NONE, 0.0); CHAIN];
        let (mut n, mut cur, mut dist) = (0, c, d);
        // `c` leads onto the route link after the current one (on a connector, `route_pos`
        // already points at the link being entered).
        let mut idx = v.route_pos as usize + 1;
        for _ in 0..2 * CHAIN {
            let lane = net.connectors[cur as usize].to_lane;
            if n == CHAIN || net.seg_length[lane as usize] >= room {
                break;
            }
            let Some(&link) = route.get(idx + 1) else {
                break;
            };
            let next = net.choose_connector(lane, link, v.params.class.mask());
            if next == NONE {
                break;
            }
            dist += net.seg_length[net.connector_segment(cur) as usize] + net.seg_length[lane as usize];
            if net.connectors[next as usize].needs_decision {
                out[n] = (next, dist);
                n += 1;
            }
            (cur, idx) = (next, idx + 1);
        }
        (out, n)
    }

    /// Claims the chained connectors behind the one just claimed (#117).
    fn claim_ahead(&mut self, i: usize, chain: [u32; CHAIN]) {
        for &c in chain.iter().filter(|&&c| c != NONE) {
            self.conn_claims[c as usize] += 1;
            self.conn_last_claim[c as usize] = self.time;
            if self.log_events {
                let group = self.net.connectors[c as usize].signal_group;
                self.entry_log.push(EntryEvent {
                    vehicle: self.vehicles[i].id,
                    connector: c,
                    time: self.time,
                    signal: (group != NONE).then(|| self.signal_state[group as usize]),
                    forced: false,
                });
            }
        }
        self.vehicles[i].ahead = chain;
    }

    fn claim(&mut self, i: usize, c: u32, forced: bool) {
        self.conn_claims[c as usize] += 1;
        self.conn_last_claim[c as usize] = self.time;
        let v = &mut self.vehicles[i];
        v.claimed = c;
        v.wait = 0.0;
        if forced {
            self.counters.forced_entries += 1;
        }
        if self.log_events {
            let group = self.net.connectors[c as usize].signal_group;
            self.entry_log.push(EntryEvent {
                vehicle: v.id,
                connector: c,
                time: self.time,
                signal: (group != NONE).then(|| self.signal_state[group as usize]),
                forced,
            });
        }
    }

    pub(super) fn decide(&self, i: usize, c: u32, d: f64, forced: bool) -> Decision {
        self.decide_with(i, c, d, forced, false)
    }

    /// [`Self::decide`]; `chained` decides about a connector right behind the next one (#117),
    /// whose stop sign is served by the stop at the first line.
    fn decide_with(&self, i: usize, c: u32, d: f64, forced: bool, chained: bool) -> Decision {
        let net = &self.net;
        let info = &net.connectors[c as usize];
        let v = &self.vehicles[i];
        let b = v.params.comfortable_deceleration;
        let conflicts = net.conflicts(c);
        let blocked = || conflicts.iter().any(|&k| !self.zone_clear(i, c, d, k));
        match info.priority {
            Priority::Signal => match self.signal_state[info.signal_group as usize] {
                SignalState::Red => return Decision::Stop,
                // Dilemma zone: stop if a comfortable stop is possible, otherwise go - unless
                // the junction is physically blocked, then the hard stop line applies.
                SignalState::Amber => {
                    return if v.speed * v.speed / (2.0 * b) <= d || blocked() {
                        Decision::Stop
                    } else {
                        Decision::EnterNow
                    };
                }
                SignalState::Green => {}
            },
            Priority::Stop if !v.stop_done && !chained => return Decision::Stop,
            _ => {}
        }
        if blocked() || !self.exit_space_ok(c, i) {
            return Decision::Stop;
        }
        if forced {
            return Decision::Enter;
        }
        if !conflicts.iter().any(|&k| self.yields(c, k)) {
            return Decision::Enter;
        }
        let j = &self.config.junction;
        if info.priority != Priority::Signal
            && self.time - self.conn_last_claim[c as usize] < j.follow_up_time - 1e-6
        {
            return Decision::Stop;
        }
        let critical_gap = match info.priority {
            Priority::Stop => j.critical_gap_stop,
            Priority::RoundaboutEntry => j.critical_gap_roundabout,
            Priority::RightBeforeLeft => j.critical_gap_right_before_left,
            Priority::Signal => j.critical_gap_permissive,
            _ => j.critical_gap_minor,
        } * v.params.gap_acceptance_factor;
        // Critical gaps are measured from a vehicle departing from its holding position just
        // before the line: `own` is how much later than such a departure this vehicle reaches the
        // conflict zone (#109; zero for a vehicle waiting at the line, small for a queue follower
        // rolling up, larger for one approaching from far away).
        let hold = STOP_LINE_MARGIN + v.params.minimum_gap;
        let p = &v.params;
        let vmax = p.desired_speed(net.seg_speed_limit[net.connector_segment(c) as usize]);
        for (&k, zone) in conflicts.iter().zip(net.conflict_zones(c)) {
            if !self.yields(c, k) || !self.active(k) {
                continue;
            }
            let own = (travel_time(d + zone.0, v.speed, p.max_acceleration, vmax.max(v.speed))
                - travel_time(hold + zone.0, 0.0, p.max_acceleration, vmax))
            .max(0.0);
            let from_lane = net.connectors[k as usize].from_lane;
            // Arrival at the conflict zone on `k` (#109), not at its stop line.
            let entry = net.conflict_zone(k, c).map_or(0.0, |z| z.0);
            let budget = ((critical_gap + own) * net.seg_speed_limit[from_lane as usize] * 1.3 + 20.0)
                .min(400.0)
                + entry;
            // Vehicles of a higher-ranked stream always count, even while queued at their line.
            let strict = priority_level(net.connectors[k as usize].priority) > priority_level(info.priority);
            let arrival = self.arrival_time(from_lane, k, entry, budget, (i as u32, strict), 0);
            if arrival - own < critical_gap {
                return Decision::Stop;
            }
        }
        Decision::Enter
    }

    /// Calls `f(vehicle, front position along k)` for every vehicle physically on connector `k`:
    /// on it, or (with `overhang`) already on its exit lane with the rear still on `k`. Merging
    /// connectors pass `overhang = false`: once a vehicle has left the merge, followers from both
    /// connectors see it as their leader on the common lane.
    pub(super) fn on_connector(&self, k: u32, overhang: bool, mut f: impl FnMut(u32, f64)) {
        let net = &self.net;
        let seg = net.connector_segment(k);
        for &j in &self.seg_vehicles[seg as usize] {
            f(j, self.vehicles[j as usize].pos);
        }
        if !overhang {
            return;
        }
        let clen = net.seg_length[seg as usize];
        for &j in self.seg_vehicles[net.connectors[k as usize].to_lane as usize]
            .iter()
            .rev()
        {
            let v = &self.vehicles[j as usize];
            if v.pos > MAX_OVERHANG {
                break;
            }
            if v.prev_seg == seg && v.pos < v.params.length {
                f(j, clen + v.pos);
            }
        }
    }

    /// Calls `f(vehicle, front position along k)` for every vehicle committed to connector `k`:
    /// physically on it ([`Self::on_connector`]) or claimed and approaching (negative position:
    /// distance to its start).
    fn committed(&self, k: u32, overhang: bool, mut f: impl FnMut(u32, f64)) {
        self.on_connector(k, overhang, &mut f);
        let claims = self.conn_claims[k as usize];
        if claims == 0 {
            return;
        }
        let net = &self.net;
        let lane = net.connectors[k as usize].from_lane;
        let len = net.seg_length[lane as usize];
        let mut found = 0;
        for &j in &self.seg_vehicles[lane as usize] {
            let v = &self.vehicles[j as usize];
            if v.claimed == k {
                f(j, v.pos - len);
                found += 1;
                if found == claims {
                    return;
                }
            }
        }
        // Claimed from the connector before an empty lane.
        for &ic in net.lane_incoming(lane) {
            let seg = net.connector_segment(ic);
            let clen = net.seg_length[seg as usize];
            for &j in &self.seg_vehicles[seg as usize] {
                let v = &self.vehicles[j as usize];
                if v.claimed == k {
                    f(j, v.pos - clen - len);
                }
            }
        }
    }

    /// Cheap pre-check of [`Self::committed`]: false if certainly no vehicle is committed to `k`.
    fn may_be_committed(&self, k: u32) -> bool {
        let net = &self.net;
        self.conn_claims[k as usize] > 0
            || !self.seg_vehicles[net.connector_segment(k) as usize].is_empty()
            || self.seg_vehicles[net.connectors[k as usize].to_lane as usize]
                .last()
                .is_some_and(|&j| self.vehicles[j as usize].pos <= MAX_OVERHANG)
    }

    /// Occupancy window of vehicle `j` (front at `front` along connector `k`) for `zone` on `k`.
    /// The exit assumes acceleration if the vehicle `goes` (it is deciding to enter, or has just
    /// been released by its claim) or is accelerating; a vehicle held on the connector may stay.
    fn window(&self, j: u32, k: u32, front: f64, zone: (f64, f64), goes: bool) -> Window {
        let v = &self.vehicles[j as usize];
        let p = &v.params;
        let vmax = p.desired_speed(self.net.seg_speed_limit[self.net.connector_segment(k) as usize]);
        let enter = travel_time(zone.0 - front, v.speed, p.max_acceleration, vmax.max(v.speed));
        let free = goes || v.claimed == k || (v.acc > 0.0 && v.zone_hold.is_infinite());
        let a = if free { p.max_acceleration } else { 0.0 };
        let leave = travel_time(zone.1 + p.length - front, v.speed, a, vmax);
        Window { enter, leave }
    }

    /// Whether vehicle `i`, `d` metres before connector `c`, can pass its conflict zone with `k`
    /// without conflicting with a vehicle committed to `k`: for crossings the occupancy windows
    /// must be apart by `junction.clearanceTime`; for merges the zone entries must be (the second
    /// vehicle then follows the first as its leader, see [`Self::follow_merging`]).
    pub(super) fn zone_clear(&self, i: usize, c: u32, d: f64, k: u32) -> bool {
        let net = &self.net;
        if !self.may_be_committed(k) {
            return true;
        }
        let (Some(mine), Some(theirs)) = (net.conflict_zone(c, k), net.conflict_zone(k, c)) else {
            return true;
        };
        let clearance = self.config.junction.clearance_time;
        let merge = net.merges(c, k);
        let mut own: Option<Window> = None;
        let mut clear = true;
        self.committed(k, !merge, |j, front| {
            if !clear || j == i as u32 || front - self.vehicles[j as usize].params.length >= theirs.1 {
                return;
            }
            let own = *own.get_or_insert_with(|| self.window(i as u32, c, -d, mine, true));
            let w = self.window(j, k, front, theirs, false);
            clear = if merge {
                (own.enter - w.enter).abs() >= clearance
            } else {
                own.enter >= w.leave + clearance || own.leave + clearance <= w.enter
            };
        });
        clear
    }

    /// Nearest vehicle ahead of a vehicle with `remaining` metres to the end of connector `c`
    /// among the vehicles inside the merge zones of connectors merging with `c` (#109), measured
    /// towards the common end: (index, net gap). Vehicles on different connectors of a merge do
    /// not see each other as leaders on their own segments.
    pub(super) fn merging_leader(&self, c: u32, remaining: f64, me: u32) -> Option<(u32, f64)> {
        let net = &self.net;
        let mut best: Option<(u32, f64)> = None;
        for &k in net.merging(c) {
            let seg = net.connector_segment(k);
            if self.seg_vehicles[seg as usize].is_empty() {
                continue;
            }
            let klen = net.seg_length[seg as usize];
            let entry = net.conflict_zone(k, c).map_or(0.0, |z| z.0);
            for &j in self.seg_vehicles[seg as usize].iter().rev() {
                let q = &self.vehicles[j as usize];
                let rem = klen - q.pos;
                if j == me
                    || q.pos < entry
                    || rem > remaining
                    || (rem == remaining && q.id > self.vehicles[me as usize].id)
                {
                    continue;
                }
                let gap = remaining - rem - q.params.length;
                if best.is_none_or(|(_, g)| gap < g) {
                    best = Some((j, gap));
                }
                // Upstream first: the first one ahead of us is the nearest.
                break;
            }
        }
        best
    }

    /// Distance from vehicle `i`'s front to the entry of the nearest conflict zone ahead on its
    /// connector (the one it is on or has claimed) that it must not enter yet; `INFINITY` if none
    /// (safety net, #109). A crossing zone is blocked while a conflicting vehicle is inside its
    /// counterpart; a merge zone while a vehicle in the counterpart has not moved far enough
    /// ahead (towards the common end) to be followed. Within [`HOLD_HORIZON`] of its zone, a
    /// vehicle also lets a committed conflicting vehicle go first that can reach its own zone
    /// earlier (ties by index), so two vehicles never enter conflicting zones at the same time.
    pub(super) fn zone_hold(&self, i: usize) -> f64 {
        let net = &self.net;
        let v = &self.vehicles[i];
        let (c, front) = match net.segment_connector(v.seg) {
            Some(c) => (c, v.pos),
            None if v.claimed != NONE => (v.claimed, v.pos - net.seg_length[v.seg as usize]),
            None => return f64::INFINITY,
        };
        let horizon = v.speed * v.speed / v.params.comfortable_deceleration + 10.0;
        let clen = net.seg_length[net.connector_segment(c) as usize];
        let early = |j: u32, d: f64, seg: u32| {
            let q = &self.vehicles[j as usize];
            let vmax = q
                .params
                .desired_speed(net.seg_speed_limit[seg as usize])
                .max(q.speed);
            travel_time(d, q.speed, q.params.max_acceleration, vmax)
        };
        let mut hold = f64::INFINITY;
        for (&k, &zone) in net.conflicts(c).iter().zip(net.conflict_zones(c)) {
            let dist = zone.0 - front;
            if dist <= 0.0 || dist > horizon || dist >= hold || !self.may_be_committed(k) {
                continue;
            }
            let Some(theirs) = net.conflict_zone(k, c) else {
                continue;
            };
            let merge = net.merges(c, k);
            let klen = net.seg_length[net.connector_segment(k) as usize];
            // Merges: the counterpart must have moved ahead of our zone entry (by s0).
            let entry_rem = clen - zone.0 - v.params.minimum_gap;
            let mine = early(i as u32, dist, net.connector_segment(c));
            let mut blocked = false;
            self.committed(k, !merge, |j, f| {
                let q = &self.vehicles[j as usize];
                if blocked || j == i as u32 || f - q.params.length >= theirs.1 {
                    return;
                }
                if f >= theirs.0 {
                    blocked = !merge || klen - f + q.params.length > entry_rem;
                } else if mine <= HOLD_HORIZON {
                    let t = early(j, theirs.0 - f, net.connector_segment(k));
                    blocked = t < mine || (t == mine && (j as usize) < i);
                }
            });
            if blocked {
                hold = dist;
            }
        }
        hold
    }

    #[cfg(test)]
    /// A vehicle (other than `except`) physically inside the conflict zone of connector `k` with
    /// connector `c`.
    pub(super) fn zone_occupant(&self, k: u32, c: u32, except: u32) -> Option<u32> {
        let zone = self.net.conflict_zone(k, c)?;
        let mut inside = None;
        self.on_connector(k, !self.net.merges(c, k), |j, front| {
            let rear = front - self.vehicles[j as usize].params.length;
            if inside.is_none() && j != except && front >= zone.0 && rear < zone.1 {
                inside = Some(j);
            }
        });
        inside
    }

    /// Whether movement `c` has to give way to conflicting movement `k`.
    pub(super) fn yields(&self, c: u32, k: u32) -> bool {
        let (a, b) = (&self.net.connectors[c as usize], &self.net.connectors[k as usize]);
        if a.priority == Priority::Signal || b.priority == Priority::Signal {
            if a.priority != b.priority {
                // Mixed control: the signalised movement has priority.
                return b.priority == Priority::Signal;
            }
            // Permissive movements (left turns) yield to the conflicting movements of rank 1.
            return turn_rank(a.turn) < turn_rank(b.turn);
        }
        let (la, lb) = (priority_level(a.priority), priority_level(b.priority));
        if la != lb {
            return la < lb;
        }
        let cross = a.approach[0] * b.approach[1] - a.approach[1] * b.approach[0];
        let dot = a.approach[0] * b.approach[0] + a.approach[1] * b.approach[1];
        if la == 1 && cross > 0.3 {
            // Equal (low) rank: right before left.
            return true;
        }
        // Oncoming traffic: turning left yields to going straight or right.
        dot < -0.7 && turn_rank(a.turn) < turn_rank(b.turn)
    }

    /// Conflicting traffic on `k` counts only while it may move (signal green).
    fn active(&self, k: u32) -> bool {
        let info = &self.net.connectors[k as usize];
        info.priority != Priority::Signal
            || self.signal_state[info.signal_group as usize] == SignalState::Green
    }

    /// Whether vehicle `j` counts as approaching for vehicle `me`: a vehicle that is itself
    /// holding at a stop line defers to vehicles that have waited longer (first come, first
    /// served), which resolves mutual yielding (e.g. four right-before-left approaches) - unless
    /// it belongs to a higher-ranked stream (`strict`).
    fn counts_for(&self, j: u32, (me, strict): (u32, bool)) -> bool {
        if j == me {
            return false;
        }
        let (o, m) = (&self.vehicles[j as usize], &self.vehicles[me as usize]);
        strict || !o.holding() || o.wait > m.wait || (o.wait == m.wait && o.id < m.id)
    }

    /// Earliest arrival time (s) at the end of `lane` (plus `offset`) of a vehicle heading for
    /// connector `via`, searching upstream through incoming connectors up to `budget` metres
    /// (kinematic estimate: accelerating up to its desired speed). A counting vehicle queued near
    /// the stop line of `via` (holding, or slower than [`QUEUE_SPEED`] within [`QUEUE_DISTANCE`])
    /// arrives now: a queued stream offers no gaps.
    pub(super) fn arrival_time(
        &self,
        lane: u32,
        via: u32,
        offset: f64,
        budget: f64,
        me: (u32, bool),
        depth: u32,
    ) -> f64 {
        let net = &self.net;
        let len = net.seg_length[lane as usize];
        let eta = |d: f64, j: u32, seg: u32| {
            let v = &self.vehicles[j as usize];
            let vmax = v
                .params
                .desired_speed(net.seg_speed_limit[seg as usize])
                .max(v.speed);
            if me.1 {
                travel_time(d, v.speed, v.params.max_acceleration, vmax)
            } else {
                d / v.speed.max(1.0)
            }
        };
        for &j in &self.seg_vehicles[lane as usize] {
            let v = &self.vehicles[j as usize];
            let d = offset + len - v.pos;
            if d > budget {
                return f64::INFINITY;
            }
            if v.next_conn == via && self.counts_for(j, me) {
                let queued = v.holding() || (me.1 && v.speed < QUEUE_SPEED && len - v.pos < QUEUE_DISTANCE);
                return if depth == 0 && queued {
                    0.0
                } else {
                    eta(d, j, lane)
                };
            }
        }
        let offset = offset + len;
        if offset > budget || depth >= 4 {
            return f64::INFINITY;
        }
        let mut best = f64::INFINITY;
        for &ic in net.lane_incoming(lane) {
            let seg = net.connector_segment(ic);
            let clen = net.seg_length[seg as usize];
            let found = self.seg_vehicles[seg as usize].iter().find_map(|&j| {
                let v = &self.vehicles[j as usize];
                (v.next_conn == via && self.counts_for(j, me)).then(|| eta(offset + clen - v.pos, j, seg))
            });
            let t = match found {
                Some(t) => t,
                None => {
                    let from = net.connectors[ic as usize].from_lane;
                    self.arrival_time(from, ic, offset + clen, budget, me, depth + 1)
                }
            };
            best = best.min(t);
        }
        best
    }

    /// Keep the junction clear: enter only if the exit lane has room for this vehicle and the
    /// vehicles already on the connector, or traffic there is moving. A yielding movement also
    /// leaves room for the prioritised vehicles merging into the same lane that are on their
    /// connector or about to reach it (#109; a roundabout entry does not take the space the
    /// circulating traffic needs, which would lock up a congested ring). Off the ring, an empty
    /// exit lane always has room, however short it is (#116: OSM splits roads at every node, so
    /// lanes of a few metres are common, and a merge into one would otherwise wait forever).
    /// Length and occupied space (vehicle length + 2 m each) of the exit lane of `c`. While that
    /// is shorter than `needed`, the lanes that follow on vehicle `i`'s route count too: two
    /// roundabout arms a metre apart leave a ring link no vehicle fits on (#120).
    fn exit_room(&self, c: u32, i: usize, needed: f64) -> (f64, f64) {
        let net = &self.net;
        let v = &self.vehicles[i];
        let route = &self.routes[v.route as usize];
        let occupied = |seg: u32| -> f64 {
            self.seg_vehicles[seg as usize]
                .iter()
                .map(|&j| self.vehicles[j as usize].params.length + 2.0)
                .sum()
        };
        let mut lane = net.connectors[c as usize].to_lane;
        let (mut len, mut occ) = (net.seg_length[lane as usize], occupied(lane));
        // `c` leads onto the route link after the current one (see `chain_after`).
        let first = v.route_pos as usize + 2;
        for idx in first..first + 4 {
            if len >= needed {
                break;
            }
            let Some(&link) = route.get(idx) else {
                break;
            };
            let next = net.choose_connector(lane, link, v.params.class.mask());
            if next == NONE {
                break;
            }
            let seg = net.connector_segment(next);
            lane = net.connectors[next as usize].to_lane;
            len += net.seg_length[seg as usize] + net.seg_length[lane as usize];
            occ += occupied(seg) + occupied(lane);
        }
        (len, occ)
    }

    pub(super) fn exit_space_ok(&self, c: u32, i: usize) -> bool {
        let net = &self.net;
        let info = &net.connectors[c as usize];
        let mut needed = self.vehicles[i].params.length + 2.0;
        for &j in &self.seg_vehicles[net.connector_segment(c) as usize] {
            needed += self.vehicles[j as usize].params.length + 2.0;
        }
        let (mut yielding_merge, mut ring) = (false, false);
        for &k in net.conflicts(c) {
            if !net.merges(c, k) || !self.yields(c, k) {
                continue;
            }
            yielding_merge = true;
            ring |= net.connectors[k as usize].priority == Priority::RoundaboutRing;
            for &j in &self.seg_vehicles[net.connector_segment(k) as usize] {
                needed += self.vehicles[j as usize].params.length + 2.0;
            }
            let lane = net.connectors[k as usize].from_lane;
            let len = net.seg_length[lane as usize];
            if let Some(&j) = self.seg_vehicles[lane as usize]
                .iter()
                .take_while(|&&j| len - self.vehicles[j as usize].pos < RESERVE_DISTANCE)
                .find(|&&j| self.vehicles[j as usize].next_conn == k)
            {
                needed += self.vehicles[j as usize].params.length + 2.0;
            }
        }
        // A yielding merge never fills its exit lane completely, so the prioritised stream can
        // always move on (no gridlock on a congested roundabout or in a dense grid).
        if yielding_merge {
            // Only ring links look further: elsewhere an empty short lane is enough (#116).
            let (len, occupied) = self.exit_room(c, i, if ring { needed } else { 0.0 });
            if (occupied > 0.0 || ring) && occupied + needed > len {
                return false;
            }
        }
        match self.last_on(info.to_lane) {
            None => true,
            Some((j, pos)) => {
                let last = &self.vehicles[j as usize];
                pos - last.params.length >= needed || last.speed > 3.0
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_to_reach_is_kinematic() {
        assert_eq!(time_to_reach(0.0, 5.0, 1.0), 0.0);
        assert!((time_to_reach(10.0, 10.0, 0.0) - (-10.0 + (100.0f64 + 2.0).sqrt()) / 0.1).abs() < 1e-9);
        // From standstill: d = a t² / 2.
        assert!((time_to_reach(8.0, 0.0, 1.0) - 4.0).abs() < 1e-12);
    }

    #[test]
    fn ranks_and_levels() {
        assert_eq!(turn_rank(Turn::Left), 0);
        assert_eq!(turn_rank(Turn::Through), 1);
        assert_eq!(turn_rank(Turn::Right), 1);
        assert_eq!(priority_level(Priority::RoundaboutRing), 2);
        assert_eq!(priority_level(Priority::RoundaboutEntry), 1);
        assert_eq!(priority_level(Priority::Stop), 1);
    }
}
