//! Simulation configuration (JSON, camelCase, every key optional, unknown keys ignored).

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::demand::{
    EntrySpec, OdEntry, ResidentialConfig, RoadClassProfilePatch, RoadClassProfiles, TimeOfDay, TimeProfile,
    Zone, resolve_profile,
};
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

/// Re-routing of familiar drivers (commuters) on experienced travel times (#55).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReRoutingConfig {
    /// Familiar drivers route on experienced travel times (false = everybody on free flow).
    pub enabled: bool,
    /// Period (s) of the travel-time update and en-route re-routing.
    pub interval: f64,
    /// Exponential smoothing weight of a new measurement (0, 1].
    pub smoothing: f64,
    /// Minimum relative travel-time gain for switching routes en route.
    pub threshold: f64,
    /// Also re-route familiar drivers already on their way (at their next decision point).
    pub en_route: bool,
}

impl Default for ReRoutingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval: 60.0,
            smoothing: 0.3,
            threshold: 0.1,
            en_route: true,
        }
    }
}

/// Merging at on-ramps and lane drops (#81).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MergingConfig {
    /// Vehicles next to an ending lane let a merging vehicle ahead of them in (zipper).
    pub cooperation: bool,
    /// Distance before the end of the ending lane in which mergers are let in (m).
    pub cooperation_distance: f64,
    /// Strongest deceleration a cooperating driver accepts (m/s²).
    pub max_cooperative_deceleration: f64,
    /// MOBIL bias (m/s²) for moving one lane to the left away from merging traffic.
    pub courtesy_bias: f64,
}

impl Default for MergingConfig {
    fn default() -> Self {
        Self {
            cooperation: true,
            cooperation_distance: 200.0,
            max_cooperative_deceleration: 2.0,
            courtesy_bias: 0.5,
        }
    }
}

/// Which signal controllers run actuated: `true` (all), `false` (none) or a list of node ids.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum ActuatedSelection {
    All(bool),
    Nodes(Vec<String>),
}

impl Default for ActuatedSelection {
    fn default() -> Self {
        Self::All(false)
    }
}

impl ActuatedSelection {
    pub fn includes(&self, node: &str) -> bool {
        match self {
            Self::All(all) => *all,
            Self::Nodes(nodes) => nodes.iter().any(|n| n == node),
        }
    }
}

/// Vehicle-actuated signal control (#82). Fixed-time plans stay the default.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SignalControlConfig {
    pub actuated: ActuatedSelection,
    /// Minimum and maximum green time of a phase (s).
    pub min_green: f64,
    pub max_green: f64,
    /// Gap-out: a phase ends when its detectors have been empty this long (s) and another
    /// phase has a call; every detection extends the green by this unit extension.
    pub extension: f64,
    /// Detector zone length before the stop line (m).
    pub detector_length: f64,
    /// All-red clearance between phases (s).
    pub all_red: f64,
}

impl Default for SignalControlConfig {
    fn default() -> Self {
        Self {
            actuated: ActuatedSelection::default(),
            min_green: 7.0,
            max_green: 60.0,
            extension: 3.0,
            detector_length: 30.0,
            all_red: 2.0,
        }
    }
}

/// Metrics (#57, #58, #62).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MetricsConfig {
    /// Collect lane-cell, link, junction and phenomena metrics.
    pub enabled: bool,
    /// Nominal cell length (m); the last cell of a lane may be shorter.
    pub cell_length: f64,
    /// Time bucket (s), rounded to whole steps.
    pub bucket_duration: f64,
    /// Finished buckets kept in memory (oldest dropped first).
    pub max_buckets: u32,
    /// Vehicles slower than this (m/s) count as queued.
    pub queue_speed: f64,
    /// Largest gap (m) between consecutive queued / congested vehicles of one queue.
    pub jam_gap: f64,
    /// Interval (s) of queue sampling and phenomena detection.
    pub detection_interval: f64,
    /// Vehicles slower than this (m/s) count as congested for tailbacks and waves.
    pub congested_speed: f64,
    /// Shortest congested run (m) reported as a tailback.
    pub tailback_min_length: f64,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            cell_length: 10.0,
            bucket_duration: 30.0,
            max_buckets: 480,
            queue_speed: 2.0,
            jam_gap: 20.0,
            detection_interval: 5.0,
            congested_speed: 5.0,
            tailback_min_length: 50.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimConfig {
    /// Fixed time step Δt (s), in (0, 1].
    pub time_step: f64,
    /// Uniform arrival rate (vehicles per hour) of every entry node not listed in `entries` /
    /// `demand`. Absent: road-class profiles (`profiles`) decide.
    pub default_demand: Option<f64>,
    /// Arrival rate per entry node id (vehicles per hour); `entries` takes precedence.
    pub demand: BTreeMap<String, f64>,
    /// Explicit demand per entry (boundary) node id: vehicles per hour or `{vph, curve}` (#111).
    pub entries: BTreeMap<String, EntrySpec>,
    /// Entry nodes without explicit demand get `volumePerLane × lanes` of the road class of
    /// their entry link. Default: true unless an `od` matrix is given.
    pub auto_entries: Option<bool>,
    /// Road-class demand profiles (`volumePerLane`, `curve`), patching the built-ins (#111).
    pub profiles: BTreeMap<String, RoadClassProfilePatch>,
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
    pub start_time_of_day: TimeOfDay,
    /// Custom time-of-day curves (in addition to the built-in ones).
    pub curves: BTreeMap<String, TimeProfile>,
    /// Curve applied to all boundary demand (overrides the road-class / entry curves).
    pub demand_curve: Option<String>,
    /// Demand zones for the OD matrix: `{id: zone}` or `[{"id": …, …}]`.
    #[serde(deserialize_with = "crate::demand::deserialize_zones")]
    pub zones: BTreeMap<String, Zone>,
    /// Residential trip generation from residential / living-street / service links (#112).
    pub auto_zones: bool,
    pub residential: ResidentialConfig,
    /// OD matrix. When present, `defaultDemand` is ignored and `autoEntries` defaults to false.
    pub od: Vec<OdEntry>,
    /// Time-of-day curve per vehicle type: its share in every mix is multiplied by the curve
    /// factor (e.g. `{"articulatedTruck": "freight"}`).
    pub vehicle_mix_curves: BTreeMap<String, String>,
    pub re_routing: ReRoutingConfig,
    pub metrics: MetricsConfig,
    pub signal_control: SignalControlConfig,
    pub merging: MergingConfig,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            time_step: 0.1,
            default_demand: None,
            demand: BTreeMap::new(),
            entries: BTreeMap::new(),
            auto_entries: None,
            profiles: BTreeMap::new(),
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
            start_time_of_day: TimeOfDay::default(),
            curves: BTreeMap::new(),
            demand_curve: None,
            zones: BTreeMap::new(),
            auto_zones: false,
            residential: ResidentialConfig::default(),
            od: Vec::new(),
            vehicle_mix_curves: BTreeMap::new(),
            re_routing: ReRoutingConfig::default(),
            metrics: MetricsConfig::default(),
            signal_control: SignalControlConfig::default(),
            merging: MergingConfig::default(),
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
        if !self.default_demand.is_none_or(rate_ok)
            || !self.demand.values().all(|&v| rate_ok(v))
            || !self.entries.values().all(|e| rate_ok(e.vph()))
        {
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
            self.merging.cooperation_distance,
            self.merging.max_cooperative_deceleration,
            self.merging.courtesy_bias,
        ];
        if !times.iter().all(|&t| rate_ok(t)) {
            return Err("junction and lane-change parameters must be finite and non-negative".into());
        }
        if self.lane_change.interval == 0 {
            return Err("laneChange.interval must be at least 1".into());
        }
        let r = &self.re_routing;
        if !(r.interval.is_finite() && r.interval >= self.time_step)
            || !(r.smoothing > 0.0 && r.smoothing <= 1.0)
            || !(r.threshold.is_finite() && (0.0..1.0).contains(&r.threshold))
        {
            return Err(
                "reRouting needs interval ≥ timeStep, smoothing in (0, 1], threshold in [0, 1)".into(),
            );
        }
        let m = &self.metrics;
        let positive = [
            m.cell_length,
            m.bucket_duration,
            m.queue_speed,
            m.jam_gap,
            m.detection_interval,
            m.congested_speed,
        ];
        if !positive.iter().all(|v| v.is_finite() && *v > 0.0)
            || m.cell_length < 1.0
            || m.bucket_duration < self.time_step
            || m.detection_interval < self.time_step
            || m.max_buckets == 0
            || !(m.tailback_min_length.is_finite() && m.tailback_min_length >= 0.0)
        {
            return Err(
                "metrics need cellLength ≥ 1 m, bucketDuration and detectionInterval ≥ timeStep, \
                 maxBuckets ≥ 1 and positive speeds and gaps"
                    .into(),
            );
        }
        let s = &self.signal_control;
        let finite = [
            s.min_green,
            s.max_green,
            s.extension,
            s.detector_length,
            s.all_red,
        ];
        if !finite.iter().all(|v| v.is_finite() && *v >= 0.0)
            || s.min_green > s.max_green
            || s.max_green <= 0.0
        {
            return Err("signalControl needs non-negative times with 0 < minGreen ≤ maxGreen".into());
        }
        Ok(())
    }

    /// Checks profiles, zones and the OD matrix (references to the network are checked when the
    /// simulation is built).
    fn validate_demand(&self, fleet: &Fleet) -> Result<(), String> {
        for (name, p) in &self.curves {
            p.validate(name)?;
        }
        let curve = |name: &str| resolve_profile(&self.curves, name).map(|_| ());
        if let Some(name) = &self.demand_curve {
            curve(name)?;
        }
        for e in self.entries.values() {
            if let Some(c) = e.curve() {
                curve(c)?;
            }
        }
        for p in RoadClassProfiles::with_overrides(&self.profiles)?.iter() {
            curve(&p.curve)?;
        }
        self.residential.validate()?;
        curve(&self.residential.outbound_curve)?;
        curve(&self.residential.inbound_curve)?;
        for (ty, c) in &self.vehicle_mix_curves {
            if fleet.catalogue.index(ty).is_none() {
                return Err(format!("unknown vehicle type '{ty}' in vehicleMixCurves"));
            }
            curve(c)?;
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
            if let Some(p) = &od.curve {
                curve(p)?;
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
            (r#"{"startTimeOfDay": "25:00"}"#, "invalid time of day"),
            (r#"{"demandCurve": "rush"}"#, "unknown curve"),
            (r#"{"curves": {"x": {"interval": 0, "factors": [1]}}}"#, "invalid"),
            (
                r#"{"vehicleMixCurves": {"tram": "flat"}}"#,
                "unknown vehicle type",
            ),
            (r#"{"vehicleMixCurves": {"car": "rush"}}"#, "unknown curve"),
            (
                r#"{"od": [{"from": "a", "to": "b", "vph": 1}]}"#,
                "unknown zone 'a'",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": -1}]}"#,
                "non-negative",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": 1, "curve": "x"}]}"#,
                "unknown curve",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": 1, "vehicleMix": {"tram": 1}}]}"#,
                "unknown vehicle class",
            ),
            (
                r#"{"zones": {"a": {}}, "od": [{"from": "a", "to": "a", "vph": 1, "driverMix": {"x": 1}}]}"#,
                "unknown driver profile",
            ),
            (r#"{"reRouting": {"interval": 0}}"#, "reRouting"),
            (r#"{"reRouting": {"smoothing": 0}}"#, "reRouting"),
            (r#"{"reRouting": {"threshold": 1}}"#, "reRouting"),
            (r#"{"metrics": {"cellLength": 0.5}}"#, "metrics"),
            (r#"{"metrics": {"bucketDuration": 0.01}}"#, "metrics"),
            (r#"{"metrics": {"maxBuckets": 0}}"#, "metrics"),
            (r#"{"metrics": {"queueSpeed": -1}}"#, "metrics"),
            (r#"{"metrics": {"tailbackMinLength": -1}}"#, "metrics"),
            (r#"{"signalControl": {"minGreen": 70}}"#, "signalControl"),
            (r#"{"signalControl": {"extension": -1}}"#, "signalControl"),
            (
                r#"{"signalControl": {"actuated": 3}}"#,
                "invalid simulation config",
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
