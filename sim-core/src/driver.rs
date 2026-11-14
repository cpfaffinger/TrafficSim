//! Driver profiles with parameter distributions (#51) and the fleet sampler that combines vehicle
//! types (#50) and drivers into per-vehicle [`VehicleParams`].
//!
//! A profile describes a *population* of drivers: every parameter is a truncated normal
//! distribution ([`Dist`]), sampled once per vehicle from the source's own random stream. Factors
//! scale the vehicle type's values (a truck driven aggressively still accelerates like a truck).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::detmath;
use crate::rng::Pcg32;
use crate::vehicle::{VehicleCatalogue, VehicleParams, VehicleTypePatch};

/// Truncated normal distribution `N(mean, sd)` clamped to `[min, max]`. In JSON either a plain
/// number (constant) or `{"mean": m, "sd": s, "min": a, "max": b}` (`sd`, `min`, `max` optional).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(from = "DistRepr")]
pub struct Dist {
    pub mean: f64,
    pub sd: f64,
    pub min: f64,
    pub max: f64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum DistRepr {
    Constant(f64),
    #[serde(rename_all = "camelCase")]
    Normal {
        mean: f64,
        #[serde(default)]
        sd: f64,
        min: Option<f64>,
        max: Option<f64>,
    },
}

impl From<DistRepr> for Dist {
    fn from(r: DistRepr) -> Self {
        match r {
            DistRepr::Constant(v) => Self::constant(v),
            DistRepr::Normal { mean, sd, min, max } => Self {
                mean,
                sd,
                min: min.unwrap_or(f64::NEG_INFINITY),
                max: max.unwrap_or(f64::INFINITY),
            },
        }
    }
}

/// Standard normal deviate (Marsaglia's polar method; basic operations and `detmath::ln` only,
/// so the result is identical on every platform).
pub fn standard_normal(rng: &mut Pcg32) -> f64 {
    loop {
        let u = 2.0 * rng.next_f64() - 1.0;
        let v = 2.0 * rng.next_f64() - 1.0;
        let s = u * u + v * v;
        if s > 0.0 && s < 1.0 {
            return u * (-2.0 * detmath::ln(s) / s).sqrt();
        }
    }
}

impl Dist {
    pub const fn constant(v: f64) -> Self {
        Self {
            mean: v,
            sd: 0.0,
            min: v,
            max: v,
        }
    }

    pub const fn normal(mean: f64, sd: f64, min: f64, max: f64) -> Self {
        Self { mean, sd, min, max }
    }

    /// Draws a value; a constant (`sd = 0`) draws no random numbers.
    pub fn sample(&self, rng: &mut Pcg32) -> f64 {
        let x = if self.sd > 0.0 {
            self.mean + self.sd * standard_normal(rng)
        } else {
            self.mean
        };
        x.clamp(self.min, self.max)
    }

    /// Restricts the bounds to `[low, high]`; false if the distribution is invalid or its
    /// bounds do not overlap that range.
    fn restrict(&mut self, low: f64, high: f64) -> bool {
        let ok = self.mean.is_finite()
            && self.sd.is_finite()
            && self.sd >= 0.0
            && self.min <= self.max
            && self.min.max(low) <= self.max.min(high);
        if ok {
            self.min = self.min.max(low);
            self.max = self.max.min(high);
        }
        ok
    }
}

/// Driver population (all factors relative to the vehicle type's values).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverProfile {
    /// Desired speed as a factor of the speed limit.
    pub speed_factor: Dist,
    /// Factor on the IDM time headway `T`.
    pub time_headway: Dist,
    /// Factor on the IDM maximum acceleration `a`.
    pub acceleration: Dist,
    /// Factor on the IDM comfortable deceleration `b`.
    pub deceleration: Dist,
    /// Factor on the IDM standstill gap `s0`.
    pub minimum_gap: Dist,
    /// Factor on the MOBIL politeness (result clamped to [0, 1]).
    pub politeness: Dist,
    /// Perception delay (s), 0 to 2.5.
    pub reaction_time: Dist,
    /// Factor on the junction critical gaps.
    pub gap_acceptance: Dist,
    /// MOBIL switching threshold (m/s²).
    pub lane_change_threshold: Dist,
    /// Distraction lapses per hour of driving.
    pub lapse_rate: f64,
    /// Duration of a lapse (s).
    pub lapse_duration: Dist,
    /// Probability that a driver knows the network (commuter, re-routes on experienced travel
    /// times, #55).
    pub familiarity: f64,
}

/// Partial profile (`driverProfiles` in the configuration); new profiles start from `average`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverProfilePatch {
    pub speed_factor: Option<Dist>,
    pub time_headway: Option<Dist>,
    pub acceleration: Option<Dist>,
    pub deceleration: Option<Dist>,
    pub minimum_gap: Option<Dist>,
    pub politeness: Option<Dist>,
    pub reaction_time: Option<Dist>,
    pub gap_acceptance: Option<Dist>,
    pub lane_change_threshold: Option<Dist>,
    pub lapse_rate: Option<f64>,
    pub lapse_duration: Option<Dist>,
    pub familiarity: Option<f64>,
}

/// Longest supported reaction time (s); bounded by the perception history length.
pub const MAX_REACTION_TIME: f64 = 2.5;

/// Names of the built-in profiles, in order.
pub const BUILTIN_PROFILES: [&str; 5] = ["attentive", "average", "distracted", "aggressive", "commuter"];

impl DriverProfile {
    pub fn builtin(name: &str) -> Option<Self> {
        let n = Dist::normal;
        let average = Self {
            speed_factor: n(1.0, 0.08, 0.8, 1.2),
            time_headway: n(1.0, 0.1, 0.7, 1.4),
            acceleration: n(1.0, 0.1, 0.7, 1.3),
            deceleration: n(1.0, 0.1, 0.7, 1.3),
            minimum_gap: n(1.0, 0.1, 0.7, 1.3),
            politeness: n(1.0, 0.3, 0.2, 2.0),
            reaction_time: n(0.8, 0.15, 0.5, 1.3),
            gap_acceptance: n(1.0, 0.1, 0.75, 1.3),
            lane_change_threshold: n(0.2, 0.05, 0.05, 0.4),
            lapse_rate: 2.0,
            lapse_duration: n(1.0, 0.3, 0.5, 2.0),
            familiarity: 0.0,
        };
        Some(match name {
            "average" => average,
            "attentive" => Self {
                speed_factor: n(1.0, 0.05, 0.85, 1.15),
                time_headway: n(1.15, 0.1, 0.9, 1.5),
                minimum_gap: n(1.1, 0.1, 0.8, 1.4),
                politeness: n(1.5, 0.3, 0.8, 2.5),
                reaction_time: n(0.6, 0.1, 0.4, 0.9),
                gap_acceptance: n(1.05, 0.1, 0.85, 1.3),
                lapse_rate: 0.0,
                ..average
            },
            "distracted" => Self {
                speed_factor: n(0.97, 0.08, 0.8, 1.15),
                time_headway: n(1.1, 0.15, 0.8, 1.6),
                acceleration: n(0.9, 0.1, 0.6, 1.2),
                politeness: n(0.8, 0.3, 0.0, 1.5),
                reaction_time: n(1.2, 0.2, 0.8, 1.8),
                gap_acceptance: n(1.1, 0.15, 0.8, 1.5),
                lapse_rate: 30.0,
                lapse_duration: n(1.5, 0.5, 0.5, 2.5),
                ..average
            },
            "aggressive" => Self {
                speed_factor: n(1.12, 0.06, 1.0, 1.3),
                time_headway: n(0.7, 0.1, 0.5, 1.0),
                acceleration: n(1.3, 0.1, 1.0, 1.6),
                deceleration: n(1.2, 0.1, 0.9, 1.5),
                minimum_gap: n(0.8, 0.1, 0.5, 1.0),
                politeness: n(0.2, 0.1, 0.0, 0.5),
                reaction_time: n(0.7, 0.1, 0.4, 1.0),
                gap_acceptance: n(0.8, 0.1, 0.6, 1.0),
                lane_change_threshold: n(0.1, 0.03, 0.02, 0.2),
                lapse_rate: 0.0,
                ..average
            },
            "commuter" => Self {
                speed_factor: n(1.05, 0.05, 0.9, 1.2),
                time_headway: n(0.9, 0.1, 0.6, 1.2),
                acceleration: n(1.05, 0.1, 0.8, 1.3),
                reaction_time: n(0.7, 0.1, 0.5, 1.0),
                gap_acceptance: n(0.9, 0.1, 0.7, 1.1),
                lapse_rate: 1.0,
                familiarity: 1.0,
                ..average
            },
            _ => return None,
        })
    }

    fn apply(&mut self, p: &DriverProfilePatch) {
        let set = |dst: &mut Dist, v: Option<Dist>| {
            if let Some(v) = v {
                *dst = v;
            }
        };
        set(&mut self.speed_factor, p.speed_factor);
        set(&mut self.time_headway, p.time_headway);
        set(&mut self.acceleration, p.acceleration);
        set(&mut self.deceleration, p.deceleration);
        set(&mut self.minimum_gap, p.minimum_gap);
        set(&mut self.politeness, p.politeness);
        set(&mut self.reaction_time, p.reaction_time);
        set(&mut self.gap_acceptance, p.gap_acceptance);
        set(&mut self.lane_change_threshold, p.lane_change_threshold);
        set(&mut self.lapse_duration, p.lapse_duration);
        if let Some(v) = p.lapse_rate {
            self.lapse_rate = v;
        }
        if let Some(v) = p.familiarity {
            self.familiarity = v;
        }
    }

    /// Checks the profile and restricts every distribution to its physically sensible range.
    fn validate(&mut self, name: &str) -> Result<(), String> {
        let ok = self.speed_factor.restrict(0.1, 3.0)
            & self.time_headway.restrict(0.05, 10.0)
            & self.acceleration.restrict(0.05, 10.0)
            & self.deceleration.restrict(0.05, 10.0)
            & self.minimum_gap.restrict(0.05, 10.0)
            & self.politeness.restrict(0.0, 100.0)
            & self.reaction_time.restrict(0.0, MAX_REACTION_TIME)
            & self.gap_acceptance.restrict(0.1, 10.0)
            & self.lane_change_threshold.restrict(0.0, 10.0)
            & self.lapse_duration.restrict(0.0, MAX_REACTION_TIME)
            && self.lapse_rate.is_finite()
            && (0.0..=3600.0).contains(&self.lapse_rate)
            && (0.0..=1.0).contains(&self.familiarity);
        if ok {
            Ok(())
        } else {
            Err(format!("driver profile '{name}' has invalid parameters"))
        }
    }

    /// Applies this profile to the average-driver parameters `p` of a vehicle type.
    pub fn apply_to(&self, p: &mut VehicleParams, rng: &mut Pcg32) {
        p.speed_factor = self.speed_factor.sample(rng);
        p.time_headway *= self.time_headway.sample(rng);
        p.max_acceleration *= self.acceleration.sample(rng);
        p.comfortable_deceleration *= self.deceleration.sample(rng);
        p.minimum_gap *= self.minimum_gap.sample(rng);
        p.politeness = (p.politeness * self.politeness.sample(rng)).clamp(0.0, 1.0);
        p.reaction_time = self.reaction_time.sample(rng).clamp(0.0, MAX_REACTION_TIME);
        p.gap_acceptance_factor *= self.gap_acceptance.sample(rng);
        p.lane_change_threshold = self.lane_change_threshold.sample(rng).max(0.0);
        p.lapse_rate = self.lapse_rate / 3600.0;
        p.lapse_duration = if p.lapse_rate > 0.0 {
            self.lapse_duration.sample(rng).clamp(0.0, MAX_REACTION_TIME)
        } else {
            0.0
        };
        p.familiar = self.familiarity >= 1.0 || (self.familiarity > 0.0 && rng.next_f64() < self.familiarity);
    }
}

/// Built-in profiles followed by custom ones (sorted by name).
#[derive(Debug, Clone, PartialEq)]
pub struct DriverProfiles {
    list: Vec<(String, DriverProfile)>,
}

impl DriverProfiles {
    pub fn builtin() -> Self {
        Self {
            list: BUILTIN_PROFILES
                .iter()
                .filter_map(|&n| DriverProfile::builtin(n).map(|p| (n.to_string(), p)))
                .collect(),
        }
    }

    pub fn with_overrides(patches: &BTreeMap<String, DriverProfilePatch>) -> Result<Self, String> {
        let mut all = Self::builtin();
        for (name, patch) in patches {
            match all.index(name) {
                Some(i) => all.list[i as usize].1.apply(patch),
                None => {
                    let mut p = DriverProfile::builtin("average").unwrap_or_else(|| unreachable!());
                    p.apply(patch);
                    all.list.push((name.clone(), p));
                }
            }
        }
        if all.list.len() >= usize::from(crate::vehicle::NO_PROFILE) {
            return Err("too many driver profiles".into());
        }
        for (name, p) in &mut all.list {
            p.validate(name)?;
        }
        Ok(all)
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn index(&self, name: &str) -> Option<u8> {
        self.list.iter().position(|(n, _)| n == name).map(|i| i as u8)
    }

    pub fn get(&self, index: u8) -> &DriverProfile {
        &self.list[index as usize].1
    }

    pub fn name(&self, index: u8) -> &str {
        &self.list[index as usize].0
    }

    /// All profiles as a JSON object `{name: profile}`.
    pub fn to_json(&self) -> String {
        let map: BTreeMap<&str, &DriverProfile> = self.list.iter().map(|(n, p)| (n.as_str(), p)).collect();
        serde_json::to_string(&map).unwrap_or_default()
    }
}

/// Cumulative distribution over catalogue indices.
pub type Cdf<T> = Vec<(T, f64)>;

fn cdf<T: Copy>(entries: &[(T, f64)]) -> Cdf<T> {
    let total: f64 = entries.iter().map(|e| e.1).sum();
    let mut acc = 0.0;
    entries
        .iter()
        .map(|&(t, w)| {
            acc += w / total;
            (t, acc)
        })
        .collect()
}

fn pick<T: Copy>(cdf: &[(T, f64)], u: f64) -> Option<T> {
    cdf.iter()
        .find(|(_, cum)| u < *cum)
        .or_else(|| cdf.iter().rev().find(|(_, c)| *c > 0.0))
        .map(|(t, _)| *t)
}

fn check_shares(mix: &BTreeMap<String, f64>, what: &str) -> Result<(), String> {
    if !mix.values().all(|v| v.is_finite() && *v >= 0.0) {
        return Err(format!("{what} shares must be finite and non-negative"));
    }
    if !mix.is_empty() && mix.values().sum::<f64>() <= 0.0 {
        return Err(format!("{what} shares must not all be zero"));
    }
    Ok(())
}

/// Vehicle types, driver profiles and the default mixes of a simulation.
#[derive(Debug, Clone, PartialEq)]
pub struct Fleet {
    pub catalogue: VehicleCatalogue,
    pub profiles: DriverProfiles,
    heterogeneity: f64,
    /// Default type distribution (`vehicleMix`).
    pub types: Cdf<u16>,
    /// Default driver distribution (`driverMix`); empty = legacy sampling.
    pub drivers: Cdf<u8>,
}

impl Fleet {
    pub fn new(
        vehicle_types: &BTreeMap<String, VehicleTypePatch>,
        driver_profiles: &BTreeMap<String, DriverProfilePatch>,
        vehicle_mix: &BTreeMap<String, f64>,
        driver_mix: &BTreeMap<String, f64>,
        heterogeneity: f64,
    ) -> Result<Self, String> {
        let mut fleet = Self {
            catalogue: VehicleCatalogue::with_overrides(vehicle_types)?,
            profiles: DriverProfiles::with_overrides(driver_profiles)?,
            heterogeneity,
            types: Vec::new(),
            drivers: Vec::new(),
        };
        fleet.types = fleet.type_cdf(vehicle_mix)?;
        fleet.drivers = fleet.driver_cdf(driver_mix)?;
        Ok(fleet)
    }

    /// Type distribution of a mix (`{type name: share}`); empty = cars only.
    pub fn type_cdf(&self, mix: &BTreeMap<String, f64>) -> Result<Cdf<u16>, String> {
        Ok(cdf(&self.type_weights(mix)?))
    }

    /// Weights of a mix per catalogue type (catalogue order); empty = cars only.
    pub fn type_weights(&self, mix: &BTreeMap<String, f64>) -> Result<Vec<(u16, f64)>, String> {
        check_shares(mix, "vehicle mix")?;
        for name in mix.keys() {
            if self.catalogue.index(name).is_none() {
                return Err(format!("unknown vehicle class or type '{name}' in a vehicle mix"));
            }
        }
        Ok(self
            .catalogue
            .iter()
            .enumerate()
            .map(|(i, (name, _))| {
                let w = if mix.is_empty() {
                    if name == "car" { 1.0 } else { 0.0 }
                } else {
                    mix.get(name).copied().unwrap_or(0.0)
                };
                (i as u16, w)
            })
            .collect())
    }

    /// Cumulative distribution of arbitrary weights (all zero gives an empty distribution).
    pub fn cdf_of<T: Copy>(weights: &[(T, f64)]) -> Cdf<T> {
        if weights.iter().map(|w| w.1).sum::<f64>() > 0.0 {
            cdf(weights)
        } else {
            Vec::new()
        }
    }

    /// Driver distribution of a mix (`{profile name: share}`); empty = legacy sampling.
    pub fn driver_cdf(&self, mix: &BTreeMap<String, f64>) -> Result<Cdf<u8>, String> {
        check_shares(mix, "driver mix")?;
        let mut entries = Vec::with_capacity(mix.len());
        for (name, &w) in mix {
            let i = self
                .profiles
                .index(name)
                .ok_or_else(|| format!("unknown driver profile '{name}' in a driver mix"))?;
            entries.push((i, w));
        }
        entries.sort_unstable_by_key(|e| e.0);
        Ok(cdf(&entries))
    }

    /// Draws a vehicle: type from `types`, then (if `drivers` is not empty) a profile and its
    /// parameters, otherwise the legacy average driver with the `heterogeneity` spread.
    pub fn sample(&self, types: &[(u16, f64)], drivers: &[(u8, f64)], rng: &mut Pcg32) -> VehicleParams {
        let t = pick(types, rng.next_f64()).unwrap_or(0);
        let mut p = self.catalogue.get(t).params();
        p.vehicle_type = t;
        match pick(drivers, if drivers.is_empty() { 0.0 } else { rng.next_f64() }) {
            Some(d) => {
                p.driver_profile = d;
                self.profiles.get(d).apply_to(&mut p, rng);
            }
            None => {
                p.reaction_time = 0.8;
                p.spread(self.heterogeneity, rng);
            }
        }
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vehicle::VehicleClass;

    fn fleet(types: &str, profiles: &str, vmix: &str, dmix: &str) -> Result<Fleet, String> {
        Fleet::new(
            &serde_json::from_str(types).unwrap(),
            &serde_json::from_str(profiles).unwrap(),
            &serde_json::from_str(vmix).unwrap(),
            &serde_json::from_str(dmix).unwrap(),
            0.0,
        )
    }

    #[test]
    fn dist_parses_constants_and_normals() {
        let d: Dist = serde_json::from_str("1.5").unwrap();
        assert_eq!(d, Dist::constant(1.5));
        let d: Dist = serde_json::from_str(r#"{"mean": 1, "sd": 0.2, "min": 0.5}"#).unwrap();
        assert_eq!((d.mean, d.sd, d.min, d.max), (1.0, 0.2, 0.5, f64::INFINITY));
        let d: Dist = serde_json::from_str(r#"{"mean": 2}"#).unwrap();
        assert_eq!(d.sd, 0.0);
        assert!(serde_json::from_str::<Dist>(r#""x""#).is_err());
        assert_eq!(
            serde_json::to_string(&Dist::constant(1.0)).unwrap(),
            r#"{"mean":1.0,"sd":0.0,"min":1.0,"max":1.0}"#
        );
    }

    #[test]
    fn normal_samples_have_the_requested_moments_and_bounds() {
        let mut rng = Pcg32::new(3, 3);
        let d = Dist::normal(1.0, 0.1, 0.8, 1.15);
        let n = 20_000;
        let xs: Vec<f64> = (0..n).map(|_| d.sample(&mut rng)).collect();
        assert!(xs.iter().all(|x| (0.8..=1.15).contains(x)));
        let mean = xs.iter().sum::<f64>() / n as f64;
        assert!((mean - 0.995).abs() < 0.01, "mean {mean}");
        let z: Vec<f64> = (0..n).map(|_| standard_normal(&mut rng)).collect();
        let m = z.iter().sum::<f64>() / n as f64;
        let var = z.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / n as f64;
        assert!(m.abs() < 0.03 && (var - 1.0).abs() < 0.05, "{m} {var}");
        let before = rng.clone();
        assert_eq!(Dist::constant(2.0).sample(&mut rng), 2.0);
        assert_eq!(rng, before, "constants draw nothing");
    }

    #[test]
    fn builtin_profiles_are_valid_and_ordered() {
        let p = DriverProfiles::builtin();
        assert_eq!(p.len(), 5);
        assert!(!p.is_empty());
        for (i, name) in BUILTIN_PROFILES.iter().enumerate() {
            assert_eq!(p.index(name), Some(i as u8));
            assert_eq!(p.name(i as u8), *name);
            let mut copy = *p.get(i as u8);
            copy.validate(name).unwrap();
            assert_eq!(&copy, p.get(i as u8), "built-in bounds are already within range");
        }
        assert!(DriverProfile::builtin("nobody").is_none());
        let aggressive = p.get(p.index("aggressive").unwrap());
        let attentive = p.get(p.index("attentive").unwrap());
        assert!(aggressive.time_headway.mean < attentive.time_headway.mean);
        assert!(p.get(p.index("distracted").unwrap()).lapse_rate > 0.0);
        assert_eq!(p.get(p.index("commuter").unwrap()).familiarity, 1.0);
        assert!(p.to_json().contains("\"aggressive\":{\"speedFactor\""));
    }

    #[test]
    fn profile_overrides_patch_and_extend() {
        let patches: BTreeMap<String, DriverProfilePatch> = serde_json::from_str(
            r#"{"average": {"reactionTime": 1.0, "lapseRate": 0},
                "rookie": {"speedFactor": {"mean": 0.9, "sd": 0.05}, "familiarity": 0.5,
                           "timeHeadway": 1.3, "acceleration": 0.9, "deceleration": 0.9,
                           "minimumGap": 1.2, "politeness": 1, "gapAcceptance": 1.2,
                           "laneChangeThreshold": 0.3, "lapseDuration": 1}}"#,
        )
        .unwrap();
        let p = DriverProfiles::with_overrides(&patches).unwrap();
        assert_eq!(p.len(), 6);
        let avg = p.get(p.index("average").unwrap());
        assert_eq!(avg.reaction_time, Dist::constant(1.0));
        assert_eq!(avg.lapse_rate, 0.0);
        let rookie = p.get(p.index("rookie").unwrap());
        assert_eq!(rookie.familiarity, 0.5);
        assert_eq!(
            (rookie.speed_factor.min, rookie.speed_factor.max),
            (0.1, 3.0),
            "open bounds are restricted"
        );
        assert_eq!(rookie.time_headway, Dist::constant(1.3));
        let bad = |json: &str| {
            let patches: BTreeMap<String, DriverProfilePatch> = serde_json::from_str(json).unwrap();
            DriverProfiles::with_overrides(&patches).unwrap_err()
        };
        assert!(bad(r#"{"average": {"reactionTime": 5}}"#).contains("invalid"));
        assert!(bad(r#"{"average": {"familiarity": 2}}"#).contains("invalid"));
        assert!(bad(r#"{"average": {"speedFactor": {"mean": 1, "sd": -1}}}"#).contains("invalid"));
        assert!(bad(r#"{"average": {"speedFactor": {"mean": 1, "min": 2, "max": 1}}}"#).contains("invalid"));
        assert!(bad(r#"{"x": {"lapseRate": -1}}"#).contains("invalid"));
        assert!(serde_json::from_str::<DriverProfilePatch>(r#"{"reaction": 1}"#).is_err());
    }

    #[test]
    fn fleet_validates_mixes() {
        assert!(fleet("{}", "{}", "{}", "{}").is_ok());
        let e = fleet("{}", "{}", r#"{"tram": 1}"#, "{}").unwrap_err();
        assert!(e.contains("unknown vehicle class or type 'tram'"), "{e}");
        assert!(
            fleet("{}", "{}", r#"{"car": -1}"#, "{}")
                .unwrap_err()
                .contains("non-negative")
        );
        assert!(
            fleet("{}", "{}", r#"{"car": 0}"#, "{}")
                .unwrap_err()
                .contains("all be zero")
        );
        let e = fleet("{}", "{}", "{}", r#"{"sleepy": 1}"#).unwrap_err();
        assert!(e.contains("unknown driver profile 'sleepy'"), "{e}");
        assert!(fleet(r#"{"x": {"length": 3}}"#, "{}", "{}", "{}").is_err());
    }

    #[test]
    fn legacy_sampling_matches_class_defaults() {
        let f = fleet("{}", "{}", r#"{"car": 3, "articulatedTruck": 1}"#, "{}").unwrap();
        assert!(f.drivers.is_empty());
        let mut rng = Pcg32::new(1, 1);
        let mut seen = [0; 2];
        for _ in 0..400 {
            let p = f.sample(&f.types, &f.drivers, &mut rng);
            if p.class == VehicleClass::Car {
                assert_eq!(p, VehicleParams::for_class(VehicleClass::Car));
                seen[0] += 1;
            } else {
                assert_eq!(p.length, 16.5);
                assert_eq!(f.catalogue.name(p.vehicle_type), "articulatedTruck");
                seen[1] += 1;
            }
        }
        assert!(seen[0] > 250 && seen[1] > 60, "{seen:?}");
    }

    #[test]
    fn profiles_shape_the_sampled_parameters() {
        let f = fleet("{}", "{}", "{}", r#"{"aggressive": 1, "attentive": 1}"#).unwrap();
        let mut rng = Pcg32::new(9, 1);
        let (mut agg, mut att) = (Vec::new(), Vec::new());
        for _ in 0..2000 {
            let p = f.sample(&f.types, &f.drivers, &mut rng);
            match f.profiles.name(p.driver_profile) {
                "aggressive" => agg.push(p),
                _ => att.push(p),
            }
        }
        let mean =
            |v: &[VehicleParams], g: fn(&VehicleParams) -> f64| v.iter().map(g).sum::<f64>() / v.len() as f64;
        assert!(agg.len() > 900 && att.len() > 900);
        assert!(mean(&agg, |p| p.time_headway) < 0.9 && mean(&att, |p| p.time_headway) > 1.3);
        assert!(mean(&agg, |p| p.speed_factor) > 1.08);
        assert!(mean(&att, |p| p.reaction_time) < 0.65);
        assert!(agg.iter().all(|p| p.lapse_rate == 0.0 && !p.familiar));
        let distinct = agg
            .iter()
            .map(|p| p.speed_factor.to_bits())
            .collect::<std::collections::BTreeSet<_>>();
        assert!(
            distinct.len() > agg.len() * 9 / 10,
            "distributions, not constants"
        );
        // Distracted drivers lapse, commuters know the network.
        let f = fleet(
            "{}",
            r#"{"half": {"familiarity": 0.5}}"#,
            "{}",
            r#"{"distracted": 1, "commuter": 1, "half": 1}"#,
        )
        .unwrap();
        let samples: Vec<VehicleParams> = (0..3000)
            .map(|_| f.sample(&f.types, &f.drivers, &mut rng))
            .collect();
        let by = |name: &str| {
            samples
                .iter()
                .filter(|p| f.profiles.name(p.driver_profile) == name)
                .collect::<Vec<_>>()
        };
        assert!(
            by("distracted")
                .iter()
                .all(|p| p.lapse_rate > 0.0 && p.lapse_duration >= 0.5)
        );
        assert!(by("commuter").iter().all(|p| p.familiar));
        let half = by("half");
        let familiar = half.iter().filter(|p| p.familiar).count() as f64 / half.len() as f64;
        assert!((familiar - 0.5).abs() < 0.07, "{familiar}");
    }

    #[test]
    fn pick_falls_back_to_the_last_positive_entry() {
        let c = vec![(0u8, 0.5), (1, 0.999_999), (2, 0.999_999)];
        assert_eq!(pick(&c, 0.9999995), Some(2));
        assert_eq!(pick::<u8>(&[], 0.5), None);
    }
}
