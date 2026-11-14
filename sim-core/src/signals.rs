//! Fixed-time traffic signal controllers (network package `signals[]`).

use std::collections::BTreeMap;

use crate::package;

/// Signal aspect of one group. The discriminant is the value reported by
/// `NetworkSim::signal_states` (0 = red, 1 = amber, 2 = green).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SignalState {
    Red = 0,
    Amber = 1,
    Green = 2,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignalGroup {
    pub id: String,
    /// Index into [`SignalPlans::controllers`].
    pub controller: u32,
    /// Green intervals `[start, end)` within the cycle.
    pub green: Vec<(f64, f64)>,
    pub amber: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignalController {
    pub node: u32,
    pub cycle: f64,
    pub offset: f64,
}

/// All signal groups of a network, in package order (controllers, then groups).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SignalPlans {
    pub controllers: Vec<SignalController>,
    pub groups: Vec<SignalGroup>,
}

impl SignalPlans {
    /// Builds the plans and returns the group-id → index map. `node_index` maps node ids.
    pub fn from_package(
        signals: &[package::SignalController],
        node_index: &BTreeMap<String, u32>,
    ) -> Result<(Self, BTreeMap<String, u32>), String> {
        let mut plans = Self::default();
        let mut group_index = BTreeMap::new();
        for controller in signals {
            let node = *node_index
                .get(&controller.node)
                .ok_or_else(|| format!("signal controller references unknown node '{}'", controller.node))?;
            if !(controller.cycle.is_finite() && controller.cycle > 0.0) {
                return Err(format!(
                    "signal controller at '{}' has a non-positive cycle",
                    controller.node
                ));
            }
            let controller_idx = plans.controllers.len() as u32;
            plans.controllers.push(SignalController {
                node,
                cycle: controller.cycle,
                offset: if controller.offset.is_finite() {
                    controller.offset
                } else {
                    0.0
                },
            });
            for group in &controller.groups {
                for &[start, end] in &group.green {
                    if !(start >= 0.0 && start < end && end <= controller.cycle) {
                        return Err(format!(
                            "signal group '{}' has an invalid green interval",
                            group.id
                        ));
                    }
                }
                if !(group.amber.is_finite() && group.amber >= 0.0) {
                    return Err(format!("signal group '{}' has an invalid amber time", group.id));
                }
                let idx = plans.groups.len() as u32;
                if group_index.insert(group.id.clone(), idx).is_some() {
                    return Err(format!("duplicate signal group id '{}'", group.id));
                }
                plans.groups.push(SignalGroup {
                    id: group.id.clone(),
                    controller: controller_idx,
                    green: group.green.iter().map(|g| (g[0], g[1])).collect(),
                    amber: group.amber,
                });
            }
        }
        Ok((plans, group_index))
    }

    pub fn group_count(&self) -> usize {
        self.groups.len()
    }

    /// Aspect of `group` at simulation time `time` (s).
    pub fn state(&self, group: usize, time: f64) -> SignalState {
        let g = &self.groups[group];
        let c = &self.controllers[g.controller as usize];
        let t = (time - c.offset).rem_euclid(c.cycle);
        let mut state = SignalState::Red;
        for &(start, end) in &g.green {
            if t >= start && t < end {
                return SignalState::Green;
            }
            // Amber follows each green interval and may wrap around the cycle end.
            let since_end = (t - end).rem_euclid(c.cycle);
            if since_end < g.amber {
                state = SignalState::Amber;
            }
        }
        state
    }

    /// Writes the aspect of every group into `out` (resized to the group count).
    pub fn states_into(&self, time: f64, out: &mut Vec<SignalState>) {
        out.clear();
        out.extend((0..self.groups.len()).map(|g| self.state(g, time)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plans(offset: f64) -> SignalPlans {
        let nodes = BTreeMap::from([("n0".to_string(), 0u32)]);
        let signals = vec![package::SignalController {
            node: "n0".into(),
            cycle: 90.0,
            offset,
            groups: vec![
                package::SignalGroup {
                    id: "g0".into(),
                    green: vec![[0.0, 40.0]],
                    amber: 3.0,
                },
                package::SignalGroup {
                    id: "g1".into(),
                    green: vec![[45.0, 88.0]],
                    amber: 4.0,
                },
            ],
        }];
        let (p, index) = SignalPlans::from_package(&signals, &nodes).unwrap();
        assert_eq!(index["g1"], 1);
        p
    }

    #[test]
    fn green_amber_red_follow_the_cycle() {
        let p = plans(0.0);
        assert_eq!(p.group_count(), 2);
        assert_eq!(p.state(0, 0.0), SignalState::Green);
        assert_eq!(p.state(0, 39.9), SignalState::Green);
        assert_eq!(p.state(0, 40.0), SignalState::Amber);
        assert_eq!(p.state(0, 42.9), SignalState::Amber);
        assert_eq!(p.state(0, 43.0), SignalState::Red);
        assert_eq!(p.state(0, 89.0), SignalState::Red);
        assert_eq!(p.state(0, 90.0), SignalState::Green);
        assert_eq!(p.state(1, 44.0), SignalState::Red);
        assert_eq!(p.state(1, 50.0), SignalState::Green);
    }

    #[test]
    fn amber_wraps_around_the_cycle_end() {
        let p = plans(0.0);
        assert_eq!(p.state(1, 89.5), SignalState::Amber);
        assert_eq!(p.state(1, 91.0), SignalState::Amber);
        assert_eq!(p.state(1, 92.5), SignalState::Red);
    }

    #[test]
    fn offset_shifts_the_plan() {
        let p = plans(10.0);
        assert_eq!(p.state(0, 5.0), SignalState::Red);
        assert_eq!(p.state(0, 10.0), SignalState::Green);
        assert_eq!(p.state(0, 49.9), SignalState::Green);
        let mut out = Vec::new();
        p.states_into(20.0, &mut out);
        assert_eq!(out, vec![SignalState::Green, SignalState::Red]);
        assert_eq!(SignalState::Amber as u8, 1);
    }

    #[test]
    fn rejects_invalid_plans() {
        let nodes = BTreeMap::from([("n0".to_string(), 0u32)]);
        let base = package::SignalController {
            node: "n0".into(),
            cycle: 60.0,
            offset: 0.0,
            groups: vec![package::SignalGroup {
                id: "g".into(),
                green: vec![[0.0, 30.0]],
                amber: 3.0,
            }],
        };
        let check = |c: package::SignalController, needle: &str| {
            let err = SignalPlans::from_package(&[c], &nodes).unwrap_err();
            assert!(err.contains(needle), "{err}");
        };
        check(
            package::SignalController {
                node: "x".into(),
                ..base.clone()
            },
            "unknown node",
        );
        check(
            package::SignalController {
                cycle: 0.0,
                ..base.clone()
            },
            "cycle",
        );
        let mut bad_green = base.clone();
        bad_green.groups[0].green = vec![[30.0, 70.0]];
        check(bad_green, "green interval");
        let mut bad_amber = base.clone();
        bad_amber.groups[0].amber = -1.0;
        check(bad_amber, "amber");
        let mut duplicate = base.clone();
        duplicate.groups.push(duplicate.groups[0].clone());
        check(duplicate, "duplicate");
        let nan_offset = package::SignalController {
            offset: f64::NAN,
            ..base
        };
        let (p, _) = SignalPlans::from_package(&[nan_offset], &nodes).unwrap();
        assert_eq!(p.controllers[0].offset, 0.0);
    }
}
