//! Run metrics (#57, #58, #62): lane cells, link totals, junction movements and phenomena.
//!
//! The simulation feeds these structures from its integration step (see `sim::observe`); they
//! never influence the dynamics and are not part of the state checksum.

pub mod cells;

use std::collections::VecDeque;

use serde::Serialize;

use crate::config::MetricsConfig;
use crate::network::{NONE, Network};
use cells::{CellAccumulator, CellLayout};

/// Queue lengths are sampled at this interval (s).
pub const QUEUE_SAMPLE_INTERVAL: f64 = 1.0;
/// Expected propagation speed of stop-and-go waves (m/s, −15 km/h).
pub const WAVE_SPEED: f64 = -15.0 / 3.6;
/// Accepted propagation speeds of a confirmed wave (m/s): −30 to −5 km/h.
pub const WAVE_SPEED_RANGE: (f64, f64) = (-30.0 / 3.6, -5.0 / 3.6);
/// Observations needed to confirm a wave.
pub const WAVE_CONFIRMATIONS: u32 = 3;
/// At most this many events of each kind are stored (all are counted).
pub const MAX_EVENTS: usize = 10_000;
/// At most this many length samples are stored per tailback.
pub const MAX_TAILBACK_SAMPLES: usize = 720;

/// Totals of one link since the last metrics reset.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LinkTotals {
    /// Vehicle-seconds on the link's lanes.
    pub veh_s: f64,
    /// Vehicle-metres driven.
    pub dist: f64,
    /// Vehicle-seconds lost against the speed limit.
    pub delay_s: f64,
    /// Vehicles that left the link at its end.
    pub exits: u64,
    pub stops: u64,
    pub queue_max: f64,
    pub queue_sum: f64,
    pub queue_max_vehicles: u32,
}

/// Totals of one junction movement (connector) since the last reset.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MovementTotals {
    pub count: u64,
    /// Seconds spent below 0.5 m/s on the approach link.
    pub wait: f64,
    /// Seconds lost against the speed limit on the approach link.
    pub delay: f64,
}

/// A tailback on one lane.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tailback {
    #[serde(skip)]
    pub lane: u32,
    pub link: String,
    #[serde(rename = "lane")]
    pub lane_index: u32,
    pub start: f64,
    pub end: Option<f64>,
    /// Position of the queue head on the lane (m from the lane start).
    pub head: f64,
    /// Current (last) and maximum length (m).
    pub length: f64,
    pub max_length: f64,
    /// The queue reached the start of the lane (spill-back into the upstream junction).
    pub spillback: bool,
    /// `[time, length]` samples.
    pub samples: Vec<[f32; 2]>,
}

/// A stop-and-go wave travelling upstream on one lane.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wave {
    #[serde(skip)]
    pub lane: u32,
    pub link: String,
    #[serde(rename = "lane")]
    pub lane_index: u32,
    pub start: f64,
    pub end: Option<f64>,
    /// Front position when first seen and last seen (m from the lane start).
    pub from: f64,
    pub to: f64,
    /// Propagation speed of the front (m/s, negative = upstream).
    pub speed: f64,
    /// Lowest vehicle speed inside the wave (m/s).
    pub min_speed: f64,
}

/// A congested cluster being tracked between detections.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WaveCandidate {
    pub lane: u32,
    pub first_seen: f64,
    pub last_seen: f64,
    pub first_front: f64,
    pub front: f64,
    /// Upstream end of the cluster (m).
    pub back: f64,
    pub observations: u32,
    pub min_speed: f64,
    /// Born at (or ever touching) a stop line / lane end: a queue, not a wave.
    pub anchored: bool,
    pub event: u32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Phenomena {
    pub tailbacks: Vec<Tailback>,
    pub waves: Vec<Wave>,
    pub tailback_count: u64,
    pub wave_count: u64,
    /// Active tailback per lane (index into `tailbacks`, [`NONE`] = none).
    pub(crate) active_tailback: Vec<u32>,
    pub(crate) candidates: Vec<WaveCandidate>,
}

/// All metrics of a run.
#[derive(Debug, Clone)]
pub struct Metrics {
    pub config: MetricsConfig,
    pub layout: CellLayout,
    pub acc: CellAccumulator,
    /// Encoded bucket blocks, oldest first.
    pub blocks: VecDeque<Vec<u8>>,
    /// Finished buckets in the run (index of the next bucket).
    pub finished: u64,
    pub bucket_steps: u64,
    pub bucket_duration: f64,
    pub queue_steps: u64,
    pub detect_steps: u64,
    pub detect_interval: f64,
    pub start_time_of_day: f64,
    /// Start of the totals (time of the last reset).
    pub since: f64,
    pub links: Vec<LinkTotals>,
    pub movements: Vec<MovementTotals>,
    pub queue_samples: u64,
    pub phenomena: Phenomena,
    /// Partial bucket values at the last reset (subtracted from the totals).
    baseline: Option<Vec<LinkTotals>>,
    /// Per-link queue of the current sample: (length, vehicles).
    pub(crate) queue_scratch: Vec<(f64, u32)>,
}

impl Metrics {
    pub fn new(
        net: &Network,
        config: &MetricsConfig,
        dt: f64,
        start_time_of_day: f64,
    ) -> Result<Self, String> {
        let layout = CellLayout::new(net, config.cell_length)?;
        let steps = |s: f64| ((s / dt).round() as u64).max(1);
        let bucket_steps = steps(config.bucket_duration);
        let detect_steps = steps(config.detection_interval);
        Ok(Self {
            config: config.clone(),
            acc: CellAccumulator::new(layout.cell_count),
            layout,
            blocks: VecDeque::new(),
            finished: 0,
            bucket_steps,
            bucket_duration: bucket_steps as f64 * dt,
            queue_steps: steps(QUEUE_SAMPLE_INTERVAL),
            detect_steps,
            detect_interval: detect_steps as f64 * dt,
            start_time_of_day,
            since: 0.0,
            links: vec![LinkTotals::default(); net.links.len()],
            movements: vec![MovementTotals::default(); net.connectors.len()],
            queue_samples: 0,
            phenomena: Phenomena {
                active_tailback: vec![NONE; net.lane_count()],
                ..Phenomena::default()
            },
            baseline: None,
            queue_scratch: vec![(0.0, 0); net.links.len()],
        })
    }

    /// One vehicle-step: boundary crossings between the old and the new position and the
    /// occupancy of the new cell. `alive = false` means the vehicle left the network.
    #[inline]
    #[allow(clippy::too_many_arguments)]
    pub fn observe(
        &mut self,
        lane_count: u32,
        old: (u32, f64, f64),
        new: (u32, f64, f64),
        alive: bool,
        dt: f64,
        step: u64,
    ) {
        let (layout, acc) = (&self.layout, &mut self.acc);
        let (old_seg, old_pos, old_speed) = old;
        let (new_seg, new_pos, new_speed) = new;
        if old_seg < lane_count {
            let from = layout.cell(old_seg, old_pos);
            if alive && new_seg == old_seg {
                acc.cross(from, layout.cell(new_seg, new_pos).max(from));
            } else {
                acc.cross(from, layout.last_cell(old_seg) + 1);
            }
        }
        if !alive || new_seg >= lane_count {
            return;
        }
        let cell = layout.cell(new_seg, new_pos);
        if new_seg != old_seg {
            acc.cross(layout.first_cell(new_seg), cell);
        }
        let limit = layout.cell_limit[cell];
        acc.occupy(
            cell,
            dt,
            new_speed,
            old_speed,
            limit,
            self.config.queue_speed,
            step,
        );
    }

    /// Closes the current bucket: encodes it, adds it to the link totals and resets it.
    pub fn flush(&mut self) {
        let mut block = Vec::new();
        cells::encode_bucket(&self.layout, &self.acc, self.bucket_duration, &mut block);
        self.blocks.push_back(block);
        while self.blocks.len() > self.config.max_buckets as usize {
            self.blocks.pop_front();
        }
        self.finished += 1;
        fold(&self.layout, &self.acc, &mut self.links);
        if let Some(b) = self.baseline.take() {
            subtract(&mut self.links, &b);
        }
        self.acc.reset();
    }

    /// Link totals including the current, unfinished bucket.
    pub fn link_totals(&self) -> Vec<LinkTotals> {
        let mut links = self.links.clone();
        fold(&self.layout, &self.acc, &mut links);
        if let Some(b) = &self.baseline {
            subtract(&mut links, b);
        }
        links
    }

    /// Restarts the totals (links, movements, queues) at `time`, e.g. after a warm-up. Buckets
    /// and events are kept.
    pub fn reset_totals(&mut self, time: f64) {
        self.since = time;
        self.links.fill(LinkTotals::default());
        self.movements.fill(MovementTotals::default());
        self.queue_samples = 0;
        // The current bucket's partial values belong to the warm-up: subtract them later.
        let mut baseline = vec![LinkTotals::default(); self.links.len()];
        fold(&self.layout, &self.acc, &mut baseline);
        self.baseline = Some(baseline);
    }

    /// `lane-cells-v1` blob of the retained buckets with index ≥ `from`.
    pub fn lane_cells_since(&self, from: u64) -> Vec<u8> {
        let first_kept = self.finished - self.blocks.len() as u64;
        let skip = from.saturating_sub(first_kept).min(self.blocks.len() as u64) as usize;
        cells::encode(
            &self.layout,
            self.start_time_of_day,
            self.bucket_duration,
            first_kept + skip as u64,
            self.blocks.iter().skip(skip).map(Vec::as_slice),
        )
    }
}

/// Adds the cell values of `acc` to the per-link totals.
fn fold(layout: &CellLayout, acc: &CellAccumulator, links: &mut [LinkTotals]) {
    for e in &layout.lanes {
        let t = &mut links[e.link as usize];
        let first = e.first_cell as usize;
        let range = first..first + usize::from(e.cells);
        t.veh_s += acc.veh_s[range.clone()].iter().sum::<f64>();
        t.dist += acc.speed_s[range.clone()].iter().sum::<f64>();
        t.delay_s += acc.delay_s[range.clone()].iter().sum::<f64>();
        t.stops += acc.stops[range.clone()]
            .iter()
            .map(|&s| u64::from(s))
            .sum::<u64>();
        t.exits += u64::from(acc.flow[range.end - 1]);
    }
}

fn subtract(links: &mut [LinkTotals], baseline: &[LinkTotals]) {
    for (l, b) in links.iter_mut().zip(baseline) {
        l.veh_s -= b.veh_s;
        l.dist -= b.dist;
        l.delay_s -= b.delay_s;
        l.exits = l.exits.saturating_sub(b.exits);
        l.stops = l.stops.saturating_sub(b.stops);
    }
}

/// HCM level of service from the mean control delay (s per vehicle).
pub fn level_of_service(delay: f64, signalised: bool) -> char {
    let limits: [f64; 5] = if signalised {
        [10.0, 20.0, 35.0, 55.0, 80.0]
    } else {
        [10.0, 15.0, 25.0, 35.0, 50.0]
    };
    let grade = limits.iter().take_while(|&&l| delay > l).count();
    (b'A' + grade as u8) as char
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_of_service_follows_hcm_thresholds() {
        assert_eq!(level_of_service(5.0, true), 'A');
        assert_eq!(level_of_service(10.0, true), 'A');
        assert_eq!(level_of_service(30.0, true), 'C');
        assert_eq!(level_of_service(30.0, false), 'D');
        assert_eq!(level_of_service(90.0, true), 'F');
        assert_eq!(level_of_service(51.0, false), 'F');
    }
}
