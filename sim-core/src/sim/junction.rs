//! Junction control (#44, #45): fixed-time signals with the amber dilemma-zone rule, priority
//! rules, gap acceptance and deadlock avoidance.
//!
//! Model: a vehicle that is first in line for its next controlled connector decides every step
//! whether it may enter. A positive decision is turned into a *claim* once the vehicle reaches
//! its point of no return (comfortable braking distance + 3 m). A claim counts as occupancy of
//! the connector until the vehicle has left it; no vehicle claims a connector while a
//! conflicting connector is claimed or occupied, so conflicting movements never overlap.
//! Claims are applied sequentially in vehicle order, which also breaks ties deterministically.
//! A negative decision puts a virtual standing obstacle at the stop line.

use super::{EntryEvent, STOP_LINE_MARGIN, Simulation};
use crate::network::NONE;
use crate::package::{Priority, Turn};
use crate::signals::SignalState;

/// A vehicle releases a conflict once its rear is this far past the conflict point (m).
const CONFLICT_CLEARANCE: f64 = 1.0;

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
fn time_to_reach(d: f64, v: f64, a: f64) -> f64 {
    if d <= 0.0 {
        return 0.0;
    }
    let a = a.max(0.1);
    (-v + (v * v + 2.0 * a * d).sqrt()) / a
}

impl Simulation {
    pub(super) fn junction_phase(&mut self) {
        let max_wait = self.config.junction.max_wait;
        for i in 0..self.vehicles.len() {
            self.vehicles[i].stop_dist = f64::INFINITY;
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
            let decision = self.decide(i, c, d, forced);
            let v = &self.vehicles[i];
            // Yielding movements commit at their point of no return; prioritised movements
            // claim only when about to cross the stop line, so they do not block others early.
            let yielding = self.net.conflicts(c).iter().any(|&k| self.yields(c, k));
            let commit = if yielding {
                v.speed * v.speed / (2.0 * v.params.comfortable_deceleration) + 3.0
            } else {
                v.speed * self.dt + 2.0
            };
            match decision {
                Decision::EnterNow => self.claim(i, c, false),
                Decision::Enter if d <= commit => self.claim(i, c, forced),
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
        let net = &self.net;
        let info = &net.connectors[c as usize];
        let v = &self.vehicles[i];
        let b = v.params.comfortable_deceleration;
        let conflicts = net.conflicts(c);
        let blocked = conflicts.iter().any(|&k| self.blocks(k, c));
        match info.priority {
            Priority::Signal => match self.signal_state[info.signal_group as usize] {
                SignalState::Red => return Decision::Stop,
                // Dilemma zone: stop if a comfortable stop is possible, otherwise go - unless
                // the junction is physically blocked, then the hard stop line applies.
                SignalState::Amber => {
                    return if v.speed * v.speed / (2.0 * b) <= d || blocked {
                        Decision::Stop
                    } else {
                        Decision::EnterNow
                    };
                }
                SignalState::Green => {}
            },
            Priority::Stop if !v.stop_done => return Decision::Stop,
            _ => {}
        }
        if blocked || !self.exit_space_ok(c, i) {
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
            && self.time - self.conn_last_claim[c as usize] < j.follow_up_time
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
        // Time until the vehicle reaches its holding position just before the line (critical gaps
        // are measured from a vehicle waiting at the line).
        let hold = STOP_LINE_MARGIN + v.params.minimum_gap;
        let own = time_to_reach(d - hold, v.speed, v.params.max_acceleration);
        for &k in conflicts {
            if !self.yields(c, k) || !self.active(k) {
                continue;
            }
            let from_lane = net.connectors[k as usize].from_lane;
            let budget =
                ((critical_gap + own) * net.seg_speed_limit[from_lane as usize] * 1.3 + 20.0).min(400.0);
            let arrival = self.arrival_time(from_lane, k, 0.0, budget, i as u32, 0);
            if arrival - own < critical_gap {
                return Decision::Stop;
            }
        }
        Decision::Enter
    }

    /// Whether traffic on connector `k` currently blocks conflicting connector `c`: `k` is
    /// claimed, or a vehicle on `k` has not yet cleared the conflict point with `c`.
    pub(super) fn blocks(&self, k: u32, c: u32) -> bool {
        if self.conn_claims[k as usize] > 0 {
            return true;
        }
        let point = self.net.conflict_point(k, c).unwrap_or(f64::INFINITY);
        self.seg_vehicles[self.net.connector_segment(k) as usize]
            .last()
            .is_some_and(|&j| {
                let v = &self.vehicles[j as usize];
                v.pos - v.params.length < point + CONFLICT_CLEARANCE
            })
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
    /// served), which resolves mutual yielding (e.g. four right-before-left approaches).
    fn counts_for(&self, j: u32, me: u32) -> bool {
        if j == me {
            return false;
        }
        let (o, m) = (&self.vehicles[j as usize], &self.vehicles[me as usize]);
        let holding = o.stop_dist.is_finite() && o.speed < 0.5;
        !holding || o.wait > m.wait || (o.wait == m.wait && o.id < m.id)
    }

    /// Earliest arrival time (s) at the end of `lane` of a vehicle heading for connector `via`,
    /// searching upstream through incoming connectors up to `budget` metres.
    fn arrival_time(&self, lane: u32, via: u32, offset: f64, budget: f64, me: u32, depth: u32) -> f64 {
        let net = &self.net;
        let len = net.seg_length[lane as usize];
        let eta = |d: f64, speed: f64| d / speed.max(1.0);
        for &j in &self.seg_vehicles[lane as usize] {
            let v = &self.vehicles[j as usize];
            let d = offset + len - v.pos;
            if d > budget {
                return f64::INFINITY;
            }
            if v.next_conn == via && self.counts_for(j, me) {
                return eta(d, v.speed);
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
                (v.next_conn == via && self.counts_for(j, me)).then(|| eta(offset + clen - v.pos, v.speed))
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
    /// vehicles already on the connector, or traffic there is moving.
    fn exit_space_ok(&self, c: u32, i: usize) -> bool {
        let net = &self.net;
        let info = &net.connectors[c as usize];
        let mut needed = self.vehicles[i].params.length + 2.0;
        for &j in &self.seg_vehicles[net.connector_segment(c) as usize] {
            needed += self.vehicles[j as usize].params.length + 2.0;
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
