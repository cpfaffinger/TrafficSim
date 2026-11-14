//! Reaction time and distraction (#52).
//!
//! Every vehicle records its odometer and speed once per step in a fixed-size ring buffer
//! ([`HISTORY`] entries, no allocation after insertion). A follower with reaction time `τ`
//! perceives its leader as it was `τ` ago and extrapolates it with that old speed (the
//! anticipation of Treiber's Human Driver Model):
//!
//! `gap_perceived = gap − (x_l(t) − x_l(t − τ) − τ · v_l(t − τ))`, `v_l,perceived = v_l(t − τ)`.
//!
//! A leader at constant speed is perceived exactly; a braking leader is noticed late. Drivers
//! with a lapse rate get Poisson-distributed distraction lapses (per-vehicle PCG32 stream) during
//! which they keep their acceleration (at most the free-road acceleration). Physical safety is
//! kept by an emergency reflex: when the true situation demands braking harder than
//! `perception.emergencyFactor × b`, the true acceleration is used.

use super::{STOP_LINE_MARGIN, Simulation};
use crate::idm::{IdmParams, MAX_EMERGENCY_DECELERATION};
use crate::rng::Pcg32;

/// Ring buffer length (steps). Reaction times are capped at `(HISTORY − 2) · Δt`.
pub const HISTORY: usize = 32;

/// Odometer and speed history of one vehicle.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct History {
    odo: [f64; HISTORY],
    speed: [f32; HISTORY],
}

impl History {
    /// History of a vehicle inserted at step `now` with constant speed in the past.
    pub(super) fn new(now: u64, odo: f64, speed: f64, dt: f64) -> Self {
        let mut h = Self {
            odo: [0.0; HISTORY],
            speed: [speed as f32; HISTORY],
        };
        for back in 0..HISTORY {
            h.odo[slot(now, back)] = odo - back as f64 * dt * speed;
        }
        h
    }

    pub(super) fn record(&mut self, now: u64, odo: f64, speed: f64) {
        let s = slot(now, 0);
        self.odo[s] = odo;
        self.speed[s] = speed as f32;
    }
}

fn slot(now: u64, back: usize) -> usize {
    (now as usize + HISTORY - back) % HISTORY
}

/// Perception delay of one driver in steps: whole steps and fraction.
#[derive(Debug, Clone, Copy)]
pub(super) struct Delay {
    steps: usize,
    frac: f64,
    tau: f64,
}

impl Delay {
    pub(super) fn new(reaction_time: f64, dt: f64) -> Option<Self> {
        if reaction_time <= 0.0 {
            return None;
        }
        let d = (reaction_time / dt).min((HISTORY - 2) as f64);
        let steps = d as usize;
        Some(Self {
            steps,
            frac: d - steps as f64,
            tau: d * dt,
        })
    }
}

/// Accelerations of one driver: free road, as perceived, and from the true state.
#[derive(Debug, Clone, Copy)]
pub(super) struct Accel {
    pub free: f64,
    pub perceived: f64,
    pub truth: f64,
}

impl Accel {
    pub(super) fn new(free: f64) -> Self {
        Self {
            free,
            perceived: free,
            truth: free,
        }
    }

    /// A constraint perceived without delay (stop lines, dead ends, speed limits).
    pub(super) fn limit(&mut self, a: f64) {
        self.perceived = self.perceived.min(a);
        self.truth = self.truth.min(a);
    }

    /// Final acceleration: perception (or the kept acceleration during a lapse) with the
    /// emergency reflex on the true state.
    pub(super) fn resolve(&self, lapse: Option<f64>, emergency: f64) -> f64 {
        let a = match lapse {
            Some(kept) => kept.min(self.free),
            None => self.perceived,
        };
        let a = if self.truth < -emergency {
            a.min(self.truth)
        } else {
            a
        };
        a.max(-MAX_EMERGENCY_DECELERATION)
    }
}

impl Simulation {
    /// Adds the constraint of leader `j` at true net gap `gap` to `acc`.
    pub(super) fn follow_vehicle(
        &self,
        acc: &mut Accel,
        idm: &IdmParams,
        speed: f64,
        gap: f64,
        j: u32,
        delay: Option<Delay>,
    ) {
        let l = &self.vehicles[j as usize];
        let truth = idm.acceleration(speed, gap, speed - l.speed);
        acc.truth = acc.truth.min(truth);
        let perceived = match delay {
            // A vehicle closer than the standstill gap is noticed at once.
            None => truth,
            Some(_) if gap < idm.minimum_gap => truth,
            Some(d) => {
                let h = &self.history[j as usize];
                let (a, b) = (slot(self.steps, d.steps), slot(self.steps, d.steps + 1));
                let odo_then = h.odo[a] + (h.odo[b] - h.odo[a]) * d.frac;
                let v_then = f64::from(h.speed[a]) + f64::from(h.speed[b] - h.speed[a]) * d.frac;
                let estimate = l.odo - odo_then - d.tau * v_then;
                idm.acceleration(speed, gap - estimate, speed - v_then)
            }
        };
        acc.perceived = acc.perceived.min(perceived);
    }

    /// A standing obstacle (stop line, dead end) at net distance `gap`.
    pub(super) fn stop_at(acc: &mut Accel, idm: &IdmParams, speed: f64, gap: f64) {
        acc.limit(idm.acceleration(speed, gap - STOP_LINE_MARGIN, speed));
    }

    /// Starts and ends distraction lapses (before the accelerations of a step are computed).
    pub(super) fn update_lapses(&mut self) {
        let time = self.time;
        for v in &mut self.vehicles {
            if v.params.lapse_rate <= 0.0 || time < v.next_lapse {
                continue;
            }
            let duration = v.params.lapse_duration * v.rng.uniform(0.5, 1.5);
            v.lapse_until = time + duration;
            v.next_lapse = v.lapse_until + exponential(&mut v.rng, v.params.lapse_rate);
            self.counters.lapses += 1;
        }
    }

    pub(super) fn record_history(&mut self) {
        let now = self.steps;
        for (h, v) in self.history.iter_mut().zip(&self.vehicles) {
            h.record(now, v.odo, v.speed);
        }
    }
}

/// Exponentially distributed waiting time for `rate` events per second.
pub(super) fn exponential(rng: &mut Pcg32, rate: f64) -> f64 {
    -crate::detmath::ln(1.0 - rng.next_f64()) / rate
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_extrapolated_backwards_and_recorded_in_a_ring() {
        let mut h = History::new(5, 100.0, 10.0, 0.1);
        assert_eq!(h.odo[slot(5, 0)], 100.0);
        assert_eq!(h.odo[slot(5, 3)], 97.0);
        assert_eq!(h.speed[slot(5, 31)], 10.0);
        h.record(6, 101.0, 9.0);
        assert_eq!(h.odo[slot(6, 0)], 101.0);
        assert_eq!(h.odo[slot(6, 1)], 100.0);
        assert_eq!(slot(0, 1), HISTORY - 1);
    }

    #[test]
    fn delays_are_split_into_steps_and_fractions_and_capped() {
        assert!(Delay::new(0.0, 0.1).is_none());
        let d = Delay::new(0.85, 0.1).unwrap();
        assert_eq!(d.steps, 8);
        assert!((d.frac - 0.5).abs() < 1e-9 && (d.tau - 0.85).abs() < 1e-9);
        let capped = Delay::new(10.0, 0.1).unwrap();
        assert_eq!(capped.steps, HISTORY - 2);
    }

    #[test]
    fn accelerations_resolve_lapses_and_the_emergency_reflex() {
        let mut a = Accel::new(1.0);
        a.limit(0.5);
        assert_eq!((a.perceived, a.truth), (0.5, 0.5));
        a.truth = -1.0;
        a.perceived = 0.2;
        assert_eq!(a.resolve(None, 3.0), 0.2, "mild situations follow perception");
        assert_eq!(
            a.resolve(Some(2.0), 3.0),
            1.0,
            "lapse keeps acceleration up to free road"
        );
        a.truth = -5.0;
        assert_eq!(a.resolve(None, 3.0), -5.0, "emergency reflex");
        a.truth = -20.0;
        assert_eq!(a.resolve(Some(0.3), 3.0), -MAX_EMERGENCY_DECELERATION);
    }
}
