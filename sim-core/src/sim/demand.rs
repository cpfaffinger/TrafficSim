//! Sources and insertion (#42, #53).
//!
//! Two kinds of arrival processes, each with its own PCG32 stream (changing one never changes
//! another):
//!
//! - **boundary sources**, one per entry node (`demand` / `defaultDemand`, destinations weighted
//!   by `destinationWeights` over all exits), optionally scaled by `demandProfile`;
//! - **OD sources**, one per `od` entry: origin links of the `from` zone, destination links of
//!   the `to` zone, own time-of-day profile and vehicle/driver mixes.
//!
//! Generated vehicles wait in a FIFO queue per entry link and are inserted at the start of the
//! link once the gap is safe (one insertion per entry link and step).

use std::collections::{BTreeMap, VecDeque};

use super::{Simulation, pick_index};
use crate::config::SimConfig;
use crate::demand::{TimeProfile, Zone, arrival_after, resolve_profile};
use crate::detmath;
use crate::driver::{Cdf, Fleet};
use crate::network::{NONE, Network};
use crate::rng::Pcg32;
use crate::vehicle::{VehicleClass, VehicleParams};

#[derive(Debug, Clone)]
pub(super) struct Pending {
    pub params: VehicleParams,
    pub route: u32,
}

#[derive(Debug, Clone)]
pub(super) struct Source {
    /// Entry node of a boundary source, [`NONE`] for OD sources.
    pub node: u32,
    /// Index in the OD matrix, [`NONE`] for boundary sources.
    pub od: u32,
    pub origins: Vec<u32>,
    pub dest_set: u32,
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
    profiles: Vec<TimeProfile>,
    /// Time-of-day profile per catalogue type ([`NONE`] = constant share).
    type_profile: Vec<u32>,
    /// Time of day at simulation time 0 (s).
    pub start_time: f64,
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
            profiles: Vec::new(),
            type_profile: vec![NONE; fleet.catalogue.len()],
            start_time: config.start_time.0,
        };
        let mut profile_names: BTreeMap<String, u32> = BTreeMap::new();
        let mut profile = |d: &mut Demand, name: &Option<String>| -> Result<u32, String> {
            let Some(name) = name else { return Ok(NONE) };
            if let Some(&i) = profile_names.get(name) {
                return Ok(i);
            }
            d.profiles.push(resolve_profile(&config.time_profiles, name)?);
            let i = (d.profiles.len() - 1) as u32;
            profile_names.insert(name.clone(), i);
            Ok(i)
        };
        for (ty, name) in &config.vehicle_mix_profiles {
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
        for id in config.demand.keys() {
            match net.node_index(id) {
                Some(n) if by_node.contains_key(&n) => {}
                _ => return Err(format!("demand references '{id}', which is not an entry node")),
            }
        }
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
        let boundary_profile = profile(&mut d, &config.demand_profile)?;
        let default_vph = if config.od.is_empty() {
            config.default_demand
        } else {
            0.0
        };
        let type_weights = fleet.type_weights(&config.vehicle_mix)?;
        for (node, links) in by_node {
            let vph = *config
                .demand
                .get(&net.nodes[node as usize].id)
                .unwrap_or(&default_vph);
            let mut src = Source {
                node,
                od: NONE,
                origins: links,
                dest_set: 0,
                rate: 0.0,
                profile: boundary_profile,
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
                node: NONE,
                od: i as u32,
                origins,
                dest_set: (d.dest_sets.len() - 1) as u32,
                rate: 0.0,
                profile: profile(&mut d, &od.profile)?,
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
        let class = params.class;
        let link = src.origins[pick_index(&mut rng, src.origins.len())];
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
        match self.pick_destination(link, class, informed, dest_set, u_dest) {
            Some(route) => {
                let q = self.demand.queue_of_link[link as usize] as usize;
                self.demand.queues[q].queue.push_back(Pending { params, route });
            }
            None => self.counters.unroutable += 1,
        }
    }

    /// Route to a destination of `set` drawn with `u` among the reachable ones (U-turns back to
    /// the origin node excluded); `None` if none is reachable.
    fn pick_destination(
        &mut self,
        entry: u32,
        class: VehicleClass,
        informed: bool,
        set: u32,
        u: f64,
    ) -> Option<u32> {
        let key = (entry, super::cache_class(class, informed), set);
        if !self.dest_cache.contains_key(&key) {
            let origin = self.net.links[entry as usize].from;
            let candidates = self.demand.dest_sets[set as usize].clone();
            let mut list = Vec::new();
            let mut acc = 0.0;
            for (exit, w) in candidates {
                if w <= 0.0 || self.net.links[exit as usize].to == origin {
                    continue;
                }
                if let Some(route) = self.route_id(entry, exit, class, informed) {
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
    fn try_insert(&mut self, link: u32, p: &Pending) -> bool {
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
            let (gap, leader_speed) = match self.seg_vehicles[lane as usize].last() {
                Some(&j) => {
                    let l = &self.vehicles[j as usize];
                    (l.pos - l.params.length, l.speed)
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

    /// Time of day (seconds since midnight, wrapping at 24 h).
    pub fn time_of_day(&self) -> f64 {
        (self.demand.start_time + self.time).rem_euclid(crate::demand::DAY)
    }
}
