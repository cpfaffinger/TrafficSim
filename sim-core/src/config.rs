//! Simulation configuration (JSON, camelCase, every key optional, unknown keys ignored).

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::vehicle::VehicleClass;

/// Gap acceptance at junctions (#45). Critical gaps are the minimum time (s) between the
/// moment the yielding vehicle reaches its stop line and the arrival of the next prioritised
/// vehicle at its own stop line.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JunctionConfig {
    pub critical_gap_minor: f64,
    pub critical_gap_stop: f64,
    pub critical_gap_roundabout: f64,
    pub critical_gap_right_before_left: f64,
    /// Permissive signalised movements (e.g. left turns during the opposing green).
    pub critical_gap_permissive: f64,
    /// Minimum time between two consecutive entries into the same yielding connector (s).
    pub follow_up_time: f64,
    /// After waiting this long (s) at an unsignalised stop line, a vehicle ignores approaching
    /// traffic and only waits for the junction to be physically clear (deadlock breaker).
    pub max_wait: f64,
}

impl Default for JunctionConfig {
    fn default() -> Self {
        Self {
            critical_gap_minor: 4.0,
            critical_gap_stop: 4.5,
            critical_gap_roundabout: 3.0,
            critical_gap_right_before_left: 3.0,
            critical_gap_permissive: 4.0,
            follow_up_time: 2.0,
            max_wait: 45.0,
        }
    }
}

/// MOBIL lane changes (#46).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaneChangeConfig {
    /// Discretionary lane changes are evaluated every `interval` steps (staggered by vehicle id).
    pub interval: u32,
    /// Keep-right bias `a_bias` (m/s²) on motorways and trunk roads.
    pub keep_right_bias: f64,
    /// Minimum time between two lane changes of one vehicle (s).
    pub cooldown: f64,
    /// Distance (m) before the end of the lane-change area over which mandatory urgency ramps up.
    pub urgency_distance: f64,
    /// Duration of the visual lateral transition (s); the model change itself is instantaneous.
    pub visual_duration: f64,
}

impl Default for LaneChangeConfig {
    fn default() -> Self {
        Self {
            interval: 5,
            keep_right_bias: 0.3,
            cooldown: 3.0,
            urgency_distance: 200.0,
            visual_duration: 2.5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimConfig {
    /// Fixed time step Δt (s), in (0, 1].
    pub time_step: f64,
    /// Arrival rate (vehicles per hour) of every entry node not listed in `demand`.
    pub default_demand: f64,
    /// Arrival rate per entry node id (vehicles per hour).
    pub demand: BTreeMap<String, f64>,
    /// Relative destination weight per exit node id (default 1).
    pub destination_weights: BTreeMap<String, f64>,
    /// Vehicle class shares (`car`, `van`, `truck`, `bus`, `motorcycle`); default 100 % cars.
    pub vehicle_mix: BTreeMap<String, f64>,
    /// Relative spread of desired speed, headway and acceleration (0 to 0.5).
    pub heterogeneity: f64,
    /// Vehicles are not inserted while this many are active (they queue at their entry).
    pub max_vehicles: u32,
    pub junction: JunctionConfig,
    pub lane_change: LaneChangeConfig,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            time_step: 0.1,
            default_demand: 300.0,
            demand: BTreeMap::new(),
            destination_weights: BTreeMap::new(),
            vehicle_mix: BTreeMap::new(),
            heterogeneity: 0.0,
            max_vehicles: 100_000,
            junction: JunctionConfig::default(),
            lane_change: LaneChangeConfig::default(),
        }
    }
}

impl SimConfig {
    /// Parses and validates a configuration; an empty string yields the defaults.
    pub fn from_json(json: &str) -> Result<Self, String> {
        let config: Self = if json.trim().is_empty() {
            Self::default()
        } else {
            serde_json::from_str(json).map_err(|e| format!("invalid simulation config JSON: {e}"))?
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !(self.time_step.is_finite() && self.time_step > 0.0 && self.time_step <= 1.0) {
            return Err("timeStep must be in (0, 1] seconds".into());
        }
        let rate_ok = |v: f64| v.is_finite() && v >= 0.0;
        if !rate_ok(self.default_demand) || !self.demand.values().all(|&v| rate_ok(v)) {
            return Err("demand values must be finite and non-negative".into());
        }
        if !self.destination_weights.values().all(|&v| rate_ok(v)) {
            return Err("destination weights must be finite and non-negative".into());
        }
        for (class, &share) in &self.vehicle_mix {
            if VehicleClass::from_name(class).is_none() {
                return Err(format!("unknown vehicle class '{class}' in vehicleMix"));
            }
            if !rate_ok(share) {
                return Err("vehicle mix shares must be finite and non-negative".into());
            }
        }
        if !self.vehicle_mix.is_empty() && self.vehicle_mix.values().sum::<f64>() <= 0.0 {
            return Err("vehicle mix shares must not all be zero".into());
        }
        if !(0.0..=0.5).contains(&self.heterogeneity) {
            return Err("heterogeneity must be between 0 and 0.5".into());
        }
        let j = &self.junction;
        let times = [
            j.critical_gap_minor,
            j.critical_gap_stop,
            j.critical_gap_roundabout,
            j.critical_gap_right_before_left,
            j.critical_gap_permissive,
            j.follow_up_time,
            j.max_wait,
            self.lane_change.keep_right_bias,
            self.lane_change.cooldown,
            self.lane_change.urgency_distance,
            self.lane_change.visual_duration,
        ];
        if !times.iter().all(|&t| rate_ok(t)) {
            return Err("junction and lane-change parameters must be finite and non-negative".into());
        }
        if self.lane_change.interval == 0 {
            return Err("laneChange.interval must be at least 1".into());
        }
        Ok(())
    }

    /// Cumulative class distribution in [`VehicleClass::ALL`] order.
    pub(crate) fn class_cdf(&self) -> [(VehicleClass, f64); 5] {
        let share = |c: VehicleClass| {
            if self.vehicle_mix.is_empty() {
                if c == VehicleClass::Car { 1.0 } else { 0.0 }
            } else {
                self.vehicle_mix
                    .iter()
                    .find(|(k, _)| VehicleClass::from_name(k) == Some(c))
                    .map_or(0.0, |(_, &v)| v)
            }
        };
        let total: f64 = VehicleClass::ALL.iter().map(|&c| share(c)).sum();
        let mut acc = 0.0;
        VehicleClass::ALL.map(|c| {
            acc += share(c) / total;
            (c, acc)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_minimal_configs_use_defaults() {
        assert_eq!(SimConfig::from_json("").unwrap(), SimConfig::default());
        assert_eq!(SimConfig::from_json("{}").unwrap(), SimConfig::default());
        let c =
            SimConfig::from_json(r#"{"timeStep": 0.05, "unknown": 1, "junction": {"maxWait": 10}}"#).unwrap();
        assert_eq!(c.time_step, 0.05);
        assert_eq!(c.junction.max_wait, 10.0);
        assert_eq!(
            c.junction.critical_gap_minor,
            JunctionConfig::default().critical_gap_minor
        );
    }

    #[test]
    fn rejects_invalid_values() {
        for (json, needle) in [
            ("{", "invalid simulation config"),
            (r#"{"timeStep": 0}"#, "timeStep"),
            (r#"{"timeStep": 2}"#, "timeStep"),
            (r#"{"demand": {"n1": -1}}"#, "demand"),
            (r#"{"defaultDemand": -1}"#, "demand"),
            (r#"{"destinationWeights": {"n1": -1}}"#, "destination"),
            (r#"{"vehicleMix": {"tram": 1}}"#, "unknown vehicle class"),
            (r#"{"vehicleMix": {"car": -1}}"#, "shares"),
            (r#"{"vehicleMix": {"car": 0}}"#, "all be zero"),
            (r#"{"heterogeneity": 0.9}"#, "heterogeneity"),
            (r#"{"junction": {"maxWait": -1}}"#, "non-negative"),
            (r#"{"laneChange": {"interval": 0}}"#, "interval"),
        ] {
            let e = SimConfig::from_json(json).unwrap_err();
            assert!(e.contains(needle), "{json}: {e}");
        }
    }

    #[test]
    fn class_distribution_is_cumulative() {
        let cdf = SimConfig::default().class_cdf();
        assert_eq!(cdf[0], (VehicleClass::Car, 1.0));
        let c = SimConfig::from_json(r#"{"vehicleMix": {"car": 3, "truck": 1}}"#).unwrap();
        let cdf = c.class_cdf();
        assert_eq!(cdf[0].1, 0.75);
        assert_eq!(cdf[1].1, 0.75);
        assert_eq!(cdf[2], (VehicleClass::Truck, 1.0));
        assert_eq!(cdf[4].1, 1.0);
    }
}
