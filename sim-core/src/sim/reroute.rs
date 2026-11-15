//! Experienced link travel times and commuter re-routing (#55).
//!
//! Every vehicle leaving a link reports its time on the link (lane entry to lane exit, including
//! waiting at the stop line). Every `reRouting.interval` seconds the mean of these reports is
//! blended into an exponentially smoothed travel time per link; links without reports whose
//! occupants have already stayed longer than the estimate (gridlock) use that stay, links
//! without traffic relax towards free flow. Familiar drivers (driver profile `familiarity`) route on these times when
//! they are generated and, at every update, re-plan from their current link if the new route is
//! faster by more than `reRouting.threshold`. Everything runs in vehicle order at fixed times,
//! so it is deterministic.

use super::{INFORMED, Simulation};
use crate::config::SimConfig;
use crate::network::{NONE, Network};
use crate::routing::Fit;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct TravelTimes {
    sum: Vec<f64>,
    count: Vec<u32>,
    longest: Vec<f64>,
    free_flow: Vec<f64>,
    /// Smoothed experienced travel time per link (s).
    pub smoothed: Vec<f64>,
    /// Reports per link since the start of the run (for metrics).
    pub reports: Vec<u64>,
    next_update: f64,
}

impl TravelTimes {
    pub(super) fn new(net: &Network, config: &SimConfig) -> Self {
        let free_flow: Vec<f64> = net.links.iter().map(|l| l.length / l.speed_limit).collect();
        let n = free_flow.len();
        Self {
            sum: vec![0.0; n],
            count: vec![0; n],
            longest: vec![0.0; n],
            smoothed: free_flow.clone(),
            free_flow,
            reports: vec![0; n],
            next_update: config.re_routing.interval,
        }
    }

    /// A vehicle spent `seconds` on `link`.
    pub(super) fn record(&mut self, link: u32, seconds: f64) {
        let l = link as usize;
        self.sum[l] += seconds;
        self.count[l] += 1;
        self.reports[l] += 1;
    }
}

impl Simulation {
    /// Periodic travel-time update and en-route re-routing (at the start of a step).
    pub(super) fn update_travel_times(&mut self) {
        if self.time < self.travel_times.next_update {
            return;
        }
        let r = &self.config.re_routing;
        let (alpha, en_route) = (r.smoothing, r.en_route && r.enabled);
        let tt = &mut self.travel_times;
        tt.next_update += r.interval;
        for v in &self.vehicles {
            if self.net.is_lane(v.seg) {
                let l = self.net.lanes[v.seg as usize].link as usize;
                tt.longest[l] = tt.longest[l].max(self.time - v.link_enter);
            }
        }
        for l in 0..tt.smoothed.len() {
            let mean = (tt.count[l] > 0).then(|| tt.sum[l] / f64::from(tt.count[l]));
            let observed = mean.or((tt.longest[l] > tt.smoothed[l]).then_some(tt.longest[l]));
            let target = observed.unwrap_or(tt.free_flow[l]);
            tt.smoothed[l] += alpha * (target - tt.smoothed[l]);
            tt.sum[l] = 0.0;
            tt.count[l] = 0;
            tt.longest[l] = 0.0;
            self.informed.set_link_travel_time(l as u32, tt.smoothed[l]);
        }
        self.route_cache.retain(|k, _| k.2 & INFORMED == 0);
        self.dest_cache.retain(|k, _| k.1 & INFORMED == 0);
        if en_route {
            self.reroute_commuters();
        }
    }

    /// Familiar drivers on a lane re-plan from their current link.
    fn reroute_commuters(&mut self) {
        let threshold = self.config.re_routing.threshold;
        let horizon = self.config.lane_change.urgency_distance;
        for i in 0..self.vehicles.len() {
            let v = &self.vehicles[i];
            if !self.is_informed(&v.params) || !self.net.is_lane(v.seg) || v.claimed != NONE || v.lost {
                continue;
            }
            let route = &self.routes[v.route as usize];
            let rp = v.route_pos as usize;
            if rp + 1 >= route.len() {
                continue;
            }
            let (cur, dest, fit, seg) = (route[rp], route[route.len() - 1], Fit::of(&v.params), v.seg);
            let Some(new) = self.route_id(cur, dest, fit, true) else {
                continue;
            };
            let old_cost = self
                .informed
                .route_cost(&self.routes[self.vehicles[i].route as usize][rp..]);
            let new_route = &self.routes[new as usize];
            let faster = self.informed.route_cost(new_route) < old_cost * (1.0 - threshold);
            if !faster || new_route[..] == self.routes[self.vehicles[i].route as usize][rp..] {
                continue;
            }
            let conn = self.net.choose_connector(seg, new_route[1], fit.class.mask());
            let link = &self.net.links[cur as usize];
            let to_end = self.net.seg_length[seg as usize] - self.vehicles[i].pos;
            // A new turn that needs lane changes is only taken with enough room to change.
            if conn == NONE && to_end < horizon + link.no_lane_change_zone {
                continue;
            }
            let v = &mut self.vehicles[i];
            v.route = new;
            v.route_pos = 0;
            v.next_conn = conn;
            self.counters.commuter_reroutes += 1;
        }
    }
}
