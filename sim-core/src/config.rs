//! Simulation configuration (JSON, camelCase, every key optional, unknown keys ignored).

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::demand::{OdEntry, TimeOfDay, TimeProfile, Zone, resolve_profile};
use crate::driver::{DriverProfilePatch, Fleet};
use crate::vehicle::VehicleTypePatch;

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

/// Reaction time and distraction (#52).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PerceptionConfig {
    /// Apply reaction times and distraction lapses (false = instantaneous perception).
    pub enabled: bool,
    /// Emergency reflex: the true state overrides perception when it demands braking harder
    /// than this multiple of the driver's comfortable deceleration.
    pub emergency_factor: f64,
}

impl Default for PerceptionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            emergency_factor: 2.0,
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
    /// Vehicle type shares (catalogue names, e.g. `car`, `truck`, `articulatedTruck`);
    /// default 100 % cars.
    pub vehicle_mix: BTreeMap<String, f64>,
    /// Relative spread of desired speed, headway and acceleration (0 to 0.5) for vehicles
    /// without a driver profile (empty `driverMix`).
    pub heterogeneity: f64,
    /// Vehicles are not inserted while this many are active (they queue at their entry).
    pub max_vehicles: u32,
    pub junction: JunctionConfig,
    pub lane_change: LaneChangeConfig,
    /// Overrides and additions to the vehicle type catalogue (#50).
    pub vehicle_types: BTreeMap<String, VehicleTypePatch>,
    /// Overrides and additions to the driver profiles (#51).
    pub driver_profiles: BTreeMap<String, DriverProfilePatch>,
    /// Driver profile shares; empty = legacy average drivers (`heterogeneity` spread).
    pub driver_mix: BTreeMap<String, f64>,
    pub perception: PerceptionConfig,
    /// Time of day at simulation time 0 (seconds or `"HH:MM"`, default 07:00).
    pub start_time: TimeOfDay,
    /// Custom time-of-day profiles (in addition to the built-in ones).
    pub time_profiles: BTreeMap<String, TimeProfile>,
    /// Time-of-day profile applied to the boundary demand (`demand` / `defaultDemand`).
    pub demand_profile: Option<String>,
    /// Demand zones for the OD matrix.
    pub zones: BTreeMap<String, Zone>,
    /// OD matrix. When present, `defaultDemand` is ignored; `demand` adds boundary traffic.
    pub od: Vec<OdEntry>,
    /// Time-of-day profile per vehicle type: its share in every mix is multiplied by the profile
    /// factor (e.g. `{"articulatedTruck": "freight"}`).
    pub vehicle_mix_profiles: BTreeMap<String, String>,
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
            vehicle_types: BTreeMap::new(),
            driver_profiles: BTreeMap::new(),
            driver_mix: BTreeMap::new(),
            perception: PerceptionConfig::default(),
            start_time: TimeOfDay::default(),
            time_profiles: BTreeMap::new(),
            demand_profile: None,
            zones: BTreeMap::new(),
            od: Vec::new(),
            vehicle_mix_profiles: BTreeMap::new(),
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
        if !(0.0..=0.5).contains(&self.heterogeneity) {
            return Err("heterogeneity must be between 0 and 0.5".into());
        }
        let fleet = self.fleet()?;
        self.validate_demand(&fleet)?;
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
            self.perception.emergency_factor,
        ];
        if !times.iter().all(|&t| rate_ok(t)) {
            return Err("junction and lane-change parameters must be finite and non-negative".into());
        }
        if self.lane_change.interval == 0 {
            return Err("laneChange.interval must be at least 1".into());
        }
        Ok(())
    }

    /// Checks profiles, zones and the OD matrix (references to the network are checked when the
    /// simulation is built).
    fn validate_demand(&self, fleet: &Fleet) -> Result<(), String> {
        for (name, p) in &self.time_profiles {
            p.validate(name)?;
        }
        if let Some(name) = &self.demand_profile {
            resolve_profile(&self.time_profiles, name)?;
        }
        for (ty, profile) in &self.vehicle_mix_profiles {
            if fleet.catalogue.index(ty).is_none() {
                return Err(format!("unknown vehicle type '{ty}' in vehicleMixProfiles"));
            }
            resolve_profile(&self.time_profiles, profile)?;
        }
        for (i, od) in self.od.iter().enumerate() {
            for zone in [&od.from, &od.to] {
                if !self.zones.contains_key(zone) {
                    return Err(format!("od[{i}] references unknown zone '{zone}'"));
                }
            }
            if !(od.vph.is_finite() && od.vph >= 0.0) {
                return Err(format!("od[{i}].vph must be finite and non-negative"));
            }
            if let Some(p) = &od.profile {
                resolve_profile(&self.time_profiles, p)?;
            }
            if let Some(mix) = &od.vehicle_mix {
                fleet.type_cdf(mix)?;
            }
            if let Some(mix) = &od.driver_mix {
                fleet.driver_cdf(mix)?;
            }
        }
        Ok(())
    }

    /// Vehicle types, driver profiles and the default mixes.
    pub fn fleet(&self) -> Result<Fleet, String> {
        Fleet::new(
            &self.vehicle_types,
            &self.driver_profiles,
            &self.vehicle_mix,
            &self.driver_mix,
            self.heterogeneity,
        )
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
            (r#"{"driverMix": {"sleepy": 1}}"#, "unknown driver profile"),
            (r#"{"vehicleTypes": {"tram": {"length": 30}}}"#, "needs a class"),
            (
                r#"{"driverProfiles": {"x": {"reactionTime": 9}}}"#,
                "invalid parameters",
            ),
            (r#"{"startTime": "25:00"}"#, "invalid time of day"),
            (r#"{"demandProfile": "rush"}"#, "unknown time profile"),
            (
                r#"{"timeProfiles": {"x": {"interval": 0, "factors": [1]}}}"#,
                "invalid",
            ),
            (
                r#"{"vehicleMixProfiles": {"tram": "flat"}}"#,
                "unknown vehicle type",
            ),
            (
                r#"{"vehicleMixProfiles": {"car": "rush"}}"#,
                "unknown time profile",
            ),
            (
                r#"{"od": [{"from": "a", "to": "b", "vph": 1}]}"#,
                "unknown zone 'a'",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": -1}]}"#,
                "non-negative",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": 1, "profile": "x"}]}"#,
                "unknown time profile",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": 1, "vehicleMix": {"tram": 1}}]}"#,
                "unknown vehicle class",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": 1, "driverMix": {"x": 1}}]}"#,
                "unknown driver profile",
            ),
        ] {
            let e = SimConfig::from_json(json).unwrap_err();
            assert!(e.contains(needle), "{json}: {e}");
        }
    }

    #[test]
    fn fleet_uses_types_profiles_and_mixes() {
        let c = SimConfig::from_json(
            r#"{"vehicleMix": {"car": 3, "minibus": 1},
                "vehicleTypes": {"minibus": {"class": "bus", "length": 7}},
                "driverMix": {"average": 1, "aggressive": 1}}"#,
        )
        .unwrap();
        let f = c.fleet().unwrap();
        assert_eq!(f.catalogue.len(), 7);
        assert_eq!(f.types.last().unwrap().1, 1.0);
        assert_eq!(f.drivers.len(), 2);
        let f = SimConfig::default().fleet().unwrap();
        assert!(f.drivers.is_empty());
        assert_eq!(f.types[0], (0, 1.0), "cars only by default");
    }
}
