//! Lane changes (#46, #97): discretionary MOBIL (Kesting, Treiber & Helbing 2007) with
//! politeness, safety criterion, threshold and keep-right bias, plus mandatory changes towards a
//! lane that has a connector to the next link of the route.
//!
//! Rules: a change is only proposed where the lane boundary allows it (`allowLeft` /
//! `allowRight`), never inside the link's `noLaneChangeZone`, never for a vehicle that has
//! claimed its junction entry. A vehicle that reaches the zone in a lane without a connector to
//! its next link re-routes from the lane it is in.

use super::{LaneChangeEvent, Simulation};
use crate::idm::IdmParams;
use crate::network::NONE;

/// A vehicle still in a wrong lane re-routes at the latest this far before the lane end (m).
const REROUTE_BEFORE_END: f64 = 15.0;

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
            let link = &self.net.links[self.net.lanes[v.seg as usize].link as usize];
            let len = self.net.seg_length[v.seg as usize];
            let zone_start = len - link.no_lane_change_zone;
            let wrong_lane = v.next_conn == NONE && self.has_next_link(v);
            if wrong_lane && v.pos >= zone_start.min(len - REROUTE_BEFORE_END) {
                self.reroute(i);
                continue;
            }
            if v.lc_timer > 0.0 || v.pos >= zone_start {
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
    fn neighbours(&self, lane: u32, s: f64, id: u32) -> (Option<u32>, Option<u32>) {
        let list = &self.seg_vehicles[lane as usize];
        let k = list.partition_point(|&j| {
            let v = &self.vehicles[j as usize];
            v.pos > s || (v.pos == s && v.id < id)
        });
        let leader = k.checked_sub(1).map(|k| list[k]);
        (leader, list.get(k).copied())
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

        // Current situation on the own lane.
        let list = &self.seg_vehicles[v.seg as usize];
        let leader = (v.rank > 0).then(|| self.neighbour(list[v.rank as usize - 1], limit));
        let old_follower = list.get(v.rank as usize + 1).map(|&j| self.neighbour(j, limit));
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
            if mandatory.is_none() && next_link.is_some_and(|n| net.choose_connector(target, n, mask) == NONE)
            {
                continue;
            }
            let t_len = net.seg_length[target as usize];
            let s = v.pos * t_len / net.seg_length[v.seg as usize];
            if s >= t_len - link.no_lane_change_zone {
                continue;
            }
            let t_limit = net.seg_speed_limit[target as usize];
            let (lead, follow) = self.neighbours(target, s, v.id);
            let new_leader = lead.map(|j| self.neighbour(j, t_limit));
            // Without a follower on the target lane, the nearest vehicle about to enter it from
            // an incoming connector (or from the lane before it) is the follower (position
            // relative to the lane start).
            let new_follower = match follow {
                Some(j) => Some(self.neighbour(j, t_limit)),
                None => net
                    .lane_incoming(target)
                    .iter()
                    .filter_map(|&ic| {
                        let seg = net.connector_segment(ic);
                        let clen = net.seg_length[seg as usize];
                        let on_connector = self.seg_vehicles[seg as usize].first().map(|&j| Neighbour {
                            pos: self.vehicles[j as usize].pos - clen,
                            ..self.neighbour(j, t_limit)
                        });
                        on_connector.or_else(|| {
                            let from = net.connectors[ic as usize].from_lane;
                            let flen = net.seg_length[from as usize];
                            self.seg_vehicles[from as usize]
                                .iter()
                                .find(|&&j| self.vehicles[j as usize].next_conn == ic)
                                .map(|&j| Neighbour {
                                    pos: self.vehicles[j as usize].pos - flen - clen,
                                    ..self.neighbour(j, t_limit)
                                })
                        })
                    })
                    .max_by(|a, b| a.pos.total_cmp(&b.pos)),
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
            let bias = if link.road_class.keep_right() {
                -(d as f64) * lc.keep_right_bias
            } else {
                0.0
            };
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
        let (old, rank, id) = (v.seg, v.rank as usize, v.id);
        let s = v.pos * net.seg_length[target as usize] / net.seg_length[old as usize];
        let from_index = net.lanes[old as usize].index;
        let to_index = net.lanes[target as usize].index;
        let width = 0.5 * (net.lanes[old as usize].width + net.lanes[target as usize].width);
        let link = net.lanes[old as usize].link;

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

        let mut v = self.vehicles[i].clone();
        v.seg = target;
        v.pos = s;
        v.prev_seg = NONE;
        v.lc_timer = self.config.lane_change.cooldown;
        // Moving left starts right of the new lane centre (negative offset) and vice versa.
        v.lat_offset += if to_index > from_index { -width } else { width };
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
        let class = v.params.class;
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
                    let Some(route) = self.route_id(to, target, class) else {
                        continue;
                    };
                    let cost = conn_time
                        + self.router.link_travel_time(to)
                        + self.router.route_cost(&self.routes[route as usize]);
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
