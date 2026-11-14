//! Metrics glue (#57, #58, #62, #84): queue sampling, phenomena detection, junction metrics,
//! the run summary and the `lane-cells-v1` accessors.
//!
//! Detection runs on the occupant lists at the start of a step (the state after the previous
//! step), in lane order, so it is deterministic. Nothing here feeds back into the dynamics.

use serde::Serialize;

use super::Simulation;
use crate::metrics::{
    MAX_EVENTS, MAX_TAILBACK_SAMPLES, Metrics, Tailback, WAVE_CONFIRMATIONS, WAVE_SPEED, WAVE_SPEED_RANGE,
    Wave, WaveCandidate, level_of_service,
};
use crate::network::NONE;
use crate::package::Priority;

/// A run of consecutive congested vehicles on one lane.
#[derive(Debug, Clone, Copy)]
struct Run {
    front: f64,
    back: f64,
    count: u32,
    min_speed: f64,
    anchored: bool,
}

/// Queue at one junction approach (link).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproachMetrics {
    pub link: String,
    /// Longest queue (m) and mean queue (m) over the samples.
    pub queue_max: f64,
    pub queue_mean: f64,
    /// Most vehicles queued at once (all lanes).
    pub queue_max_vehicles: u32,
}

/// One movement (connector) through a junction.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovementMetrics {
    pub connector: String,
    pub from_link: String,
    pub to_link: String,
    pub turn: String,
    /// Vehicles that entered the movement and their flow (veh/h).
    pub count: u64,
    pub flow: f64,
    /// Mean time below 0.5 m/s and mean delay on the approach link (s per vehicle).
    pub mean_wait: Option<f64>,
    pub mean_delay: Option<f64>,
    pub los: Option<String>,
}

/// Metrics of one junction (node with connectors).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JunctionMetrics {
    pub id: String,
    pub control: String,
    pub signalised: bool,
    pub throughput: u64,
    /// Vehicles per hour through the junction.
    pub flow: f64,
    /// Volume-weighted mean delay (s per vehicle) and HCM level of service.
    pub mean_delay: Option<f64>,
    pub mean_wait: Option<f64>,
    pub los: Option<String>,
    pub queue_max: f64,
    pub approaches: Vec<ApproachMetrics>,
    pub movements: Vec<MovementMetrics>,
}

/// Per-link KPIs of a run (the `links` array of the summary).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkMetrics {
    pub id: String,
    pub length: f64,
    pub lanes: u32,
    /// Space-mean speed (m/s), `null` without traffic.
    pub mean_speed: Option<f64>,
    /// Mean speed over the speed limit.
    pub speed_ratio: Option<f64>,
    /// Vehicles leaving the link per hour.
    pub flow: f64,
    /// Mean number of vehicles per km of link (all lanes).
    pub density: f64,
    /// Mean delay per vehicle leaving the link (s), `null` if none left it.
    pub delay: Option<f64>,
    /// Total vehicle-seconds lost against the speed limit.
    pub delay_total: f64,
    pub queue_max: f64,
    pub queue_mean: f64,
    pub stops: u64,
    /// Smoothed experienced travel time (s) and free-flow time (s).
    pub travel_time: f64,
    pub free_flow_time: f64,
}

/// Network-wide KPIs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkKpis {
    pub spawned: u64,
    pub arrived: u64,
    pub active: u64,
    pub waiting_to_enter: u64,
    pub stranded: u64,
    pub unroutable: u64,
    pub rerouted: u64,
    pub commuter_reroutes: u64,
    pub lane_changes: u64,
    pub lapses: u64,
    /// Mean travel time of arrived vehicles (s, whole run).
    pub mean_travel_time: f64,
    /// Space-mean speed over all lanes since the metrics start (m/s).
    pub mean_speed: f64,
    pub vehicle_km: f64,
    pub vehicle_hours: f64,
    pub delay_hours: f64,
    pub stops: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCounts {
    pub tailbacks: u64,
    pub stop_and_go_waves: u64,
}

/// Run summary (`summaryJson`): network KPIs, per-link metrics, junctions and event counts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub format_version: u32,
    /// Simulated time (s) and the duration the totals cover (since the last metrics reset).
    pub time: f64,
    pub duration: f64,
    pub start_time_of_day: f64,
    pub network: NetworkKpis,
    pub links: Vec<LinkMetrics>,
    pub junctions: Vec<JunctionMetrics>,
    pub events: EventCounts,
}

#[derive(Serialize)]
struct Events<'a> {
    tailbacks: &'a [Tailback],
    waves: &'a [Wave],
}

/// snake_case of a `Debug` name (`SharpLeft` → `sharp_left`).
fn snake(name: String) -> String {
    let mut s = String::with_capacity(name.len() + 4);
    for (i, ch) in name.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                s.push('_');
            }
            s.push(ch.to_ascii_lowercase());
        } else {
            s.push(ch);
        }
    }
    s
}

fn per_vehicle(total: f64, count: u64) -> Option<f64> {
    (count > 0).then(|| total / count as f64)
}

impl Simulation {
    /// Queue sampling and phenomena detection at their intervals (start of a step).
    pub(super) fn sample_metrics(&mut self) {
        let Some(m) = self.metrics.as_deref() else {
            return;
        };
        let (queues, detect) = (
            self.steps.is_multiple_of(m.queue_steps),
            self.steps.is_multiple_of(m.detect_steps) && self.steps > 0,
        );
        if queues {
            self.sample_queues();
        }
        if detect {
            self.detect_phenomena();
        }
    }

    fn sample_queues(&mut self) {
        let Some(m) = self.metrics.as_deref_mut() else {
            return;
        };
        let (speed, gap) = (m.config.queue_speed, m.config.jam_gap);
        m.queue_scratch.fill((0.0, 0));
        for &seg in &self.occupied {
            if !self.net.is_lane(seg) {
                continue;
            }
            let len = self.net.seg_length[seg as usize];
            let mut back = len;
            let mut n = 0;
            for &j in &self.seg_vehicles[seg as usize] {
                let v = &self.vehicles[j as usize];
                if v.speed >= speed || back - v.pos > gap {
                    break;
                }
                back = v.pos - v.params.length;
                n += 1;
            }
            if n > 0 {
                let q = &mut m.queue_scratch[self.net.lanes[seg as usize].link as usize];
                q.0 = q.0.max(len - back.max(0.0));
                q.1 += n;
            }
        }
        for (t, &(q, n)) in m.links.iter_mut().zip(&m.queue_scratch) {
            t.queue_max = t.queue_max.max(q);
            t.queue_sum += q;
            t.queue_max_vehicles = t.queue_max_vehicles.max(n);
        }
        m.queue_samples += 1;
    }

    /// Congested runs on `lane` (downstream first).
    fn runs(&self, m: &Metrics, lane: u32, out: &mut Vec<Run>) {
        out.clear();
        let (speed, gap) = (m.config.congested_speed, m.config.jam_gap);
        let len = self.net.seg_length[lane as usize];
        let mut cur: Option<Run> = None;
        for &j in &self.seg_vehicles[lane as usize] {
            let v = &self.vehicles[j as usize];
            if v.speed >= speed {
                out.extend(cur.take());
                continue;
            }
            match &mut cur {
                Some(r) if r.back - v.pos <= gap => {
                    r.back = v.pos - v.params.length;
                    r.count += 1;
                    r.min_speed = r.min_speed.min(v.speed);
                }
                _ => {
                    out.extend(cur.take());
                    cur = Some(Run {
                        front: v.pos,
                        back: v.pos - v.params.length,
                        count: 1,
                        min_speed: v.speed,
                        anchored: len - v.pos <= gap || v.stop_dist.is_finite(),
                    });
                }
            }
        }
        out.extend(cur);
    }

    fn detect_phenomena(&mut self) {
        let Some(mut m) = self.metrics.take() else {
            return;
        };
        let t = self.time;
        let dt = m.detect_interval;
        let gap = m.config.jam_gap;
        let min_len = m.config.tailback_min_length;
        let mut old = std::mem::take(&mut m.phenomena.candidates);
        let mut next: Vec<WaveCandidate> = Vec::with_capacity(old.len());
        let mut runs = Vec::new();
        let mut oi = 0;
        for lane in 0..self.net.lane_count() as u32 {
            let start = oi;
            while oi < old.len() && old[oi].lane == lane {
                oi += 1;
            }
            let has_old = oi > start;
            let list_empty = self.seg_vehicles[lane as usize].is_empty();
            if list_empty && !has_old && m.phenomena.active_tailback[lane as usize] == NONE {
                continue;
            }
            self.runs(&m, lane, &mut runs);
            let info = &self.net.lanes[lane as usize];
            let link_id = &self.net.links[info.link as usize].id;
            let ph = &mut m.phenomena;

            // Tailbacks: the longest congested run of the lane.
            let longest = runs
                .iter()
                .copied()
                .max_by(|a, b| (a.front - a.back).total_cmp(&(b.front - b.back)));
            let length = longest.map_or(0.0, |r| r.front - r.back);
            let active = ph.active_tailback[lane as usize];
            match longest {
                Some(r) if length >= min_len => {
                    if active == NONE {
                        if ph.tailbacks.len() < MAX_EVENTS {
                            ph.active_tailback[lane as usize] = ph.tailbacks.len() as u32;
                            ph.tailbacks.push(Tailback {
                                lane,
                                link: link_id.clone(),
                                lane_index: info.index,
                                start: t,
                                end: None,
                                head: r.front,
                                length,
                                max_length: length,
                                spillback: r.back <= gap,
                                samples: vec![[t as f32, length as f32]],
                            });
                        }
                        ph.tailback_count += 1;
                    } else {
                        let tb = &mut ph.tailbacks[active as usize];
                        tb.head = r.front;
                        tb.length = length;
                        tb.max_length = tb.max_length.max(length);
                        tb.spillback |= r.back <= gap;
                        if tb.samples.len() < MAX_TAILBACK_SAMPLES {
                            tb.samples.push([t as f32, length as f32]);
                        }
                    }
                }
                _ if active != NONE && length < 0.5 * min_len => {
                    ph.tailbacks[active as usize].end = Some(t);
                    ph.active_tailback[lane as usize] = NONE;
                }
                _ if active != NONE => {
                    let tb = &mut ph.tailbacks[active as usize];
                    tb.length = length;
                    if tb.samples.len() < MAX_TAILBACK_SAMPLES {
                        tb.samples.push([t as f32, length as f32]);
                    }
                }
                _ => {}
            }

            // Stop-and-go waves: congested clusters whose front moves upstream.
            let candidates = &mut old[start..oi];
            for r in runs.iter().filter(|r| r.count >= 2) {
                let expected = WAVE_SPEED * dt;
                let matched = candidates
                    .iter_mut()
                    .filter(|c| c.last_seen < t && r.front >= c.front - 60.0 && r.front <= c.front + 10.0)
                    .min_by(|a, b| {
                        let da = (r.front - (a.front + expected)).abs();
                        let db = (r.front - (b.front + expected)).abs();
                        da.total_cmp(&db)
                    });
                match matched {
                    Some(c) => {
                        c.front = r.front;
                        c.back = r.back;
                        c.last_seen = t;
                        c.observations += 1;
                        c.min_speed = c.min_speed.min(r.min_speed);
                        c.anchored |= r.anchored;
                        let speed = (c.front - c.first_front) / (t - c.first_seen);
                        let wave = !c.anchored
                            && c.observations >= WAVE_CONFIRMATIONS
                            && (WAVE_SPEED_RANGE.0..=WAVE_SPEED_RANGE.1).contains(&speed);
                        if wave && c.event == NONE {
                            ph.wave_count += 1;
                            if ph.waves.len() < MAX_EVENTS {
                                c.event = ph.waves.len() as u32;
                                ph.waves.push(Wave {
                                    lane,
                                    link: link_id.clone(),
                                    lane_index: info.index,
                                    start: c.first_seen,
                                    end: None,
                                    from: c.first_front,
                                    to: c.front,
                                    speed,
                                    min_speed: c.min_speed,
                                });
                            }
                        } else if c.event != NONE {
                            let w = &mut ph.waves[c.event as usize];
                            w.to = c.front;
                            w.speed = speed;
                            w.min_speed = c.min_speed;
                        }
                    }
                    None => {
                        // A cluster split off a queue at a stop line belongs to that queue.
                        let inherited = candidates
                            .iter()
                            .any(|c| c.anchored && r.front <= c.front + gap && r.front >= c.back - gap);
                        next.push(WaveCandidate {
                            lane,
                            first_seen: t,
                            last_seen: t,
                            first_front: r.front,
                            front: r.front,
                            back: r.back,
                            observations: 1,
                            min_speed: r.min_speed,
                            anchored: r.anchored || inherited,
                            event: NONE,
                        });
                    }
                }
            }
            for c in candidates.iter() {
                if c.last_seen == t {
                    next.push(c.clone());
                } else if c.event != NONE {
                    ph.waves[c.event as usize].end = Some(c.last_seen);
                }
            }
        }
        // New candidates were appended after the matched ones of their lane: keep lane order.
        next.sort_by_key(|c| c.lane);
        m.phenomena.candidates = next;
        self.metrics = Some(m);
    }

    /// Metrics of the run, `None` when `metrics.enabled` is false.
    pub fn metrics(&self) -> Option<&Metrics> {
        self.metrics.as_deref()
    }

    /// Stops collecting metrics for the rest of the run (benchmarks; dynamics are unaffected).
    pub fn disable_metrics(&mut self) {
        self.metrics = None;
    }

    /// Restarts the metric totals (links, junctions, queues) now, e.g. after a warm-up.
    pub fn reset_metrics(&mut self) {
        let t = self.time;
        if let Some(m) = self.metrics.as_deref_mut() {
            m.reset_totals(t);
        }
    }

    /// Finished lane-cell buckets in the run.
    pub fn lane_cell_buckets(&self) -> u64 {
        self.metrics.as_deref().map_or(0, |m| m.finished)
    }

    /// `lane-cells-v1` blob with the retained buckets whose index is ≥ `from`.
    pub fn lane_cells_since(&self, from: u64) -> Vec<u8> {
        self.metrics
            .as_deref()
            .map_or_else(Vec::new, |m| m.lane_cells_since(from))
    }

    /// `lane-cells-v1` blob with the latest finished bucket (none before the first one).
    pub fn lane_cells_latest(&self) -> Vec<u8> {
        self.lane_cells_since(self.lane_cell_buckets().saturating_sub(1))
    }

    /// Detected tailbacks and stop-and-go waves as JSON `{"tailbacks": […], "waves": […]}`.
    pub fn events_json(&self) -> String {
        let (tailbacks, waves): (&[Tailback], &[Wave]) = match self.metrics.as_deref() {
            Some(m) => (&m.phenomena.tailbacks, &m.phenomena.waves),
            None => (&[], &[]),
        };
        serde_json::to_string(&Events { tailbacks, waves }).unwrap_or_default()
    }

    fn duration(&self) -> f64 {
        self.metrics.as_deref().map_or(self.time, |m| self.time - m.since)
    }

    /// Junction metrics (#58): nodes with connectors, their approaches and movements.
    pub fn junction_metrics(&self) -> Vec<JunctionMetrics> {
        let Some(m) = self.metrics.as_deref() else {
            return Vec::new();
        };
        let hours = self.duration().max(1e-9) / 3600.0;
        let net = &self.net;
        let samples = m.queue_samples.max(1) as f64;
        let mut by_node: Vec<Vec<u32>> = vec![Vec::new(); net.nodes.len()];
        for (c, info) in net.connectors.iter().enumerate() {
            by_node[info.node as usize].push(c as u32);
        }
        let mut out = Vec::new();
        for (n, conns) in by_node.iter().enumerate() {
            if conns.is_empty() {
                continue;
            }
            let signalised = conns
                .iter()
                .any(|&c| net.connectors[c as usize].priority == Priority::Signal);
            let mut approaches: Vec<u32> = conns
                .iter()
                .map(|&c| net.connectors[c as usize].from_link)
                .collect();
            approaches.sort_unstable();
            approaches.dedup();
            let (mut count, mut wait, mut delay) = (0, 0.0, 0.0);
            let movements = conns
                .iter()
                .map(|&c| {
                    let info = &net.connectors[c as usize];
                    let t = &m.movements[c as usize];
                    count += t.count;
                    wait += t.wait;
                    delay += t.delay;
                    let mean_delay = per_vehicle(t.delay, t.count);
                    MovementMetrics {
                        connector: info.id.clone(),
                        from_link: net.links[info.from_link as usize].id.clone(),
                        to_link: net.links[info.to_link as usize].id.clone(),
                        turn: snake(format!("{:?}", info.turn)),
                        count: t.count,
                        flow: t.count as f64 / hours,
                        mean_wait: per_vehicle(t.wait, t.count),
                        mean_delay,
                        los: mean_delay.map(|d| level_of_service(d, signalised).to_string()),
                    }
                })
                .collect();
            let approaches: Vec<ApproachMetrics> = approaches
                .iter()
                .map(|&l| {
                    let t = &m.links[l as usize];
                    ApproachMetrics {
                        link: net.links[l as usize].id.clone(),
                        queue_max: t.queue_max,
                        queue_mean: t.queue_sum / samples,
                        queue_max_vehicles: t.queue_max_vehicles,
                    }
                })
                .collect();
            let mean_delay = per_vehicle(delay, count);
            out.push(JunctionMetrics {
                id: net.nodes[n].id.clone(),
                control: snake(format!("{:?}", net.nodes[n].control)),
                signalised,
                throughput: count,
                flow: count as f64 / hours,
                mean_delay,
                mean_wait: per_vehicle(wait, count),
                los: mean_delay.map(|d| level_of_service(d, signalised).to_string()),
                queue_max: approaches.iter().map(|a| a.queue_max).fold(0.0, f64::max),
                approaches,
                movements,
            });
        }
        out
    }

    pub fn junctions_json(&self) -> String {
        serde_json::to_string(&self.junction_metrics()).unwrap_or_default()
    }

    /// Run summary (#84 / frontend KPIs).
    pub fn summary(&self) -> Summary {
        let net = &self.net;
        let duration = self.duration();
        let hours = duration.max(1e-9) / 3600.0;
        let stats = self.stats();
        let (totals, samples, events) = match self.metrics.as_deref() {
            Some(m) => (
                m.link_totals(),
                m.queue_samples.max(1) as f64,
                EventCounts {
                    tailbacks: m.phenomena.tailback_count,
                    stop_and_go_waves: m.phenomena.wave_count,
                },
            ),
            None => (
                Vec::new(),
                1.0,
                EventCounts {
                    tailbacks: 0,
                    stop_and_go_waves: 0,
                },
            ),
        };
        let links: Vec<LinkMetrics> = totals
            .iter()
            .enumerate()
            .map(|(l, t)| {
                let info = &net.links[l];
                let mean_speed = (t.veh_s > 0.0).then(|| t.dist / t.veh_s);
                LinkMetrics {
                    id: info.id.clone(),
                    length: info.length,
                    lanes: info.lane_count,
                    mean_speed,
                    speed_ratio: mean_speed.map(|v| v / info.speed_limit),
                    flow: t.exits as f64 / hours,
                    density: t.veh_s / duration.max(1e-9) / (info.length / 1000.0),
                    delay: per_vehicle(t.delay_s, t.exits),
                    delay_total: t.delay_s,
                    queue_max: t.queue_max,
                    queue_mean: t.queue_sum / samples,
                    stops: t.stops,
                    travel_time: self.travel_times.smoothed[l],
                    free_flow_time: self.router.free_flow_time(l as u32),
                }
            })
            .collect();
        let veh_s: f64 = totals.iter().map(|t| t.veh_s).sum();
        let dist: f64 = totals.iter().map(|t| t.dist).sum();
        Summary {
            format_version: 1,
            time: self.time,
            duration,
            start_time_of_day: self.demand.start_time,
            network: NetworkKpis {
                spawned: stats.spawned,
                arrived: stats.arrived,
                active: stats.active,
                waiting_to_enter: stats.waiting_to_enter,
                stranded: stats.stranded,
                unroutable: stats.unroutable,
                rerouted: stats.rerouted,
                commuter_reroutes: stats.commuter_reroutes,
                lane_changes: stats.lane_changes,
                lapses: stats.lapses,
                mean_travel_time: stats.mean_travel_time,
                mean_speed: if veh_s > 0.0 { dist / veh_s } else { 0.0 },
                vehicle_km: dist / 1000.0,
                vehicle_hours: veh_s / 3600.0,
                delay_hours: totals.iter().map(|t| t.delay_s).sum::<f64>() / 3600.0,
                stops: totals.iter().map(|t| t.stops).sum(),
            },
            links,
            junctions: self.junction_metrics(),
            events,
        }
    }

    pub fn summary_json(&self) -> String {
        serde_json::to_string(&self.summary()).unwrap_or_default()
    }
}
