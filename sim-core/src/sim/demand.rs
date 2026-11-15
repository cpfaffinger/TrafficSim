//! Sources and insertion (#42, #53).
//!
//! Two kinds of arrival processes, each with its own PCG32 stream (changing one never changes
//! another):
//!
//! - **boundary sources**, one per entry node (`demand` / `defaultDemand`, destinations weighted
//!   by `destinationWeights` over all exits), optionally scaled by `demandProfile`;
//! - **OD sources**, one per `od` entry: origin links of the `from` zone, destination links of
//!   the `to` zone, own time-of-day curve and vehicle/driver mixes;
//! - **residential sources** (`autoZones`, #112): outbound trips from residential links
//!   (weighted by length, starting along the link) to higher road classes and exits, and
//!   inbound trips back.
//!
//! Boundary demand (#111): `entries` > `demand` > `defaultDemand` > road-class profile
//! (`volumePerLane` × lanes of the entry links, with the profile's curve).
//!
//! Generated vehicles wait in a FIFO queue per entry link and are inserted at the start of the
//! link (or along it) once the gap is safe (one insertion per entry link and step).

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;

use super::{Simulation, pick_index};
use crate::config::SimConfig;
use crate::demand::{RoadClassProfiles, TimeProfile, Zone, arrival_after, resolve_profile};
use crate::detmath;
use crate::driver::{Cdf, Fleet};
use crate::network::{NONE, Network};
use crate::package::NodeControl;
use crate::rng::Pcg32;
use crate::routing::Fit;
use crate::vehicle::VehicleParams;

/// One arrival process (`demandJson`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DemandSource {
    /// `boundary`, `od`, `residentialOut` or `residentialIn`.
    pub kind: &'static str,
    /// Entry node id of a boundary source.
    pub node: Option<String>,
    /// OD matrix index of an OD source.
    pub od: Option<u32>,
    /// Base rate (vehicles per hour at curve factor 1).
    pub vph: f64,
    /// Current time-of-day factor.
    pub factor: f64,
    /// Number of origin links.
    pub origins: u32,
}

#[derive(Debug, Clone)]
pub(super) struct Pending {
    pub params: VehicleParams,
    pub route: u32,
    /// Insertion point as a fraction of the link length (0 = at the start).
    pub frac: f64,
}

/// Kind of an arrival process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SourceKind {
    Boundary,
    Od,
    ResidentialOut,
    ResidentialIn,
}

#[derive(Debug, Clone)]
pub(super) struct Source {
    pub kind: SourceKind,
    /// Entry node of a boundary source, [`NONE`] otherwise.
    pub node: u32,
    /// Index in the OD matrix, [`NONE`] otherwise.
    pub od: u32,
    pub origins: Vec<u32>,
    /// Cumulative origin weights (empty = uniform).
    pub origin_cum: Vec<f64>,
    pub dest_set: u32,
    /// Destinations are drawn by weight first and then routed (large destination sets);
    /// otherwise drawn among the reachable ones.
    pub sampled: bool,
    /// Vehicles start at a random position along the origin link.
    pub along: bool,
    /// Base rate (vehicles per second at profile factor 1).
    pub rate: f64,
    /// Time-of-day profile index, [`NONE`] = constant.
    pub profile: u32,
    pub types: Cdf<u16>,
    pub type_weights: Vec<(u16, f64)>,
    pub drivers: Cdf<u8>,
    pub next_arrival: f64,
    pub rng: Pcg32,
}

#[derive(Debug, Clone)]
pub(super) struct EntryQueue {
    pub link: u32,
    pub queue: VecDeque<Pending>,
}

#[derive(Debug, Clone)]
pub(super) struct Demand {
    pub sources: Vec<Source>,
    /// Insertion queues, sorted by link.
    pub queues: Vec<EntryQueue>,
    queue_of_link: Vec<u32>,
    /// Destination sets: (link, weight). Set 0 = all exits with `destinationWeights`.
    pub dest_sets: Vec<Vec<(u32, f64)>>,
    /// Cumulative weights of every destination set.
    dest_cum: Vec<Vec<f64>>,
    profiles: Vec<TimeProfile>,
    /// Time-of-day profile per catalogue type ([`NONE`] = constant share).
    type_profile: Vec<u32>,
    /// Time of day at simulation time 0 (s).
    pub start_time: f64,
}

/// Cumulative sums of weights.
fn cumulative(weights: impl Iterator<Item = f64>) -> Vec<f64> {
    let mut acc = 0.0;
    weights
        .map(|w| {
            acc += w;
            acc
        })
        .collect()
}

/// Index drawn with `u ∈ [0, 1)` from cumulative weights.
fn pick_cum(cum: &[f64], u: f64) -> usize {
    let total = cum.last().copied().unwrap_or(0.0);
    cum.partition_point(|&c| c <= u * total)
        .min(cum.len().saturating_sub(1))
}

#[derive(Clone, Copy, PartialEq)]
enum End {
    Origin,
    Destination,
}

fn zone_links(net: &Network, name: &str, zone: &Zone, end: End) -> Result<Vec<u32>, String> {
    let mut links = Vec::new();
    for id in &zone.nodes {
        let node = net
            .node_index(id)
            .ok_or_else(|| format!("zone '{name}' references unknown node '{id}'"))?;
        links.extend((0..net.links.len() as u32).filter(|&l| {
            let info = &net.links[l as usize];
            if end == End::Origin {
                info.from == node
            } else {
                info.to == node
            }
        }));
    }
    for id in &zone.links {
        links.push(
            net.link_index(id)
                .ok_or_else(|| format!("zone '{name}' references unknown link '{id}'"))?,
        );
    }
    links.sort_unstable();
    links.dedup();
    if links.is_empty() {
        let what = if end == End::Origin {
            "origin"
        } else {
            "destination"
        };
        return Err(format!("zone '{name}' has no {what} links"));
    }
    Ok(links)
}

impl Demand {
    pub(super) fn build(net: &Network, config: &SimConfig, fleet: &Fleet, seed: u64) -> Result<Self, String> {
        let mut d = Demand {
            sources: Vec::new(),
            queues: Vec::new(),
            queue_of_link: vec![NONE; net.links.len()],
            dest_sets: Vec::new(),
            dest_cum: Vec::new(),
            profiles: Vec::new(),
            type_profile: vec![NONE; fleet.catalogue.len()],
            start_time: config.start_time_of_day.0,
        };
        let mut profile_names: BTreeMap<String, u32> = BTreeMap::new();
        let mut profile = |d: &mut Demand, name: &Option<String>| -> Result<u32, String> {
            let Some(name) = name else { return Ok(NONE) };
            if let Some(&i) = profile_names.get(name) {
                return Ok(i);
            }
            d.profiles.push(resolve_profile(&config.curves, name)?);
            let i = (d.profiles.len() - 1) as u32;
            profile_names.insert(name.clone(), i);
            Ok(i)
        };
        for (ty, name) in &config.vehicle_mix_curves {
            if let Some(t) = fleet.catalogue.index(ty) {
                d.type_profile[t as usize] = profile(&mut d, &Some(name.clone()))?;
            }
        }

        // Boundary sources: one per entry node.
        let mut by_node: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for link in net.entry_links() {
            by_node
                .entry(net.links[link as usize].from)
                .or_default()
                .push(link);
        }
        for id in config.demand.keys().chain(config.entries.keys()) {
            match net.node_index(id) {
                Some(n) if by_node.contains_key(&n) => {}
                _ => return Err(format!("demand references '{id}', which is not an entry node")),
            }
        }
        let class_profiles = RoadClassProfiles::with_overrides(&config.profiles)?;
        let auto_entries = config.auto_entries.unwrap_or(config.od.is_empty());
        let exits = net
            .exit_links()
            .into_iter()
            .map(|exit| {
                let node = &net.nodes[net.links[exit as usize].to as usize].id;
                (exit, *config.destination_weights.get(node).unwrap_or(&1.0))
            })
            .filter(|e| e.1 > 0.0)
            .collect();
        d.dest_sets.push(exits);
        let uniform = config.default_demand.filter(|_| config.od.is_empty());
        let type_weights = fleet.type_weights(&config.vehicle_mix)?;
        for (node, links) in by_node {
            let id = &net.nodes[node as usize].id;
            // Precedence: entries > demand > defaultDemand > road-class profiles.
            let explicit = match config.entries.get(id) {
                Some(e) => Some((e.vph(), e.curve().map(str::to_string))),
                None => config.demand.get(id).map(|&v| (v, None)),
            };
            let (vph, curve) = match (explicit, uniform) {
                (Some((v, c)), _) => (v, c),
                (None, Some(v)) => (v, None),
                (None, None) if auto_entries => {
                    // Volume per lane of each entry link's road class; the curve of the busiest.
                    let mut best: Option<(f64, &str)> = None;
                    let mut vph = 0.0;
                    // Entries without a way to another exit generate nothing (#148).
                    for &l in links.iter().filter(|&&l| net.reaches_another_exit(l)) {
                        let info = &net.links[l as usize];
                        let p = class_profiles.get(info.road_class.key());
                        let v = p.volume_per_lane * f64::from(info.lane_count);
                        vph += v;
                        if best.is_none_or(|(b, _)| v > b) {
                            best = Some((v, &p.curve));
                        }
                    }
                    (vph, best.map(|b| b.1.to_string()))
                }
                (None, None) => (0.0, None),
            };
            let curve = profile(&mut d, &config.demand_curve.clone().or(curve))?;
            let mut src = Source {
                kind: SourceKind::Boundary,
                node,
                od: NONE,
                origins: links,
                origin_cum: Vec::new(),
                dest_set: 0,
                sampled: false,
                along: false,
                rate: 0.0,
                profile: curve,
                types: fleet.types.clone(),
                type_weights: type_weights.clone(),
                drivers: fleet.drivers.clone(),
                next_arrival: f64::INFINITY,
                rng: Pcg32::new(seed, 0x1000 + u64::from(node)),
            };
            d.set_rate(&mut src, vph, 0.0);
            d.sources.push(src);
        }

        // OD sources.
        for (i, od) in config.od.iter().enumerate() {
            let zone = |name: &str| &config.zones[name];
            let origins = zone_links(net, &od.from, zone(&od.from), End::Origin)?;
            let dests = zone_links(net, &od.to, zone(&od.to), End::Destination)?;
            d.dest_sets.push(dests.into_iter().map(|l| (l, 1.0)).collect());
            let mix = od.vehicle_mix.as_ref().unwrap_or(&config.vehicle_mix);
            let mut src = Source {
                kind: SourceKind::Od,
                node: NONE,
                od: i as u32,
                origins,
                origin_cum: Vec::new(),
                dest_set: (d.dest_sets.len() - 1) as u32,
                sampled: false,
                along: false,
                rate: 0.0,
                profile: profile(&mut d, &od.curve)?,
                types: fleet.type_cdf(mix)?,
                type_weights: fleet.type_weights(mix)?,
                drivers: match &od.driver_mix {
                    Some(m) => fleet.driver_cdf(m)?,
                    None => fleet.drivers.clone(),
                },
                next_arrival: f64::INFINITY,
                rng: Pcg32::new(seed, 0x2000_0000 + i as u64),
            };
            d.set_rate(&mut src, od.vph, 0.0);
            d.sources.push(src);
        }

        if config.auto_zones {
            d.residential_sources(net, config, fleet, seed, &mut profile)?;
        }
        d.dest_cum = d
            .dest_sets
            .iter()
            .map(|set| cumulative(set.iter().map(|e| e.1)))
            .collect();

        let mut entry_links: Vec<u32> = d.sources.iter().flat_map(|s| s.origins.iter().copied()).collect();
        entry_links.sort_unstable();
        entry_links.dedup();
        for link in entry_links {
            d.queue_of_link[link as usize] = d.queues.len() as u32;
            d.queues.push(EntryQueue {
                link,
                queue: VecDeque::new(),
            });
        }
        Ok(d)
    }

    /// Residential trip generation (#112): one outbound process from all residential links
    /// (weighted by length) to higher road classes and exits, one inbound process back.
    fn residential_sources(
        &mut self,
        net: &Network,
        config: &SimConfig,
        fleet: &Fleet,
        seed: u64,
        profile: &mut impl FnMut(&mut Demand, &Option<String>) -> Result<u32, String>,
    ) -> Result<(), String> {
        let r = &config.residential;
        let is_res = |l: u32| {
            r.classes
                .iter()
                .any(|c| c == net.links[l as usize].road_class.key())
        };
        let boundary = |node: u32| net.nodes[node as usize].control == NodeControl::Boundary;
        let homes: Vec<(u32, f64)> = (0..net.links.len() as u32)
            .filter(|&l| is_res(l))
            .map(|l| (l, net.links[l as usize].length))
            .collect();
        let work = |entering: bool| -> Vec<(u32, f64)> {
            (0..net.links.len() as u32)
                .filter(|&l| !is_res(l))
                .map(|l| {
                    let info = &net.links[l as usize];
                    let at_boundary = boundary(if entering { info.from } else { info.to });
                    (l, r.weight(info.road_class.key(), at_boundary))
                })
                .filter(|e| e.1 > 0.0)
                .collect()
        };
        let km: f64 = homes.iter().map(|h| h.1).sum::<f64>() / 1000.0;
        let drivers = match &r.driver_mix {
            Some(m) => fleet.driver_cdf(m)?,
            None => fleet.drivers.clone(),
        };
        let out_dests = work(false);
        let in_origins = work(true);
        let plans = [
            (
                SourceKind::ResidentialOut,
                homes.clone(),
                out_dests,
                r.outbound_per_km,
                &r.outbound_curve,
                1,
            ),
            (
                SourceKind::ResidentialIn,
                in_origins,
                homes,
                r.inbound_per_km,
                &r.inbound_curve,
                2,
            ),
        ];
        for (kind, origins, dests, per_km, curve, stream) in plans {
            // Origins without a way to any destination generate nothing (#151: residential streets in
            // road pieces cut by the area; their trips were dropped as unroutable).
            let reaching = net.links_reaching(dests.iter().map(|d| d.0));
            let origins: Vec<(u32, f64)> = origins.into_iter().filter(|o| reaching[o.0 as usize]).collect();
            if origins.is_empty() || dests.is_empty() {
                continue;
            }
            self.dest_sets.push(dests);
            let mut src = Source {
                kind,
                node: NONE,
                od: NONE,
                origin_cum: cumulative(origins.iter().map(|o| o.1)),
                origins: origins.into_iter().map(|o| o.0).collect(),
                dest_set: (self.dest_sets.len() - 1) as u32,
                sampled: true,
                along: kind == SourceKind::ResidentialOut && r.insert_along_link,
                rate: 0.0,
                profile: profile(self, &Some(curve.clone()))?,
                types: fleet.types.clone(),
                type_weights: fleet.type_weights(&config.vehicle_mix)?,
                drivers: drivers.clone(),
                next_arrival: f64::INFINITY,
                rng: Pcg32::new(seed, 0x3000_0000 + stream),
            };
            // Outbound volume follows the homes that can generate trips at all.
            let km = if kind == SourceKind::ResidentialOut {
                src.origins
                    .iter()
                    .map(|&l| net.links[l as usize].length)
                    .sum::<f64>()
                    / 1000.0
            } else {
                km
            };
            self.set_rate(&mut src, per_km * km, 0.0);
            self.sources.push(src);
        }
        Ok(())
    }

    fn profile(&self, p: u32) -> Option<&TimeProfile> {
        (p != NONE).then(|| &self.profiles[p as usize])
    }

    /// Sets the base rate and draws the next arrival from `now`.
    fn set_rate(&self, src: &mut Source, vehicles_per_hour: f64, now: f64) {
        src.rate = vehicles_per_hour / 3600.0;
        src.next_arrival = if src.rate > 0.0 {
            let work = -detmath::ln(1.0 - src.rng.next_f64());
            arrival_after(now, work, src.rate, self.profile(src.profile), self.start_time)
        } else {
            f64::INFINITY
        };
    }

    /// Generated vehicles not inserted yet.
    pub(super) fn waiting(&self) -> u64 {
        self.queues.iter().map(|q| q.queue.len() as u64).sum()
    }

    fn type_profiles_active(&self) -> bool {
        self.type_profile.iter().any(|&p| p != NONE)
    }

    /// Current rate factor of a source's profile.
    fn factor(&self, src: &Source, now: f64) -> f64 {
        self.profile(src.profile)
            .map_or(1.0, |p| p.factor(self.start_time + now))
    }
}

impl Simulation {
    pub(super) fn spawn(&mut self) {
        for si in 0..self.demand.sources.len() {
            while self.demand.sources[si].next_arrival <= self.time {
                self.generate(si);
            }
        }
        for qi in 0..self.demand.queues.len() {
            if self.vehicles.len() < self.config.max_vehicles as usize
                && let Some(pending) = self.demand.queues[qi].queue.front().cloned()
                && self.try_insert(self.demand.queues[qi].link, &pending)
            {
                self.demand.queues[qi].queue.pop_front();
            }
        }
    }

    /// One arrival at source `si`: type, driver, entry link and destination are drawn from the
    /// source's own random stream.
    fn generate(&mut self, si: usize) {
        let d = &self.demand;
        let src = &d.sources[si];
        let mut rng = src.rng.clone();
        let params = if d.type_profiles_active() {
            let tod = d.start_time + self.time;
            let weights: Vec<(u16, f64)> = src
                .type_weights
                .iter()
                .map(|&(t, w)| {
                    let p = d.type_profile[t as usize];
                    (
                        t,
                        if p == NONE {
                            w
                        } else {
                            w * d.profiles[p as usize].factor(tod)
                        },
                    )
                })
                .collect();
            let cdf = Fleet::cdf_of(&weights);
            let types = if cdf.is_empty() { &src.types } else { &cdf };
            self.fleet.sample(types, &src.drivers, &mut rng)
        } else {
            self.fleet.sample(&src.types, &src.drivers, &mut rng)
        };
        let n = src.origins.len();
        let link = src.origins[if src.origin_cum.is_empty() {
            pick_index(&mut rng, n)
        } else if n <= 1 {
            0
        } else {
            pick_cum(&src.origin_cum, rng.next_f64())
        }];
        let frac = if src.along { rng.next_f64() } else { 0.0 };
        let sampled = src.sampled;
        let u_dest = rng.next_f64();
        let work = -detmath::ln(1.0 - rng.next_f64());
        let next = arrival_after(
            src.next_arrival,
            work,
            src.rate,
            d.profile(src.profile),
            d.start_time,
        );
        let dest_set = src.dest_set;
        let src = &mut self.demand.sources[si];
        src.next_arrival = next;
        src.rng = rng;
        let informed = self.is_informed(&params);
        let fit = Fit::of(&params);
        let route = if sampled {
            self.sample_destination(link, fit, informed, dest_set, u_dest)
        } else {
            self.pick_destination(link, fit, informed, dest_set, u_dest)
        };
        match route {
            Some(route) => {
                let q = self.demand.queue_of_link[link as usize] as usize;
                self.demand.queues[q]
                    .queue
                    .push_back(Pending { params, route, frac });
            }
            None => self.counters.unroutable += 1,
        }
    }

    /// Draws a destination of `set` by weight and routes to it; retries a few times with a
    /// stream derived from `u` when the draw is unreachable. Avoids routing to every candidate
    /// of large destination sets.
    fn sample_destination(&mut self, entry: u32, fit: Fit, informed: bool, set: u32, u: f64) -> Option<u32> {
        let mut retry = Pcg32::new(u.to_bits(), 7);
        let origin = self.net.links[entry as usize].from;
        let mut u = u;
        for _ in 0..8 {
            let k = pick_cum(&self.demand.dest_cum[set as usize], u);
            let dest = self.demand.dest_sets[set as usize][k].0;
            if dest != entry
                && self.net.links[dest as usize].to != origin
                && let Some(route) = self.route_id(entry, dest, fit, informed)
            {
                return Some(route);
            }
            u = retry.next_f64();
        }
        None
    }

    /// Route to a destination of `set` drawn with `u` among the reachable ones (U-turns back to
    /// the origin node excluded); `None` if none is reachable.
    fn pick_destination(&mut self, entry: u32, fit: Fit, informed: bool, set: u32, u: f64) -> Option<u32> {
        let key = (
            entry,
            super::cache_class(fit.class, informed),
            set,
            self.router.fit_key(&fit),
        );
        if !self.dest_cache.contains_key(&key) {
            let origin = self.net.links[entry as usize].from;
            let candidates = self.demand.dest_sets[set as usize].clone();
            let mut list = Vec::new();
            let mut acc = 0.0;
            for (exit, w) in candidates {
                if w <= 0.0 || self.net.links[exit as usize].to == origin {
                    continue;
                }
                if let Some(route) = self.route_id(entry, exit, fit, informed) {
                    acc += w;
                    list.push((route, acc));
                }
            }
            self.dest_cache.insert(key, list);
        }
        let list = &self.dest_cache[&key];
        let &(last, total) = list.last()?;
        let target = u * total;
        Some(list.iter().find(|(_, cum)| target < *cum).map_or(last, |e| e.0))
    }

    /// Inserts a pending vehicle at the start of `link` if a lane has a safe gap ahead (and,
    /// for links inside the network, behind towards vehicles arriving from upstream).
    /// Gap and speed of the nearest vehicle beyond an empty lane along the route (#153: an entry
    /// link of 3 m at the area boundary; vehicles were inserted on top of the queue behind it).
    fn gap_beyond(&self, lane: u32, route: &[u32], mask: u8) -> (f64, f64) {
        let net = &self.net;
        let c = super::choose_on_route(net, route, lane, 1, mask);
        if c == NONE {
            return (f64::INFINITY, f64::INFINITY);
        }
        let len = net.seg_length[lane as usize];
        let seg = net.connector_segment(c);
        let ahead = |base: f64, seg: u32| {
            self.last_on(seg).map(|(j, pos)| {
                let l = &self.vehicles[j as usize];
                (base + pos - l.params.length, l.speed)
            })
        };
        ahead(len, seg)
            .or_else(|| {
                ahead(
                    len + net.seg_length[seg as usize],
                    net.connectors[c as usize].to_lane,
                )
            })
            .unwrap_or((f64::INFINITY, f64::INFINITY))
    }

    pub(super) fn try_insert(&mut self, link: u32, p: &Pending) -> bool {
        if p.frac > 0.0 {
            return self.try_insert_along(link, p);
        }
        let info = &self.net.links[link as usize];
        let mask = p.params.class.mask();
        let route = &self.routes[p.route as usize];
        let next = route.get(1).copied();
        let lanes = info.first_lane..info.first_lane + info.lane_count;
        let allowed = |l: &u32| self.net.lanes[*l as usize].class_mask & mask != 0;
        let on_route = |l: &u32| next.is_none_or(|n| self.net.choose_connector(*l, n, mask) != NONE);
        let candidates: Vec<u32> = if lanes.clone().any(|l| allowed(&l) && on_route(&l)) {
            lanes.filter(|l| allowed(l) && on_route(l)).collect()
        } else {
            lanes.filter(allowed).collect()
        };
        let pr = &p.params;
        // Lane with the largest free space at its start (ties: rightmost).
        let mut best: Option<(u32, f64, f64)> = None;
        for lane in candidates {
            let (gap, leader_speed) = match self.last_on(lane) {
                Some((j, pos)) => {
                    let l = &self.vehicles[j as usize];
                    (pos - l.params.length, l.speed)
                }
                // An entry lane too short to hold the vehicle: the leader is beyond it.
                None if self.net.seg_length[lane as usize] < p.params.length + p.params.minimum_gap => {
                    self.gap_beyond(lane, &self.routes[p.route as usize], mask)
                }
                None => (f64::INFINITY, f64::INFINITY),
            };
            // Vehicles about to enter the lane from upstream need room behind the new vehicle.
            if let Some((pos, j)) = self.incoming_follower(lane) {
                let f = &self.vehicles[j as usize];
                if -pr.length - pos < f.params.minimum_gap + f.speed * f.params.time_headway {
                    continue;
                }
            }
            if best.is_none_or(|(_, g, _)| gap > g) {
                best = Some((lane, gap, leader_speed));
            }
        }
        let Some((lane, gap, leader_speed)) = best else {
            return false;
        };
        // Insert at the leader's speed (capped by the desired speed) once the equilibrium gap
        // for that speed is available.
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

    /// Inserts a vehicle at standstill at `frac × length` on the rightmost allowed lane (a
    /// driveway), when the leader is far enough ahead and the follower can stop comfortably.
    fn try_insert_along(&mut self, link: u32, p: &Pending) -> bool {
        let info = &self.net.links[link as usize];
        let pr = &p.params;
        let mask = pr.class.mask();
        let Some(lane) = (info.first_lane..info.first_lane + info.lane_count)
            .find(|&l| self.net.lanes[l as usize].class_mask & mask != 0)
        else {
            return false;
        };
        let len = self.net.seg_length[lane as usize];
        let s = (p.frac * len).clamp(pr.length.min(len), len);
        let (lead, follow) = self.occupants_around(lane, s, u32::MAX);
        if let Some((j, pos)) = lead {
            let l = &self.vehicles[j as usize];
            if pos - l.params.length - s < pr.minimum_gap + 1.0 {
                return false;
            }
        }
        let behind = match follow {
            Some((j, pos)) => Some((pos, j)),
            None => self.incoming_follower(lane),
        };
        if let Some((pos, j)) = behind {
            let f = &self.vehicles[j as usize].params;
            let v = self.vehicles[j as usize].speed;
            if s - pr.length - pos < f.minimum_gap + v * v / (2.0 * f.comfortable_deceleration) + v {
                return false;
            }
        }
        let i = self.new_vehicle(p.params, lane, s, 0.0, p.route);
        let k = match self.neighbours(lane, s, u32::MAX).1 {
            Some(j) => self.vehicles[j as usize].rank as usize,
            None => self.seg_vehicles[lane as usize].len(),
        };
        let list = &mut self.seg_vehicles[lane as usize];
        if list.is_empty() {
            self.occupied.push(lane);
        }
        list.insert(k, i as u32);
        for (r, &j) in list.iter().enumerate().skip(k) {
            self.vehicles[j as usize].rank = r as u32;
        }
        self.counters.spawned += 1;
        true
    }

    /// Changes the base arrival rate (vehicles per hour) of an entry node at runtime.
    pub fn set_demand(&mut self, node_id: &str, vehicles_per_hour: f64) -> Result<(), String> {
        let node = self.net.node_index(node_id);
        let si = self
            .demand
            .sources
            .iter()
            .position(|s| s.node != NONE && Some(s.node) == node)
            .ok_or_else(|| format!("'{node_id}' is not an entry node"))?;
        self.set_source_rate(si, vehicles_per_hour)
    }

    /// Base arrival rate (vehicles per hour) of an entry node.
    pub fn demand(&self, node_id: &str) -> Option<f64> {
        let node = self.net.node_index(node_id)?;
        self.demand
            .sources
            .iter()
            .find(|s| s.node == node)
            .map(|s| s.rate * 3600.0)
    }

    /// Changes the rate (vehicles per hour at factor 1) of OD matrix entry `index` at runtime.
    pub fn set_od_demand(&mut self, index: usize, vehicles_per_hour: f64) -> Result<(), String> {
        let si = self
            .demand
            .sources
            .iter()
            .position(|s| s.od == index as u32)
            .ok_or_else(|| format!("no OD entry {index}"))?;
        self.set_source_rate(si, vehicles_per_hour)
    }

    /// Base rate of OD entry `index` (vehicles per hour) and its current time-of-day factor.
    pub fn od_demand(&self, index: usize) -> Option<(f64, f64)> {
        let d = &self.demand;
        d.sources
            .iter()
            .find(|s| s.od == index as u32)
            .map(|s| (s.rate * 3600.0, d.factor(s, self.time)))
    }

    fn set_source_rate(&mut self, si: usize, vehicles_per_hour: f64) -> Result<(), String> {
        if !(vehicles_per_hour.is_finite() && vehicles_per_hour >= 0.0) {
            return Err("demand must be finite and non-negative".into());
        }
        let mut src = self.demand.sources[si].clone();
        self.demand.set_rate(&mut src, vehicles_per_hour, self.time);
        self.demand.sources[si] = src;
        Ok(())
    }

    /// All arrival processes with their base rate and current time-of-day factor.
    pub fn demand_sources(&self) -> Vec<DemandSource> {
        let d = &self.demand;
        d.sources
            .iter()
            .map(|s| DemandSource {
                kind: match s.kind {
                    SourceKind::Boundary => "boundary",
                    SourceKind::Od => "od",
                    SourceKind::ResidentialOut => "residentialOut",
                    SourceKind::ResidentialIn => "residentialIn",
                },
                node: (s.node != NONE).then(|| self.net.nodes[s.node as usize].id.clone()),
                od: (s.od != NONE).then_some(s.od),
                vph: s.rate * 3600.0,
                factor: d.factor(s, self.time),
                origins: s.origins.len() as u32,
            })
            .collect()
    }

    /// [`Self::demand_sources`] as JSON.
    pub fn demand_json(&self) -> String {
        serde_json::to_string(&self.demand_sources()).unwrap_or_default()
    }

    /// Time of day (seconds since midnight, wrapping at 24 h).
    pub fn time_of_day(&self) -> f64 {
        (self.demand.start_time + self.time).rem_euclid(crate::demand::DAY)
    }
}
