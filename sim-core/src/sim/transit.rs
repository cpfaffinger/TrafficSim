//! Buses on fixed lines (#85, ADR-0019).
//!
//! Every line of the package with a headway (`transit` config) dispatches buses at its first
//! link: the first departure has a phase drawn from the line's own seeded stream, then one every
//! headway; a departure that cannot be inserted yet waits (FIFO per line). Buses follow the line's
//! links as their route (no router), so the regular route machinery (connectors, mandatory lane
//! changes, junctions) applies.
//!
//! At stops a bus moves to the kerb lane (mandatory lane change on multi-lane links), brakes for
//! a standing obstacle at the stop position, and once standing within [`STOP_TOLERANCE`] dwells for
//! `dwellTime` plus a uniform random part from the line's stream. A dwelling bus blocks its lane
//! (followers may overtake on multi-lane links); at a bay it leaves the lane: it is taken out of
//! the occupant lists and drawn offset to the right, and pulls out again only when the follower
//! on the lane can brake comfortably. A bus that is pushed past a stop (or re-routed off its line)
//! counts the stop as missed.
//!
//! Without lines (or with `transit.enabled = false`) nothing here draws random numbers or
//! changes any vehicle, so such runs stay bit-identical.

use std::collections::{BTreeMap, VecDeque};

use serde::Serialize;

use super::demand::Pending;
use super::perception::Accel;
use super::{Fnv, Simulation, Vehicle, flags};
use crate::idm::IdmParams;
use crate::network::{NONE, Network};
use crate::rng::Pcg32;
use crate::transit::Stop;
use crate::vehicle::{VehicleClass, VehicleParams};

/// A bus has arrived at a stop when its front is within this distance (m) of the stop position.
pub(super) const STOP_TOLERANCE: f64 = 3.0;
/// ... and it is slower than this (m/s).
const ARRIVE_SPEED: f64 = 0.5;
/// Buses stop at least this far into a link (m): they enter links at speed.
const MIN_STOP_POS: f64 = 20.0;
/// Lateral offset (m, to the right) of a bus standing in a bay and its lateral speed (m/s).
const BAY_OFFSET: f64 = 3.0;
const BAY_LATERAL_SPEED: f64 = 1.5;
/// RNG stream base of the lines.
const STREAM: u64 = 0x6000_0000;

#[derive(Debug, Clone, Default, PartialEq)]
struct LineStats {
    dispatched: u64,
    completed: u64,
    travel_time_sum: f64,
    served: u64,
    missed: u64,
    dwell_sum: f64,
    headway_sum: f64,
    headway_sq: f64,
    headway_n: u64,
}

#[derive(Debug, Clone)]
struct LineState {
    /// Index into [`Network::transit`].
    line: u32,
    headway: f64,
    /// Route id of the line's links.
    route: u32,
    next_departure: f64,
    /// Scheduled departures waiting for insertion.
    queue: VecDeque<f64>,
    rng: Pcg32,
    /// Last arrival per stop (s).
    last_arrival: Vec<f64>,
    stats: LineStats,
}

#[derive(Debug, Clone, PartialEq)]
struct Bus {
    /// Index into [`Transit::lines`].
    line: u32,
    next_stop: u32,
    dwelling: bool,
    dwell_start: f64,
    dwell_until: f64,
    bay: bool,
    depart: f64,
    /// Step in which the bus was last seen (to detect departed buses).
    seen: u64,
}

/// Transit state of a simulation.
#[derive(Debug, Clone, Default)]
pub(super) struct Transit {
    lines: Vec<LineState>,
    /// Bus state by vehicle id.
    buses: BTreeMap<u32, Bus>,
    params: Option<VehicleParams>,
}

/// What a bus has to do about lane changes before its next stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kerb {
    /// No stop ahead on this link (or not a line bus): regular lane changes.
    Free,
    /// Dwelling: no lane change at all.
    Dwelling,
    /// Stop ahead on this link: change towards the kerb lane.
    MoveRight,
    /// Stop ahead on this link and already in the kerb lane: stay.
    Stay,
}

/// KPIs of one line (`transit` in the run summary).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitLineMetrics {
    pub id: String,
    /// Line number or name.
    pub label: Option<String>,
    /// Scheduled headway (s).
    pub headway: f64,
    /// Buses dispatched, finished (left the network) and currently running.
    pub buses: u64,
    pub completed: u64,
    pub active: u64,
    /// Scheduled departures still waiting to enter the network.
    pub waiting_to_depart: u64,
    /// Mean time in the network of finished buses (s).
    pub mean_travel_time: Option<f64>,
    pub stops: u32,
    pub stops_served: u64,
    pub stops_missed: u64,
    /// Mean dwell time per served stop (s).
    pub mean_dwell: Option<f64>,
    /// Observed headway at the stops (mean over consecutive arrivals, s) and its coefficient of
    /// variation (0 = perfectly regular; bunching raises it).
    pub observed_headway: Option<f64>,
    pub headway_cv: Option<f64>,
}

/// Stop position (m) on lane `seg` of the stop's link.
fn stop_on_lane(net: &Network, stop: &Stop, seg: u32) -> f64 {
    let len = net.links[stop.link as usize].length;
    let pos = stop.pos.max(MIN_STOP_POS.min(0.5 * len));
    pos * net.seg_length[seg as usize] / len
}

impl Transit {
    fn bus(&self, v: &Vehicle) -> Option<&Bus> {
        if self.buses.is_empty() || v.params.class != VehicleClass::Bus {
            return None;
        }
        self.buses.get(&v.id)
    }

    /// A bus running a line (#132): it keeps to its line and never takes navigation detours.
    pub(super) fn scheduled(&self, v: &Vehicle) -> bool {
        self.bus(v).is_some()
    }

    pub(super) fn dwelling(&self, v: &Vehicle) -> bool {
        self.bus(v).is_some_and(|b| b.dwelling)
    }

    /// Standing in a bay: not an occupant of its lane.
    pub(super) fn in_bay(&self, v: &Vehicle) -> bool {
        self.bus(v).is_some_and(|b| b.dwelling && b.bay)
    }

    pub(super) fn hash(&self, h: &mut Fnv) {
        for l in &self.lines {
            h.f64(l.next_departure);
            h.u64(l.queue.len() as u64);
        }
        for (&id, b) in &self.buses {
            h.u64(u64::from(id));
            h.u64(u64::from(b.next_stop));
            h.u64(u64::from(b.dwelling));
            h.f64(b.dwell_until);
        }
    }
}

impl Simulation {
    /// Sets up the lines' dispatching (called once by [`Simulation::new`]).
    pub(super) fn init_transit(&mut self) -> Result<(), String> {
        let cfg = &self.config.transit;
        if !cfg.enabled || self.net.transit.is_empty() {
            return Ok(());
        }
        if let Some(id) = cfg
            .headways
            .keys()
            .find(|id| !self.net.transit.iter().any(|l| &l.id == *id))
        {
            return Err(format!("transit.headways references unknown line '{id}'"));
        }
        let ty = self
            .fleet
            .catalogue
            .index(&cfg.vehicle_type)
            .ok_or_else(|| format!("unknown transit.vehicleType '{}'", cfg.vehicle_type))?;
        let mut params = self.fleet.catalogue.get(ty).params();
        params.vehicle_type = ty;
        params.reaction_time = VehicleParams::for_class(VehicleClass::Bus).reaction_time;
        self.transit.params = Some(params);
        for (li, line) in self.net.transit.iter().enumerate() {
            let Some(headway) = cfg.headway(line) else {
                continue;
            };
            let mut rng = Pcg32::new(self.seed, STREAM + li as u64);
            let next_departure = rng.next_f64() * headway;
            self.routes.push(line.links.clone());
            self.transit.lines.push(LineState {
                line: li as u32,
                headway,
                route: (self.routes.len() - 1) as u32,
                next_departure,
                queue: VecDeque::new(),
                rng,
                last_arrival: vec![f64::NEG_INFINITY; line.stops.len()],
                stats: LineStats::default(),
            });
        }
        Ok(())
    }

    /// Scheduled departures and their insertion at the first link of each line.
    pub(super) fn spawn_transit(&mut self) {
        let Some(params) = self.transit.params else {
            return;
        };
        for li in 0..self.transit.lines.len() {
            let l = &mut self.transit.lines[li];
            while l.next_departure <= self.time {
                l.queue.push_back(l.next_departure);
                l.next_departure += l.headway;
            }
            if l.queue.is_empty() || self.vehicles.len() >= self.config.max_vehicles as usize {
                continue;
            }
            let route = l.route;
            let first = self.routes[route as usize][0];
            let pending = Pending {
                params,
                route,
                frac: 0.0,
            };
            if self.try_insert(first, &pending) {
                let id = self.vehicles[self.vehicles.len() - 1].id;
                let l = &mut self.transit.lines[li];
                l.queue.pop_front();
                l.stats.dispatched += 1;
                self.transit.buses.insert(
                    id,
                    Bus {
                        line: li as u32,
                        next_stop: 0,
                        dwelling: false,
                        dwell_start: 0.0,
                        dwell_until: 0.0,
                        bay: false,
                        depart: self.time,
                        seen: self.steps,
                    },
                );
            }
        }
    }

    /// Whether vehicle `i` is a bus dwelling at a stop.
    pub(super) fn transit_dwelling(&self, i: usize) -> bool {
        self.transit.dwelling(&self.vehicles[i])
    }

    /// Lane-change constraint of vehicle `i` before its next stop.
    pub(super) fn transit_kerb(&self, i: usize) -> Kerb {
        let v = &self.vehicles[i];
        let Some(bus) = self.transit.bus(v) else {
            return Kerb::Free;
        };
        if bus.dwelling {
            return Kerb::Dwelling;
        }
        let net = &self.net;
        let Some(stop) = self.next_stop(v, bus) else {
            return Kerb::Free;
        };
        if stop.route_pos != v.route_pos
            || !net.is_lane(v.seg)
            || v.pos > stop_on_lane(net, stop, v.seg) + STOP_TOLERANCE
        {
            return Kerb::Free;
        }
        let lane = &net.lanes[v.seg as usize];
        let kerb = net.links[lane.link as usize].first_lane;
        if lane.index == 0 || net.lanes[kerb as usize].class_mask & v.params.class.mask() == 0 {
            Kerb::Stay
        } else {
            Kerb::MoveRight
        }
    }

    /// The bus's next stop, if it is still on its line.
    fn next_stop(&self, v: &Vehicle, bus: &Bus) -> Option<&Stop> {
        let l = &self.transit.lines[bus.line as usize];
        if v.route != l.route {
            return None;
        }
        self.net.transit[l.line as usize]
            .stops
            .get(bus.next_stop as usize)
    }

    /// Standing obstacle at the next stop of a bus (on its current or the next link).
    pub(super) fn transit_stop(&self, a: &mut Accel, idm: &IdmParams, i: usize) {
        let v = &self.vehicles[i];
        let Some(bus) = self.transit.bus(v) else {
            return;
        };
        let Some(stop) = self.next_stop(v, bus) else {
            return;
        };
        let net = &self.net;
        let rp = v.route_pos;
        let d = match net.segment_connector(v.seg) {
            None if stop.route_pos == rp => stop_on_lane(net, stop, v.seg) - v.pos,
            None if stop.route_pos == rp + 1 && v.next_conn != NONE => {
                let c = net.connector_segment(v.next_conn);
                let to = net.connectors[v.next_conn as usize].to_lane;
                net.seg_length[v.seg as usize] - v.pos
                    + net.seg_length[c as usize]
                    + stop_on_lane(net, stop, to)
            }
            Some(c) if stop.route_pos == rp => {
                let to = net.connectors[c as usize].to_lane;
                net.seg_length[v.seg as usize] - v.pos + stop_on_lane(net, stop, to)
            }
            _ => return,
        };
        // Front standing still about 0.5 m before the stop position.
        Self::stop_at(a, idm, v.speed, d + idm.minimum_gap);
    }

    /// Arrivals at stops, dwelling and pulling out, missed stops and departed buses (after the
    /// integration of a step).
    pub(super) fn update_transit(&mut self) {
        if self.transit.buses.is_empty() {
            return;
        }
        let (time, step) = (self.time, self.steps);
        let cfg = &self.config.transit;
        let (base, spread) = (cfg.dwell_time, cfg.dwell_time_random);
        for i in 0..self.vehicles.len() {
            let v = &self.vehicles[i];
            if v.params.class != VehicleClass::Bus {
                continue;
            }
            let Some(mut bus) = self.transit.buses.get(&v.id).cloned() else {
                continue;
            };
            bus.seen = step;
            let li = bus.line as usize;
            let (route, line) = (self.transit.lines[li].route, self.transit.lines[li].line as usize);
            let stops = &self.net.transit[line].stops;
            if v.route != route {
                // Re-routed off its line (a missed turn): the remaining stops are missed, and a bus
                // re-routed while dwelling pulls out (#132: it stood still forever).
                self.transit.lines[li].stats.missed +=
                    (stops.len() as u64).saturating_sub(u64::from(bus.next_stop));
                bus.next_stop = stops.len() as u32;
                bus.dwelling = false;
                bus.bay = false;
            } else if bus.dwelling {
                if time >= bus.dwell_until && (!bus.bay || self.bay_exit_clear(i)) {
                    bus.dwelling = false;
                    bus.bay = false;
                    bus.next_stop += 1;
                } else {
                    let v = &mut self.vehicles[i];
                    if bus.bay {
                        v.lat_offset = -(BAY_OFFSET.min((time - bus.dwell_start) * BAY_LATERAL_SPEED));
                    }
                    v.flags |= flags::DWELLING;
                }
            } else {
                let on_lane = self.net.is_lane(v.seg);
                while let Some(s) = stops.get(bus.next_stop as usize) {
                    let k = bus.next_stop as usize;
                    let stop_s = if on_lane {
                        stop_on_lane(&self.net, s, v.seg)
                    } else {
                        f64::INFINITY
                    };
                    let here = s.route_pos == v.route_pos && on_lane;
                    if s.route_pos < v.route_pos || (here && v.pos > stop_s + STOP_TOLERANCE) {
                        self.transit.lines[li].stats.missed += 1;
                        bus.next_stop += 1;
                        continue;
                    }
                    if here && v.pos >= stop_s - STOP_TOLERANCE && v.speed < ARRIVE_SPEED {
                        let l = &mut self.transit.lines[li];
                        let dwell = base
                            + if spread > 0.0 {
                                l.rng.next_f64() * spread
                            } else {
                                0.0
                            };
                        (bus.dwelling, bus.bay) = (true, s.bay);
                        (bus.dwell_start, bus.dwell_until) = (time, time + dwell);
                        let st = &mut l.stats;
                        st.served += 1;
                        st.dwell_sum += dwell;
                        let last = l.last_arrival[k];
                        if last.is_finite() {
                            let h = time - last;
                            st.headway_sum += h;
                            st.headway_sq += h * h;
                            st.headway_n += 1;
                        }
                        l.last_arrival[k] = time;
                        let v = &mut self.vehicles[i];
                        v.speed = 0.0;
                        v.acc = 0.0;
                        v.flags |= flags::DWELLING;
                    }
                    break;
                }
            }
            let id = self.vehicles[i].id;
            self.transit.buses.insert(id, bus);
        }
        // Buses that left the network.
        let lines = &mut self.transit.lines;
        let net = &self.net;
        self.transit.buses.retain(|_, b| {
            if b.seen == step {
                return true;
            }
            let l = &mut lines[b.line as usize];
            let stops = net.transit[l.line as usize].stops.len() as u64;
            l.stats.completed += 1;
            l.stats.travel_time_sum += time - b.depart;
            l.stats.missed += stops.saturating_sub(u64::from(b.next_stop));
            false
        });
    }

    /// Whether a bus standing in a bay can pull out: the lane is clear around it and the
    /// follower can brake comfortably.
    fn bay_exit_clear(&self, i: usize) -> bool {
        let v = &self.vehicles[i];
        let (lead, follow) = self.occupants_around(v.seg, v.pos, v.id);
        if let Some((j, pos)) = lead
            && pos - self.vehicles[j as usize].params.length - v.pos < 1.0
        {
            return false;
        }
        let behind = match follow {
            Some((j, pos)) => Some((pos, j)),
            None => self.incoming_follower(v.seg),
        };
        behind.is_none_or(|(pos, j)| {
            let f = &self.vehicles[j as usize];
            let p = &f.params;
            v.pos - v.params.length - pos
                >= p.minimum_gap + f.speed * f.speed / (2.0 * p.comfortable_deceleration) + f.speed
        })
    }

    /// Per-line KPIs since the start of the run (`transit` in the summary).
    pub fn transit_metrics(&self) -> Vec<TransitLineMetrics> {
        self.transit
            .lines
            .iter()
            .enumerate()
            .map(|(li, l)| {
                let line = &self.net.transit[l.line as usize];
                let s = &l.stats;
                let active = self
                    .transit
                    .buses
                    .values()
                    .filter(|b| b.line == li as u32)
                    .count() as u64;
                let mean = (s.headway_n > 0).then(|| s.headway_sum / s.headway_n as f64);
                let cv = mean.filter(|_| s.headway_n > 1).map(|m| {
                    let var = (s.headway_sq / s.headway_n as f64 - m * m).max(0.0);
                    var.sqrt() / m.max(1e-9)
                });
                TransitLineMetrics {
                    id: line.id.clone(),
                    label: line.label.clone(),
                    headway: l.headway,
                    buses: s.dispatched,
                    completed: s.completed,
                    active,
                    waiting_to_depart: l.queue.len() as u64,
                    mean_travel_time: (s.completed > 0).then(|| s.travel_time_sum / s.completed as f64),
                    stops: line.stops.len() as u32,
                    stops_served: s.served,
                    stops_missed: s.missed,
                    mean_dwell: (s.served > 0).then(|| s.dwell_sum / s.served as f64),
                    observed_headway: mean,
                    headway_cv: cv,
                }
            })
            .collect()
    }

    /// [`Self::transit_metrics`] as JSON.
    pub fn transit_json(&self) -> String {
        serde_json::to_string(&self.transit_metrics()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests;
