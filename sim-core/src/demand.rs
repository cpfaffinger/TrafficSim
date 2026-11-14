//! Demand model (#53): zones, OD matrix, time-of-day curves and the start time of day.
//!
//! Arrivals are non-homogeneous Poisson processes: a source draws an exponential amount of
//! "work" (`Exp(1)`) and the next arrival is the time at which the integral of its rate reaches
//! that work. Rates are piecewise constant (time-of-day factors per interval), so the integral is
//! exact and needs only basic arithmetic. A constant rate gives `t + Exp(1) / rate`, identical to
//! the plain Poisson process of the boundary sources.

use std::collections::BTreeMap;

use serde::Deserialize;

/// Seconds per day.
pub const DAY: f64 = 86_400.0;

/// Time of day in seconds since midnight; JSON number (seconds) or `"HH:MM"` / `"HH:MM:SS"`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(try_from = "TimeRepr")]
pub struct TimeOfDay(pub f64);

#[derive(Deserialize)]
#[serde(untagged)]
enum TimeRepr {
    Seconds(f64),
    Clock(String),
}

impl TryFrom<TimeRepr> for TimeOfDay {
    type Error = String;

    fn try_from(r: TimeRepr) -> Result<Self, String> {
        let seconds = match r {
            TimeRepr::Seconds(s) => s,
            TimeRepr::Clock(text) => {
                parse_clock(&text).ok_or_else(|| format!("invalid time of day '{text}'"))?
            }
        };
        if seconds.is_finite() && (0.0..DAY).contains(&seconds) {
            Ok(Self(seconds))
        } else {
            Err("time of day must be within [0, 86400) seconds".into())
        }
    }
}

fn parse_clock(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0.0;
    for (i, p) in parts.iter().enumerate() {
        let v: u32 = p.parse().ok()?;
        let (limit, scale) = [(24, 3600.0), (60, 60.0), (60, 1.0)][i];
        if v >= limit {
            return None;
        }
        seconds += f64::from(v) * scale;
    }
    Some(seconds)
}

impl Default for TimeOfDay {
    fn default() -> Self {
        Self(7.0 * 3600.0)
    }
}

/// Time-of-day curve: piecewise constant factors, repeating with period `interval × len`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeProfile {
    /// Length of one factor interval (s), e.g. 900 for 15-minute factors.
    pub interval: f64,
    pub factors: Vec<f64>,
}

/// Names of the built-in profiles (hourly factors, peak hour = 1).
pub const BUILTIN_PROFILES: [&str; 5] = ["flat", "weekday", "morningPeak", "eveningPeak", "freight"];

impl TimeProfile {
    pub fn builtin(name: &str) -> Option<Self> {
        let hourly: &[f64] = match name {
            "flat" => &[1.0],
            // Typical urban weekday (double peak), normalised to the evening peak hour.
            "weekday" => &[
                0.10, 0.06, 0.05, 0.05, 0.08, 0.19, 0.48, 0.88, 0.94, 0.70, 0.63, 0.65, 0.70, 0.70, 0.73,
                0.83, 0.95, 1.00, 0.83, 0.60, 0.45, 0.35, 0.28, 0.18,
            ],
            // Commuters towards the centre: strong morning peak.
            "morningPeak" => &[
                0.05, 0.03, 0.02, 0.02, 0.05, 0.20, 0.60, 1.00, 0.90, 0.45, 0.30, 0.30, 0.30, 0.30, 0.30,
                0.35, 0.40, 0.40, 0.30, 0.20, 0.15, 0.10, 0.08, 0.06,
            ],
            // Commuters going home: strong evening peak.
            "eveningPeak" => &[
                0.06, 0.04, 0.03, 0.03, 0.04, 0.08, 0.15, 0.30, 0.35, 0.30, 0.30, 0.32, 0.35, 0.35, 0.40,
                0.60, 0.90, 1.00, 0.70, 0.45, 0.30, 0.20, 0.12, 0.08,
            ],
            // Goods traffic: broad daytime plateau, substantial at night.
            "freight" => &[
                0.30, 0.25, 0.25, 0.30, 0.45, 0.70, 0.85, 0.95, 1.00, 1.00, 1.00, 0.95, 0.90, 0.95, 0.95,
                0.90, 0.85, 0.75, 0.60, 0.50, 0.45, 0.40, 0.35, 0.30,
            ],
            _ => return None,
        };
        Some(Self {
            interval: if hourly.len() == 1 { DAY } else { 3600.0 },
            factors: hourly.to_vec(),
        })
    }

    pub fn validate(&self, name: &str) -> Result<(), String> {
        let ok = self.interval.is_finite()
            && self.interval >= 1.0
            && !self.factors.is_empty()
            && self.factors.len() <= 100_000
            && self.factors.iter().all(|f| f.is_finite() && *f >= 0.0);
        if ok {
            Ok(())
        } else {
            Err(format!(
                "time profile '{name}' is invalid (interval ≥ 1 s, factors ≥ 0)"
            ))
        }
    }

    fn period(&self) -> f64 {
        self.interval * self.factors.len() as f64
    }

    /// Factor at time of day `tod` (s, any value; wraps with the period).
    pub fn factor(&self, tod: f64) -> f64 {
        let k = (tod.rem_euclid(self.period()) / self.interval) as usize;
        self.factors[k.min(self.factors.len() - 1)]
    }

    /// End (time of day) of the interval containing `tod`.
    fn interval_end(&self, tod: f64) -> f64 {
        let k = (tod / self.interval).floor();
        let end = (k + 1.0) * self.interval;
        if end <= tod { tod + self.interval } else { end }
    }

    /// Integral of the factor over one period (s).
    fn period_work(&self) -> f64 {
        self.factors.iter().sum::<f64>() * self.interval
    }
}

/// Time at which `∫ rate · factor(offset + t) dt` from `from` reaches `work`; infinite if the
/// rate (or the whole profile) is zero.
pub fn arrival_after(from: f64, work: f64, rate: f64, profile: Option<&TimeProfile>, offset: f64) -> f64 {
    if rate <= 0.0 {
        return f64::INFINITY;
    }
    let Some(p) = profile else {
        return from + work / rate;
    };
    let per_period = p.period_work() * rate;
    if per_period <= 0.0 {
        return f64::INFINITY;
    }
    let mut remaining = work;
    let mut t = from;
    // Skip whole periods, then walk the intervals (at most one period plus one interval).
    let periods = (remaining / per_period).floor();
    if periods >= 1.0 {
        remaining -= periods * per_period;
        t += periods * p.period();
    }
    for _ in 0..=p.factors.len() + 1 {
        let tod = offset + t;
        let r = rate * p.factor(tod);
        let span = p.interval_end(tod) - tod;
        if r > 0.0 && remaining <= r * span {
            return t + remaining / r;
        }
        remaining -= r * span;
        t += span;
    }
    t + remaining.max(0.0) / per_period * p.period()
}

/// A zone: entry/exit nodes and/or internal links (e.g. residential streets at dead ends).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Zone {
    /// Vehicles start on links leaving these nodes and end on links reaching them.
    pub nodes: Vec<String>,
    /// Vehicles start at the beginning and end at the end of these links.
    pub links: Vec<String>,
}

/// One OD matrix entry.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OdEntry {
    pub from: String,
    pub to: String,
    /// Vehicles per hour (at time-of-day factor 1).
    pub vph: f64,
    /// Time-of-day profile (built-in or `timeProfiles`); constant if absent.
    #[serde(default)]
    pub profile: Option<String>,
    /// Vehicle type shares for this pair (default: `vehicleMix`).
    #[serde(default)]
    pub vehicle_mix: Option<BTreeMap<String, f64>>,
    /// Driver profile shares for this pair (default: `driverMix`).
    #[serde(default)]
    pub driver_mix: Option<BTreeMap<String, f64>>,
}

/// Resolves profile names (custom `timeProfiles` first, then built-ins).
pub fn resolve_profile(custom: &BTreeMap<String, TimeProfile>, name: &str) -> Result<TimeProfile, String> {
    custom
        .get(name)
        .cloned()
        .or_else(|| TimeProfile::builtin(name))
        .ok_or_else(|| format!("unknown time profile '{name}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_of_day_parse_numbers_and_clock_strings() {
        let t: TimeOfDay = serde_json::from_str("3600").unwrap();
        assert_eq!(t.0, 3600.0);
        let t: TimeOfDay = serde_json::from_str(r#""07:30""#).unwrap();
        assert_eq!(t.0, 27_000.0);
        let t: TimeOfDay = serde_json::from_str(r#""23:59:59""#).unwrap();
        assert_eq!(t.0, 86_399.0);
        for bad in [
            r#""24:00""#,
            r#""7""#,
            r#""07:60""#,
            r#""a:b""#,
            "-1",
            "86400",
            r#""1:2:3:4""#,
        ] {
            assert!(serde_json::from_str::<TimeOfDay>(bad).is_err(), "{bad}");
        }
        assert_eq!(TimeOfDay::default().0, 25_200.0);
    }

    #[test]
    fn builtin_profiles_peak_at_one() {
        for name in BUILTIN_PROFILES {
            let p = TimeProfile::builtin(name).unwrap();
            p.validate(name).unwrap();
            let max = p.factors.iter().cloned().fold(0.0, f64::max);
            assert_eq!(max, 1.0, "{name}");
            assert!((p.period() - DAY).abs() < 1e-9);
        }
        assert!(TimeProfile::builtin("rush").is_none());
        let w = TimeProfile::builtin("weekday").unwrap();
        assert_eq!(w.factor(17.5 * 3600.0), 1.0);
        assert_eq!(w.factor(17.5 * 3600.0 + DAY), 1.0, "wraps daily");
        assert_eq!(w.factor(-0.5 * 3600.0), w.factors[23]);
        assert!(w.factor(3.0 * 3600.0) < 0.1);
    }

    #[test]
    fn invalid_profiles_are_rejected() {
        let bad = |interval: f64, factors: Vec<f64>| TimeProfile { interval, factors }.validate("x").is_err();
        assert!(bad(0.0, vec![1.0]));
        assert!(bad(900.0, vec![]));
        assert!(bad(900.0, vec![-1.0]));
        assert!(bad(f64::NAN, vec![1.0]));
        assert!(serde_json::from_str::<TimeProfile>(r#"{"interval": 900, "factors": [1], "x": 1}"#).is_err());
        let custom = BTreeMap::from([(
            "mine".to_string(),
            TimeProfile {
                interval: 60.0,
                factors: vec![2.0],
            },
        )]);
        assert_eq!(resolve_profile(&custom, "mine").unwrap().factors, [2.0]);
        assert!(resolve_profile(&custom, "flat").is_ok());
        assert!(
            resolve_profile(&custom, "nope")
                .unwrap_err()
                .contains("unknown time profile")
        );
    }

    #[test]
    fn constant_rates_match_the_plain_poisson_process() {
        assert_eq!(arrival_after(10.0, 0.7, 0.5, None, 0.0), 10.0 + 0.7 / 0.5);
        assert!(arrival_after(0.0, 1.0, 0.0, None, 0.0).is_infinite());
        let zero = TimeProfile {
            interval: 60.0,
            factors: vec![0.0, 0.0],
        };
        assert!(arrival_after(0.0, 1.0, 1.0, Some(&zero), 0.0).is_infinite());
    }

    #[test]
    fn profiled_arrivals_integrate_the_piecewise_rate() {
        // 0 for the first minute, 1 for the second (per period of two minutes).
        let p = TimeProfile {
            interval: 60.0,
            factors: vec![0.0, 1.0],
        };
        // Starting at t = 0 (offset 0): nothing happens in the first minute.
        assert_eq!(arrival_after(0.0, 6.0, 0.5, Some(&p), 0.0), 72.0);
        // Work spanning a zero interval: 60 in [60,120), skip [120,180), 10 more by 190.
        assert_eq!(arrival_after(0.0, 40.0, 1.0, Some(&p), 0.0), 100.0);
        assert_eq!(arrival_after(0.0, 70.0, 1.0, Some(&p), 0.0), 190.0);
        // Offset shifts the time of day.
        assert_eq!(arrival_after(0.0, 6.0, 0.5, Some(&p), 60.0), 12.0);
        // Many whole periods are skipped arithmetically.
        let t = arrival_after(0.0, 6000.0 + 1.0, 1.0, Some(&p), 0.0);
        assert!((t - (100.0 * 120.0 + 61.0)).abs() < 1e-6, "{t}");
        // The mean rate over a day follows the profile integral.
        let w = TimeProfile::builtin("weekday").unwrap();
        let mut t = 0.0;
        let mut n = 0;
        let mut rng = crate::rng::Pcg32::new(1, 2);
        while t < DAY {
            t = arrival_after(t, -crate::detmath::ln(1.0 - rng.next_f64()), 0.2, Some(&w), 0.0);
            n += 1;
        }
        let expected = 0.2 * w.period_work();
        assert!(
            ((n as f64) - expected).abs() < 0.05 * expected,
            "{n} vs {expected}"
        );
    }

    #[test]
    fn interval_ends_advance_even_at_boundaries() {
        let p = TimeProfile {
            interval: 60.0,
            factors: vec![1.0],
        };
        assert_eq!(p.interval_end(0.0), 60.0);
        assert_eq!(p.interval_end(59.9), 60.0);
        assert_eq!(p.interval_end(60.0), 120.0);
    }
}
