//! Capacity validation of an unsignalised T junction (#109): the saturation flow of the
//! single-lane minor approach against the HCM gap-acceptance model.
//!
//! **Reference.** HCM 2010 / HCM 6th ed. (two-way stop control) derive the potential capacity
//! of a minor movement from the gap-acceptance function of Harders: a gap of `h` seconds in the
//! conflicting stream lets `n(h) = 1 + ⌊(h − t_c) / t_f⌋` minor vehicles enter (0 if `h < t_c`),
//! with the critical gap `t_c` and the follow-up time `t_f`. With exponential (random)
//! conflicting headways this gives the familiar curve "capacity vs. conflicting flow":
//!
//! `c_p = v_c · e^(−v_c·t_c/3600) / (1 − e^(−v_c·t_f/3600))`  (veh/h).
//!
//! A single-lane conflicting stream cannot be exponential (vehicles keep a minimum headway of
//! about 1.7 s at 50 km/h), so it has fewer long gaps than the curve assumes: without any minor
//! traffic, `n(h)` summed over the simulated conflicting stream at 800 veh/h gives about 70 % of
//! `c_p` (at 500 veh/h about 88 %). The acceptance reference is therefore the HCM function
//! `n(h)` applied to the *observed* conflicting headways at the junction (the HCM curve evaluated
//! for the actual headway distribution); `c_p` is reported alongside.
//!
//! The simulation is configured with the HCM base values of the movement for a two-lane major
//! road — right turn from the minor road `t_c = 6.2 s`, `t_f = 3.3 s`; left turn `t_c = 7.1 s`,
//! `t_f = 3.5 s` — as `junction.criticalGapMinor` / `junction.followUpTime`; the minor approach
//! is oversaturated. Acceptance: measured minor flow within ±15 % of the reference for
//! conflicting flows up to about 600 veh/h (right turn) and 900 veh/h (left turn, both
//! directions). The follow-up headway of a queue of default cars is about 3.5–3.9 s (start-up
//! and move-up dynamics of the car-following model) rather than the configured 3.3 s, so the
//! right turn falls to about 0.85 of the reference at 800 veh/h, where most gaps take one or
//! two vehicles.

use trafficsim_sim_core::config::SimConfig;
use trafficsim_sim_core::package::Priority;
use trafficsim_sim_core::sim::Simulation;
use trafficsim_sim_core::synth::t_junction;

/// HCM potential capacity (veh/h) for exponential conflicting headways.
fn hcm_capacity(vc: f64, tc: f64, tf: f64) -> f64 {
    vc * (-vc * tc / 3600.0).exp() / (1.0 - (-vc * tf / 3600.0).exp())
}

/// Minor vehicles that enter a conflicting gap of `h` seconds (Harders / HCM).
fn entries_in_gap(h: f64, tc: f64, tf: f64) -> f64 {
    if h < tc {
        0.0
    } else {
        1.0 + ((h - tc) / tf).floor()
    }
}

#[derive(Clone, Copy, Debug)]
enum Minor {
    /// S → E: merges with the W → E through traffic.
    Right,
    /// S → W: crosses W → E and merges with E → W.
    Left,
}

impl Minor {
    /// HCM 2010 base critical gap and follow-up time (two-lane major road).
    fn hcm(self) -> (f64, f64) {
        match self {
            Minor::Right => (6.2, 3.3),
            Minor::Left => (7.1, 3.5),
        }
    }
}

struct Measurement {
    /// Conflicting flow (veh/h).
    vc: f64,
    /// Minor discharge flow (veh/h).
    sim: f64,
    /// HCM gap acceptance on the observed conflicting headways (veh/h).
    reference: f64,
    /// HCM curve for exponential headways (veh/h).
    curve: f64,
}

fn measure(minor: Minor, major_vph: f64, seed: u64, hours: f64) -> Measurement {
    let (tc, tf) = minor.hcm();
    let (minor_to, opposite) = match minor {
        Minor::Right => ("e", 0.0),
        Minor::Left => ("w", major_vph),
    };
    let json = format!(
        r#"{{"zones": {{"w": {{"nodes": ["W"]}}, "e": {{"nodes": ["E"]}}, "s": {{"nodes": ["S"]}}}},
            "od": [{{"from": "w", "to": "e", "vph": {major_vph}}},
                   {{"from": "e", "to": "w", "vph": {opposite}}},
                   {{"from": "s", "to": "{minor_to}", "vph": 1500}}],
            "demandCurve": "flat",
            "junction": {{"criticalGapMinor": {tc}, "followUpTime": {tf}, "maxWait": 1e9}}}}"#
    );
    let config = SimConfig::from_json(&json).unwrap();
    let mut s = Simulation::new(t_junction(Priority::Minor).network(), config, seed).unwrap();
    s.set_event_logging(true);
    let warm_up = 600.0;
    s.run((warm_up / s.time_step()) as usize);
    s.run((hours * 3600.0 / s.time_step()) as usize);
    let net = s.network();
    let c = |id: &str| net.connector_index(id).unwrap();
    let (minor_conn, conflicting) = match minor {
        Minor::Right => (c("sj_e"), vec![c("we_e")]),
        Minor::Left => (c("sj_w"), vec![c("we_e"), c("ew_w")]),
    };
    let entries = s.entry_log().iter().filter(|e| e.time >= warm_up);
    let mut major: Vec<f64> = entries
        .clone()
        .filter(|e| conflicting.contains(&e.connector))
        .map(|e| e.time)
        .collect();
    major.sort_by(f64::total_cmp);
    let minor_count = entries.filter(|e| e.connector == minor_conn).count();
    let reference: f64 = major
        .windows(2)
        .map(|w| entries_in_gap(w[1] - w[0], tc, tf))
        .sum();
    let vc = major.len() as f64 / hours;
    Measurement {
        vc,
        sim: minor_count as f64 / hours,
        reference: reference / hours,
        curve: hcm_capacity(vc, tc, tf),
    }
}

#[test]
fn unsignalised_t_junction_capacity_matches_hcm_gap_acceptance() {
    let cases = [
        (Minor::Right, 200.0),
        (Minor::Right, 400.0),
        (Minor::Right, 600.0),
        (Minor::Left, 150.0),
        (Minor::Left, 300.0),
        (Minor::Left, 450.0),
    ];
    let mut report = String::from("movement  v_c   sim   HCM(observed headways)  ratio   HCM curve  ratio\n");
    let mut failures = Vec::new();
    for (minor, major) in cases {
        let m = measure(minor, major, 3, 1.0);
        let ratio = m.sim / m.reference;
        report.push_str(&format!(
            "{minor:?}\t{:4.0}  {:4.0}  {:4.0}  {ratio:.3}  {:4.0}  {:.3}\n",
            m.vc,
            m.sim,
            m.reference,
            m.curve,
            m.sim / m.curve
        ));
        if !(0.85..=1.15).contains(&ratio) {
            failures.push(format!("{minor:?} at {:.0} veh/h", m.vc));
        }
    }
    println!("{report}");
    assert!(failures.is_empty(), "outside ±15 %: {failures:?}\n{report}");
}

#[test]
fn hcm_reference_functions() {
    // Spot values of the HCM curve (t_c = 6.2 s, t_f = 3.3 s).
    assert!((hcm_capacity(400.0, 6.2, 3.3) - 654.2).abs() < 0.5);
    assert!(
        hcm_capacity(1e-6, 6.2, 3.3) > 1090.0,
        "3600 / t_f without conflicts"
    );
    assert_eq!(entries_in_gap(6.1, 6.2, 3.3), 0.0);
    assert_eq!(entries_in_gap(6.2, 6.2, 3.3), 1.0);
    assert_eq!(entries_in_gap(12.9, 6.2, 3.3), 3.0);
}
