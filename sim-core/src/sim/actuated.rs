//! Vehicle-actuated signal control (#82).
//!
//! Phases come from the fixed-time plan: signal groups ordered by the start of their first green
//! interval, groups with identical green intervals forming one phase. Every group has a presence
//! detector covering the last `detectorLength` metres of the lanes feeding its connectors. A
//! phase keeps green for at least `minGreen`; it ends when another phase has a call (a vehicle
//! on its detectors) and either its own detectors have been empty for `extension` seconds
//! (gap-out) or it has been green for `maxGreen` (max-out). Without a conflicting call the
//! phase rests in green. Amber uses the groups' amber time, followed by `allRed`. The next
//! phase is the next one in plan order with a call.

use super::Simulation;
use crate::network::{NONE, Network};
use crate::signals::SignalState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Green,
    Amber,
    AllRed,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Controller {
    /// Groups per phase.
    phases: Vec<Vec<u32>>,
    /// Detector lanes per phase.
    detectors: Vec<Vec<u32>>,
    amber: Vec<f64>,
    pub phase: usize,
    stage: Stage,
    pub since: f64,
    last_detection: f64,
    /// Calls per phase in the current step (reused buffer).
    calls: Vec<bool>,
    /// Completed phases (for statistics).
    pub switches: u64,
    pub gap_outs: u64,
    pub max_outs: u64,
}

impl Controller {
    /// Actuated controllers for the selected nodes; `node_selected(node id)`.
    pub(super) fn build(net: &Network, selected: impl Fn(&str) -> bool) -> Vec<Self> {
        let plans = &net.signals;
        let mut out = Vec::new();
        for (ci, c) in plans.controllers.iter().enumerate() {
            if !selected(&net.nodes[c.node as usize].id) {
                continue;
            }
            let mut groups: Vec<u32> = (0..plans.groups.len() as u32)
                .filter(|&g| {
                    plans.groups[g as usize].controller == ci as u32
                        && !plans.groups[g as usize].green.is_empty()
                })
                .collect();
            groups.sort_by(|&a, &b| {
                let (ga, gb) = (&plans.groups[a as usize], &plans.groups[b as usize]);
                ga.green[0].0.total_cmp(&gb.green[0].0).then(a.cmp(&b))
            });
            let mut phases: Vec<Vec<u32>> = Vec::new();
            for g in groups {
                let green = &plans.groups[g as usize].green;
                match phases
                    .iter_mut()
                    .find(|p| plans.groups[p[0] as usize].green == *green)
                {
                    Some(p) => p.push(g),
                    None => phases.push(vec![g]),
                }
            }
            if phases.is_empty() {
                continue;
            }
            let detectors = phases
                .iter()
                .map(|p| {
                    let mut lanes: Vec<u32> = net
                        .connectors
                        .iter()
                        .filter(|k| k.signal_group != NONE && p.contains(&k.signal_group))
                        .map(|k| k.from_lane)
                        .collect();
                    lanes.sort_unstable();
                    lanes.dedup();
                    lanes
                })
                .collect();
            let amber = phases
                .iter()
                .map(|p| {
                    p.iter()
                        .map(|&g| plans.groups[g as usize].amber)
                        .fold(0.0, f64::max)
                })
                .collect();
            out.push(Self {
                calls: vec![false; phases.len()],
                phases,
                detectors,
                amber,
                phase: 0,
                stage: Stage::Green,
                since: 0.0,
                last_detection: 0.0,
                switches: 0,
                gap_outs: 0,
                max_outs: 0,
            });
        }
        out
    }

    /// Aspect of every group of this controller.
    pub(super) fn write_states(&self, out: &mut [SignalState]) {
        for (k, phase) in self.phases.iter().enumerate() {
            let state = match (k == self.phase, self.stage) {
                (true, Stage::Green) => SignalState::Green,
                (true, Stage::Amber) => SignalState::Amber,
                _ => SignalState::Red,
            };
            for &g in phase {
                out[g as usize] = state;
            }
        }
    }
}

impl Simulation {
    /// Whether a vehicle is within `length` metres of the end of `lane`.
    fn detector_occupied(&self, lane: u32, length: f64) -> bool {
        self.seg_vehicles[lane as usize]
            .first()
            .is_some_and(|&j| self.vehicles[j as usize].pos >= self.net.seg_length[lane as usize] - length)
    }

    /// Advances the actuated controllers and overwrites their groups' aspects.
    pub(super) fn update_actuated(&mut self) {
        if self.actuated.is_empty() {
            return;
        }
        let (min_green, max_green, extension, length, all_red) = {
            let s = &self.config.signal_control;
            (
                s.min_green,
                s.max_green,
                s.extension,
                s.detector_length,
                s.all_red,
            )
        };
        let t = self.time;
        let mut controllers = std::mem::take(&mut self.actuated);
        for c in &mut controllers {
            for (call, lanes) in c.calls.iter_mut().zip(&c.detectors) {
                *call = lanes.iter().any(|&l| self.detector_occupied(l, length));
            }
            let calls = &c.calls;
            let elapsed = t - c.since;
            match c.stage {
                Stage::Green => {
                    if calls[c.phase] {
                        c.last_detection = t;
                    }
                    let conflicting = calls.iter().enumerate().any(|(k, &x)| x && k != c.phase);
                    let gap_out = t - c.last_detection >= extension;
                    let max_out = elapsed >= max_green;
                    if conflicting && elapsed >= min_green && (gap_out || max_out) {
                        if gap_out {
                            c.gap_outs += 1;
                        } else {
                            c.max_outs += 1;
                        }
                        c.stage = Stage::Amber;
                        c.since = t;
                    }
                }
                Stage::Amber if elapsed >= c.amber[c.phase] => {
                    c.stage = Stage::AllRed;
                    c.since = t;
                }
                Stage::AllRed if elapsed >= all_red => {
                    let n = c.phases.len();
                    c.phase = (1..=n)
                        .map(|k| (c.phase + k) % n)
                        .find(|&k| calls[k])
                        .unwrap_or((c.phase + 1) % n);
                    c.stage = Stage::Green;
                    c.since = t;
                    c.last_detection = t;
                    c.switches += 1;
                }
                _ => {}
            }
            c.write_states(&mut self.signal_state);
        }
        self.actuated = controllers;
    }
}
