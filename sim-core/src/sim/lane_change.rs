//! Lane changes (#46, #97): discretionary MOBIL (Kesting, Treiber & Helbing 2007) with
//! politeness, safety criterion, threshold and keep-right bias, plus mandatory changes towards a
//! lane that has a connector to the next link of the route.
//!
//! Rules: a change is only proposed where the lane boundary allows it (`allowLeft` /
//! `allowRight`), never inside the link's `noLaneChangeZone`, never for a vehicle that has
//! claimed its junction entry. A vehicle that reaches the zone in a lane without a connector to
//! its next link re-routes from the lane it is in.
//!
//! Continuous lateral motion (#108): a change takes `laneChange.duration` seconds (shorter at low
//! speed, see [`crate::config::LaneChangeConfig::duration_at`]). The vehicle moves to the target
//! lane's occupant list at the start and stays listed as a *shadow* on the source lane until the
//! change ends, so followers on both lanes (and insertion, junction exit checks and later lane
//! changes) see it; it follows the leaders of both lanes and cannot start another change. If, in
//! the first half, the gap ahead on the target lane drops below 1 m or the new follower would
//! have to brake harder than twice its safe deceleration, the change is reversed (the lanes swap
//! roles and the lateral motion continues back); in the second half it is completed. A vehicle
//! that leaves its lane (enters a connector) completes the change at once.

use super::transit::Kerb;
use super::{LaneChangeEvent, Simulation};
use crate::idm::IdmParams;
use crate::network::{NONE, Network};

/// `3p² − 2p³`: smooth lateral position profile of a lane change (zero lateral speed at both ends).
pub(super) fn smoothstep(p: f64) -> f64 {
    p * p * (3.0 - 2.0 * p)
}

/// Lateral offset (m, positive = left) from the centre of lane `seg` of a vehicle changing from
/// the adjacent lane `from` at `progress` (0 = centre of `from`, 1 = centre of `seg`).
pub(super) fn change_offset(net: &Network, from: u32, seg: u32, progress: f64) -> f64 {
    let (a, b) = (&net.lanes[from as usize], &net.lanes[seg as usize]);
    let remaining = 0.5 * (a.width + b.width) * (1.0 - smoothstep(progress));
    if b.index > a.index { -remaining } else { remaining }
}

/// Lateral speed (m/s, positive = left) of a vehicle changing from `from` to `seg`.
pub(super) fn change_lateral_speed(net: &Network, from: u32, seg: u32, progress: f64, rate: f64) -> f64 {
    let (a, b) = (&net.lanes[from as usize], &net.lanes[seg as usize]);
    let speed = 0.5 * (a.width + b.width) * 6.0 * progress * (1.0 - progress) * rate;
    if b.index > a.index { speed } else { -speed }
}

/// Nearest occupant ahead and behind: (index, front position on the lane).
type Around = (Option<(u32, f64)>, Option<(u32, f64)>);

/// A vehicle still in a wrong lane re-routes at the latest this far before the lane end (m).
const REROUTE_BEFORE_END: f64 = 15.0;
/// MOBIL bias (m/s²) towards lanes that continue two links ahead on the route.
const STRATEGIC_BIAS: f64 = 1.0;

#[derive(Clone, Copy)]
struct Neighbour {
    pos: f64,
    length: f64,
    speed: f64,
    idm: IdmParams,
}

impl Neighbour {
    /// IDM acceleration with `gap` and `leader_speed` (infinite gap = free road).
    fn acc(&self, gap: f64, leader_speed: f64) -> f64 {
        if gap.is_infinite() {
            self.idm.acceleration(self.speed, gap, 0.0)
        } else {
            self.idm.acceleration(self.speed, gap, self.speed - leader_speed)
        }
    }
}

impl Simulation {
    pub(super) fn lane_change_phase(&mut self) {
        let interval = u64::from(self.config.lane_change.interval);
        for i in 0..self.vehicles.len() {
            let v = &self.vehicles[i];
            if !self.net.is_lane(v.seg) || v.claimed != NONE {
                continue;
            }
            // Buses keep to (or move to) the kerb lane before a stop and stay put while dwelling.
            let kerb = self.transit_kerb(i);
            if kerb == Kerb::Dwelling {
                continue;
            }
            let link = &self.net.links[self.net.lanes[v.seg as usize].link as usize];
            let len = self.net.seg_length[v.seg as usize];
            let zone_start = len - link.no_lane_change_zone;
            let wrong_lane = v.next_conn == NONE && self.has_next_link(v) && kerb == Kerb::Free;
            // On an ending lane (acceleration lane, lane drop) a merger waits at the end for a
            // gap instead of giving up, as long as a lane change is possible at all.
            let lane = &self.net.lanes[v.seg as usize];
            let waits = wrong_lane
                && self.net.lane_ends(v.seg)
                && self.mandatory_direction(i).is_some_and(|d| {
                    if d > 0 {
                        lane.can_change_left
                    } else {
                        lane.can_change_right
                    }
                });
            if wrong_lane && !waits && v.pos >= zone_start.min(len - REROUTE_BEFORE_END) {
                self.reroute(i);
                continue;
            }
            let v = &self.vehicles[i];
            if v.lc_from != NONE {
                self.check_abort(i);
                continue;
            }
            if v.lc_timer > 0.0 || v.pos >= zone_start || kerb == Kerb::Stay {
                continue;
            }
            let mandatory = if wrong_lane {
                match self.mandatory_direction(i) {
                    Some(d) => Some(d),
                    None => {
                        self.reroute(i);
                        continue;
                    }
                }
            } else if kerb == Kerb::MoveRight {
                Some(-1)
            } else {
                None
            };
            if mandatory.is_none() && !(u64::from(v.lc_phase) + self.steps).is_multiple_of(interval) {
                continue;
            }
            if let Some(target) = self.evaluate_lane_change(i, mandatory, zone_start) {
                self.apply_lane_change(i, target, mandatory.is_some());
            }
        }
    }

    /// Direction (−1 right, +1 left) to the nearest lane of the current link that connects to
    /// the next link of the route; `None` if no lane does.
    fn mandatory_direction(&self, i: usize) -> Option<i32> {
        let v = &self.vehicles[i];
        let lane = &self.net.lanes[v.seg as usize];
        let link = &self.net.links[lane.link as usize];
        let next = self.routes[v.route as usize][v.route_pos as usize + 1];
        let mask = v.params.class.mask();
        let idx = lane.index as i32;
        (0..link.lane_count)
            .filter(|&j| self.net.choose_connector(link.first_lane + j, next, mask) != NONE)
            .min_by_key(|&j| (j as i32 - idx).abs())
            .map(|j| (j as i32 - idx).signum())
    }

    /// Leader and follower on `lane` around position `s` (occupant lists are sorted downstream
    /// first; equal positions sort by id).
    pub(super) fn neighbours(&self, lane: u32, s: f64, id: u32) -> (Option<u32>, Option<u32>) {
        let list = &self.seg_vehicles[lane as usize];
        let k = list.partition_point(|&j| {
            let v = &self.vehicles[j as usize];
            v.pos > s || (v.pos == s && v.id < id)
        });
        let leader = k.checked_sub(1).map(|k| list[k]);
        (leader, list.get(k).copied())
    }

    /// Front position of vehicle `j` on `lane`: its own position, or its position projected
    /// from its current lane onto the lane it is changing away from.
    pub(super) fn pos_on(&self, j: u32, lane: u32) -> f64 {
        let v = &self.vehicles[j as usize];
        if v.seg == lane {
            v.pos
        } else {
            v.pos * self.net.seg_length[lane as usize] / self.net.seg_length[v.seg as usize]
        }
    }

    /// Nearest shadows (vehicles changing away from `lane`, #108) ahead of and behind position
    /// `s`, vehicle `id` itself excluded: (index, front position on `lane`).
    pub(super) fn shadows_around(&self, lane: u32, s: f64, id: u32) -> Around {
        let list = &self.seg_shadows[lane as usize];
        if list.is_empty() {
            return (None, None);
        }
        let k = list.partition_point(|&j| {
            let p = self.pos_on(j, lane);
            p > s || (p == s && self.vehicles[j as usize].id < id)
        });
        let lead = k.checked_sub(1).map(|k| (list[k], self.pos_on(list[k], lane)));
        let f = k + usize::from(list.get(k).is_some_and(|&j| self.vehicles[j as usize].id == id));
        (lead, list.get(f).map(|&j| (j, self.pos_on(j, lane))))
    }

    /// Nearest occupants of `lane` ahead of and behind position `s`, shadows included and
    /// vehicle `id` itself excluded: (index, front position on `lane`).
    pub(super) fn occupants_around(&self, lane: u32, s: f64, id: u32) -> Around {
        let list = &self.seg_vehicles[lane as usize];
        let k = list.partition_point(|&j| {
            let v = &self.vehicles[j as usize];
            v.pos > s || (v.pos == s && v.id < id)
        });
        let at = |k: usize| list.get(k).map(|&j| (j, self.vehicles[j as usize].pos));
        let lead = k.checked_sub(1).and_then(at);
        let follow = at(k + usize::from(list.get(k).is_some_and(|&j| self.vehicles[j as usize].id == id)));
        if !self.net.is_lane(lane) {
            return (lead, follow);
        }
        self.with_shadows((lead, follow), self.shadows_around(lane, s, id))
    }

    /// Nearest occupants ahead of and behind vehicle `i` on its own lane, shadows included.
    pub(super) fn own_lane_around(&self, i: usize) -> Around {
        let v = &self.vehicles[i];
        let list = &self.seg_vehicles[v.seg as usize];
        let at = |k: usize| list.get(k).map(|&j| (j, self.vehicles[j as usize].pos));
        let regular = (
            (v.rank as usize).checked_sub(1).and_then(at),
            at(v.rank as usize + 1),
        );
        self.with_shadows(regular, self.shadows_around(v.seg, v.pos, v.id))
    }

    /// The nearer of a regular occupant and a shadow, ahead (by rear) and behind (by front).
    fn with_shadows(&self, regular: Around, shadows: Around) -> Around {
        let rear = |o: &(u32, f64)| o.1 - self.vehicles[o.0 as usize].params.length;
        let lead = match (regular.0, shadows.0) {
            (Some(a), Some(b)) => Some(if rear(&b) < rear(&a) { b } else { a }),
            (a, b) => a.or(b),
        };
        let follow = match (regular.1, shadows.1) {
            (Some(a), Some(b)) => Some(if b.1 > a.1 { b } else { a }),
            (a, b) => a.or(b),
        };
        (lead, follow)
    }

    /// Most upstream occupant of segment `seg` (shadows included on lanes): (index, front
    /// position on `seg`).
    pub(super) fn last_on(&self, seg: u32) -> Option<(u32, f64)> {
        let last = self.seg_vehicles[seg as usize]
            .last()
            .map(|&j| (j, self.vehicles[j as usize].pos));
        if !self.net.is_lane(seg) {
            return last;
        }
        let shadow = self.seg_shadows[seg as usize]
            .last()
            .map(|&j| (j, self.pos_on(j, seg)));
        let rear = |o: &(u32, f64)| o.1 - self.vehicles[o.0 as usize].params.length;
        match (last, shadow) {
            (Some(a), Some(b)) => Some(if rear(&b) < rear(&a) { b } else { a }),
            (a, b) => a.or(b),
        }
    }

    /// Lateral offset (m, positive = left) from the centre of lane `seg` of a vehicle changing
    /// from lane `from` at `progress`.
    pub(super) fn change_offset(&self, from: u32, seg: u32, progress: f64) -> f64 {
        change_offset(&self.net, from, seg, progress)
    }

    /// Reverses a lane change in its first half when the target lane became unsafe (#108).
    fn check_abort(&mut self, i: usize) {
        let v = &self.vehicles[i];
        if v.lc_progress >= 0.5 {
            return;
        }
        let net = &self.net;
        let (lane, from, id) = (v.seg, v.lc_from, v.id);
        let limit = net.seg_speed_limit[lane as usize];
        let (lead, follow) = self.own_lane_around(i);
        let gap_front = lead.map_or(f64::INFINITY, |(j, p)| {
            p - self.vehicles[j as usize].params.length - v.pos
        });
        let unsafe_behind = follow.is_some_and(|(j, p)| {
            let gap = v.pos - v.params.length - p;
            let f = Neighbour {
                pos: p,
                ..self.neighbour(j, limit)
            };
            gap < 1.0 || f.acc(gap, v.speed) < -2.0 * v.params.safe_deceleration
        });
        if gap_front >= 1.0 && !unsafe_behind {
            return;
        }
        // Back only if the source lane is still clear around the vehicle (it is still there).
        let s = self.pos_on(i as u32, from);
        let (lead, follow) = self.occupants_around(from, s, id);
        let clear_ahead = lead.is_none_or(|(j, p)| p - self.vehicles[j as usize].params.length > s);
        let clear_behind = follow.is_none_or(|(_, p)| s - v.params.length > p);
        if clear_ahead && clear_behind {
            self.reverse_lane_change(i);
        }
    }

    /// Swaps the roles of the source and the target lane of a lane change in progress.
    fn reverse_lane_change(&mut self, i: usize) {
        let v = &self.vehicles[i];
        let (cur, from) = (v.seg, v.lc_from);
        let s = self.pos_on(i as u32, from);
        self.seg_shadows[from as usize].retain(|&j| j != i as u32);
        self.move_occupant(i, from, s);
        self.insert_shadow(i, cur);
        let mut v = self.vehicles[i].clone();
        v.lc_from = cur;
        v.lc_progress = 1.0 - v.lc_progress;
        v.lat_offset = self.change_offset(cur, from, v.lc_progress);
        v.lc_timer = self.config.lane_change.cooldown;
        v.next_conn = self.connector_on_route(&v, from);
        self.vehicles[i] = v;
        self.counters.lane_change_aborts += 1;
    }

    /// Moves vehicle `i` from the occupant list of its lane to the one of `target` at `s`.
    fn move_occupant(&mut self, i: usize, target: u32, s: f64) {
        let v = &self.vehicles[i];
        let (old, rank, id) = (v.seg, v.rank as usize, v.id);
        let list = &mut self.seg_vehicles[old as usize];
        list.remove(rank);
        for (r, &j) in list.iter().enumerate().skip(rank) {
            self.vehicles[j as usize].rank = r as u32;
        }
        let k = match self.neighbours(target, s, id).1 {
            Some(j) => self.vehicles[j as usize].rank as usize,
            None => self.seg_vehicles[target as usize].len(),
        };
        let list = &mut self.seg_vehicles[target as usize];
        if list.is_empty() {
            self.occupied.push(target);
        }
        list.insert(k, i as u32);
        for (r, &j) in list.iter().enumerate().skip(k) {
            self.vehicles[j as usize].rank = r as u32;
        }
        let v = &mut self.vehicles[i];
        v.seg = target;
        v.pos = s;
        v.prev_seg = NONE;
    }

    /// Lists vehicle `i` (on another lane) as a shadow on `lane`, keeping the order.
    fn insert_shadow(&mut self, i: usize, lane: u32) {
        let (s, id) = (self.pos_on(i as u32, lane), self.vehicles[i].id);
        let list = &self.seg_shadows[lane as usize];
        let k = list.partition_point(|&j| {
            let p = self.pos_on(j, lane);
            p > s || (p == s && self.vehicles[j as usize].id < id)
        });
        if list.is_empty() {
            self.shadowed.push(lane);
        }
        self.seg_shadows[lane as usize].insert(k, i as u32);
    }

    /// Nearest merging vehicle (#81) on the ending lane to the right of vehicle `i`, between
    /// `behind` metres behind and `ahead` metres ahead of its front and within
    /// `merging.cooperationDistance` of the lane end: (index, front position on `i`'s lane).
    pub(super) fn merger_near(&self, i: usize, ahead: f64, behind: f64) -> Option<(u32, f64)> {
        let net = &self.net;
        let v = &self.vehicles[i];
        if !net.is_lane(v.seg) || net.lanes[v.seg as usize].index == 0 || !net.lane_ends(v.seg - 1) {
            return None;
        }
        let right = v.seg - 1;
        let (len, len_r) = (net.seg_length[v.seg as usize], net.seg_length[right as usize]);
        let s = v.pos * len_r / len;
        let list = &self.seg_vehicles[right as usize];
        let k = list.partition_point(|&j| self.vehicles[j as usize].pos >= s - behind);
        let j = *list.get(k.checked_sub(1)?)?;
        let m = &self.vehicles[j as usize];
        let wants_left = m.next_conn == NONE && self.has_next_link(m);
        (wants_left && m.pos <= s + ahead && len_r - m.pos <= self.config.merging.cooperation_distance)
            .then(|| (j, m.pos * len / len_r))
    }

    /// Nearest vehicle about to enter `lane` from an incoming connector (or from the lane before
    /// an empty connector): front position relative to the lane start (negative) and index.
    pub(super) fn incoming_follower(&self, lane: u32) -> Option<(f64, u32)> {
        let net = &self.net;
        net.lane_incoming(lane)
            .iter()
            .filter_map(|&ic| {
                let seg = net.connector_segment(ic);
                let clen = net.seg_length[seg as usize];
                let on_connector = self.seg_vehicles[seg as usize]
                    .first()
                    .map(|&j| (self.vehicles[j as usize].pos - clen, j));
                on_connector.or_else(|| {
                    let from = net.connectors[ic as usize].from_lane;
                    let flen = net.seg_length[from as usize];
                    self.seg_vehicles[from as usize]
                        .iter()
                        .find(|&&j| self.vehicles[j as usize].next_conn == ic)
                        .map(|&j| (self.vehicles[j as usize].pos - flen - clen, j))
                })
            })
            .max_by(|a, b| a.0.total_cmp(&b.0))
    }

    fn neighbour(&self, j: u32, limit: f64) -> Neighbour {
        let v = &self.vehicles[j as usize];
        Neighbour {
            pos: v.pos,
            length: v.params.length,
            speed: v.speed,
            idm: v.params.idm(limit),
        }
    }

    /// Whether `lane` leads along the route from `route[idx]` on (#126): through links too short to
    /// change lanes on (a junction of several nodes) up to the first one long enough. A lane that
    /// only reaches the next link but then a turn the route does not take is a dead end there.
    fn lane_leads_on(&self, lane: u32, route: u32, idx: u32, mask: u8) -> bool {
        const ROOM: f64 = 30.0;
        let net = &self.net;
        let route = &self.routes[route as usize];
        let mut lane = lane;
        for k in idx as usize..idx as usize + 4 {
            let Some(&next) = route.get(k) else {
                return true;
            };
            let c = net.choose_connector(lane, next, mask);
            if c == NONE {
                return false;
            }
            lane = net.connectors[c as usize].to_lane;
            if net.seg_length[lane as usize] >= ROOM {
                return true;
            }
        }
        true
    }

    /// Target lane of an advisable and safe lane change, if any.
    fn evaluate_lane_change(&self, i: usize, mandatory: Option<i32>, zone_start: f64) -> Option<u32> {
        let net = &self.net;
        let v = &self.vehicles[i];
        let lane = &net.lanes[v.seg as usize];
        let link = &net.links[lane.link as usize];
        let mask = v.params.class.mask();
        let next_link = self.routes[v.route as usize]
            .get(v.route_pos as usize + 1)
            .copied();
        let lc = &self.config.lane_change;
        let limit = net.seg_speed_limit[v.seg as usize];
        let me = self.neighbour(i as u32, limit);
        let urgency = (1.0 - (zone_start - v.pos) / lc.urgency_distance.max(1.0)).clamp(0.0, 1.0);

        // Current situation on the own lane (vehicles changing away from it included).
        let at = |(j, pos): (u32, f64), limit: f64| Neighbour {
            pos,
            ..self.neighbour(j, limit)
        };
        let (leader, old_follower) = self.own_lane_around(i);
        let leader = leader.map(|o| at(o, limit));
        let old_follower = old_follower.map(|o| at(o, limit));
        let gap_to = |back: &Neighbour, front: &Option<Neighbour>| {
            front
                .as_ref()
                .map_or((f64::INFINITY, 0.0), |f| (f.pos - f.length - back.pos, f.speed))
        };
        let (gap, leader_speed) = gap_to(&me, &leader);
        let a_me = me.acc(gap, leader_speed);

        let directions: &[i32] = match mandatory {
            Some(1) => &[1],
            Some(_) => &[-1],
            None => &[-1, 1],
        };
        let mut best: Option<(u32, f64)> = None;
        for &d in directions {
            let allowed = if d > 0 {
                lane.can_change_left
            } else {
                lane.can_change_right
            };
            let t_idx = lane.index as i32 + d;
            if !allowed || t_idx < 0 || t_idx >= link.lane_count as i32 {
                continue;
            }
            let target = link.first_lane + t_idx as u32;
            if net.lanes[target as usize].class_mask & mask == 0 {
                continue;
            }
            if mandatory.is_none()
                && next_link.is_some()
                && !self.lane_leads_on(target, v.route, v.route_pos + 1, mask)
            {
                continue;
            }
            let t_len = net.seg_length[target as usize];
            let s = v.pos * t_len / net.seg_length[v.seg as usize];
            if s >= t_len - link.no_lane_change_zone {
                continue;
            }
            let t_limit = net.seg_speed_limit[target as usize];
            let (lead, follow) = self.occupants_around(target, s, v.id);
            // Without a leader on the target lane, the last vehicle on the connector (or lane)
            // ahead on the route is the leader (position relative to the target lane start).
            let new_leader = match lead {
                Some(o) => Some(at(o, t_limit)),
                None => next_link.and_then(|n| {
                    let c = net.choose_connector(target, n, mask);
                    (c != NONE).then_some(c)?;
                    let seg = net.connector_segment(c);
                    let clen = net.seg_length[seg as usize];
                    let to = net.connectors[c as usize].to_lane;
                    let ((j, pos), offset) = match self.last_on(seg) {
                        Some(o) => (o, t_len),
                        None => (self.last_on(to)?, t_len + clen),
                    };
                    Some(Neighbour {
                        pos: offset + pos,
                        ..self.neighbour(j, t_limit)
                    })
                }),
            };
            // Without a follower on the target lane, the nearest vehicle about to enter it from
            // an incoming connector (or from the lane before it) is the follower (position
            // relative to the lane start).
            let new_follower = match follow {
                Some(o) => Some(at(o, t_limit)),
                None => self.incoming_follower(target).map(|(pos, j)| Neighbour {
                    pos,
                    ..self.neighbour(j, t_limit)
                }),
            };
            let moved = Neighbour {
                pos: s,
                idm: v.params.idm(t_limit),
                ..me
            };
            let (gap_front, front_speed) = gap_to(&moved, &new_leader);
            let gap_back = new_follower
                .as_ref()
                .map_or(f64::INFINITY, |f| s - me.length - f.pos);
            if gap_front < 1.0 || gap_back < 1.0 {
                continue;
            }
            let b_safe = v.params.safe_deceleration * if mandatory.is_some() { 1.0 + urgency } else { 1.0 };
            let a_me_new = moved.acc(gap_front, front_speed);
            let a_follower_new = new_follower.as_ref().map_or(0.0, |f| f.acc(gap_back, v.speed));
            if a_me_new < -b_safe || a_follower_new < -b_safe {
                continue;
            }
            if mandatory.is_some() {
                return Some(target);
            }
            // MOBIL incentive with politeness towards the new and the old follower.
            let follower_gain = new_follower.as_ref().map_or(0.0, |f| {
                let (g, s_l) = gap_to(f, &new_leader);
                a_follower_new - f.acc(g, s_l)
            });
            let old_follower_gain = old_follower.as_ref().map_or(0.0, |o| {
                let (g_now, _) = gap_to(o, &Some(me));
                let (g_after, s_after) = gap_to(o, &leader);
                o.acc(g_after, s_after) - o.acc(g_now, v.speed)
            });
            let mut bias = if link.road_class.keep_right() {
                -(d as f64) * lc.keep_right_bias
            } else {
                0.0
            };
            // Courtesy: make room for traffic merging from an ending lane on the right.
            let merging = &self.config.merging;
            if d > 0 && merging.cooperation && self.merger_near(i, 80.0, 20.0).is_some() {
                bias += merging.courtesy_bias;
            }
            // Strategic lane choice two links ahead (weaving): prefer lanes whose connector
            // leads to a lane that continues on the route.
            if let Some(&after) = self.routes[v.route as usize].get(v.route_pos as usize + 2)
                && let Some(next) = next_link
            {
                // Lane changes still needed on the next link when entering it from lane `l`.
                let changes_after = |l: u32| -> Option<f64> {
                    let c = net.choose_connector(l, next, mask);
                    if c == NONE {
                        return None;
                    }
                    let to = &net.lanes[net.connectors[c as usize].to_lane as usize];
                    let n = &net.links[next as usize];
                    (0..n.lane_count)
                        .filter(|&j| net.choose_connector(n.first_lane + j, after, mask) != NONE)
                        .map(|j| (j as i32 - to.index as i32).unsigned_abs())
                        .min()
                        .map(f64::from)
                };
                if let (Some(now), Some(then)) = (changes_after(v.seg), changes_after(target)) {
                    bias += STRATEGIC_BIAS * (now - then);
                }
            }
            let own_gain = a_me_new - a_me + bias;
            let incentive = own_gain + v.params.politeness * (follower_gain + old_follower_gain);
            // Drivers change for their own benefit (or the keep-right rule), not only to make
            // room for others.
            if own_gain > 0.01
                && incentive > v.params.lane_change_threshold
                && best.is_none_or(|(_, b)| incentive > b)
            {
                best = Some((target, incentive));
            }
        }
        best.map(|(t, _)| t)
    }

    fn apply_lane_change(&mut self, i: usize, target: u32, mandatory: bool) {
        let net = &self.net;
        let v = &self.vehicles[i];
        let (old, id) = (v.seg, v.id);
        let s = v.pos * net.seg_length[target as usize] / net.seg_length[old as usize];
        let from_index = net.lanes[old as usize].index;
        let to_index = net.lanes[target as usize].index;
        let width = 0.5 * (net.lanes[old as usize].width + net.lanes[target as usize].width);
        let link = net.lanes[old as usize].link;
        let duration = self.config.lane_change.duration_at(v.speed);

        self.move_occupant(i, target, s);
        if duration > 0.0 {
            self.insert_shadow(i, old);
        }
        let mut v = self.vehicles[i].clone();
        v.lc_timer = self.config.lane_change.cooldown;
        if duration > 0.0 {
            v.lc_from = old;
            v.lc_progress = 0.0;
            v.lc_rate = 1.0 / duration;
            v.lat_offset = self.change_offset(old, target, 0.0);
        } else {
            // Instantaneous change: moving left starts right of the new lane centre (negative
            // offset) and vice versa; the offset decays visually.
            v.lat_offset += if to_index > from_index { -width } else { width };
        }
        v.next_conn = self.connector_on_route(&v, target);
        self.vehicles[i] = v;
        self.counters.lane_changes += 1;
        if self.log_events {
            self.lane_change_log.push(LaneChangeEvent {
                vehicle: id,
                link,
                from_index,
                to_index,
                pos: s,
                mandatory,
            });
        }
    }

    /// Re-routes a vehicle from its current lane: the best destination route reachable through
    /// one of the lane's own connectors. A vehicle without any option is removed at the lane end
    /// (counted as stranded).
    pub(super) fn reroute(&mut self, i: usize) {
        let v = &self.vehicles[i];
        let lane = v.seg;
        let (class, fit) = (v.params.class, crate::routing::Fit::of(&v.params));
        let informed = self.is_informed(&v.params);
        let mask = class.mask();
        let link = self.net.lanes[lane as usize].link;
        let dest = *self.routes[v.route as usize].last().unwrap_or(&link);
        let options: Vec<u32> = self
            .net
            .lane_outgoing(lane)
            .iter()
            .copied()
            .filter(|&c| self.net.connectors[c as usize].class_mask & mask != 0)
            .collect();
        // Prefer the original destination; if it cannot be reached from this lane any more,
        // fall back to the nearest reachable exit.
        let mut best: Option<(f64, u32, u32)> = None;
        for targets in [vec![dest], self.net.exit_links()] {
            for &c in &options {
                let to = self.net.connectors[c as usize].to_link;
                let seg = self.net.connector_segment(c) as usize;
                let conn_time = self.net.seg_length[seg] / self.net.seg_speed_limit[seg];
                for &target in &targets {
                    let Some(route) = self.route_id(to, target, fit, informed) else {
                        continue;
                    };
                    let cost = conn_time
                        + self.router_for(informed).link_travel_time(to)
                        + self.router_for(informed).route_cost(&self.routes[route as usize]);
                    if best.is_none_or(|(b, _, _)| cost < b) {
                        best = Some((cost, c, route));
                    }
                }
            }
            if best.is_some() {
                break;
            }
        }
        self.counters.rerouted += 1;
        let v = &mut self.vehicles[i];
        match best {
            Some((_, c, route)) => {
                let mut links = vec![link];
                links.extend_from_slice(&self.routes[route as usize]);
                self.routes.push(links);
                v.route = (self.routes.len() - 1) as u32;
                v.route_pos = 0;
                v.next_conn = c;
            }
            None => {
                // Nothing reaches the destination: the vehicle is lost and removed at the end
                // of this lane (counted as stranded).
                self.routes.push(vec![link]);
                v.route = (self.routes.len() - 1) as u32;
                v.route_pos = 0;
                v.next_conn = NONE;
                v.lost = true;
            }
        }
    }
}
