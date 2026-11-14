//! Intelligent Driver Model (Treiber, Hennecke & Helbing, 2000), see ADR-0007.

/// Strongest deceleration the model may command (m/s²); physical limit of emergency braking.
pub const MAX_EMERGENCY_DECELERATION: f64 = 9.0;

/// IDM parameters of one driver/vehicle combination. SI units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IdmParams {
    /// Desired speed `v0` (m/s).
    pub desired_speed: f64,
    /// Safe time headway `T` (s).
    pub time_headway: f64,
    /// Maximum acceleration `a` (m/s²).
    pub max_acceleration: f64,
    /// Comfortable deceleration `b` (m/s², positive).
    pub comfortable_deceleration: f64,
    /// Minimum standstill gap `s0` (m).
    pub minimum_gap: f64,
    /// Acceleration exponent `δ`.
    pub delta: f64,
}

impl IdmParams {
    /// Typical passenger car in urban traffic.
    pub const fn urban_car() -> Self {
        Self {
            desired_speed: 50.0 / 3.6,
            time_headway: 1.2,
            max_acceleration: 1.0,
            comfortable_deceleration: 1.5,
            minimum_gap: 2.0,
            delta: 4.0,
        }
    }

    /// Desired gap `s*` for own speed `v` and approach rate `dv = v - v_leader`.
    pub fn desired_gap(&self, speed: f64, approach_rate: f64) -> f64 {
        let dynamic = speed * self.time_headway
            + speed * approach_rate / (2.0 * (self.max_acceleration * self.comfortable_deceleration).sqrt());
        self.minimum_gap + dynamic.max(0.0)
    }

    /// IDM acceleration for own speed `v`, net gap `s` to the leader (bumper to bumper, m) and
    /// approach rate `dv = v - v_leader`. Use `f64::INFINITY` as gap on a free road.
    pub fn acceleration(&self, speed: f64, gap: f64, approach_rate: f64) -> f64 {
        let free = 1.0 - (speed / self.desired_speed).powf(self.delta);
        if gap.is_infinite() {
            return self.max_acceleration * free;
        }
        if gap <= 0.0 {
            return -MAX_EMERGENCY_DECELERATION;
        }
        let interaction = (self.desired_gap(speed, approach_rate) / gap).powi(2);
        (self.max_acceleration * (free - interaction)).max(-MAX_EMERGENCY_DECELERATION)
    }

    /// Equilibrium (steady-state) gap for speed `v` with `dv = 0`; infinite at `v >= v0`.
    pub fn equilibrium_gap(&self, speed: f64) -> f64 {
        let ratio = 1.0 - (speed / self.desired_speed).powf(self.delta);
        if ratio <= 0.0 {
            return f64::INFINITY;
        }
        (self.minimum_gap + speed * self.time_headway) / ratio.sqrt()
    }

    /// Equilibrium speed for a given gap, found by bisection on [`Self::equilibrium_gap`].
    pub fn equilibrium_speed(&self, gap: f64) -> f64 {
        if gap <= self.minimum_gap {
            return 0.0;
        }
        let (mut low, mut high) = (0.0, self.desired_speed);
        for _ in 0..80 {
            let mid = 0.5 * (low + high);
            if self.equilibrium_gap(mid) < gap {
                low = mid;
            } else {
                high = mid;
            }
        }
        0.5 * (low + high)
    }
}

impl Default for IdmParams {
    fn default() -> Self {
        Self::urban_car()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    #[test]
    fn standing_vehicle_on_free_road_accelerates_with_max_acceleration() {
        let p = IdmParams::urban_car();
        assert!((p.acceleration(0.0, f64::INFINITY, 0.0) - p.max_acceleration).abs() < EPS);
    }

    #[test]
    fn vehicle_at_desired_speed_on_free_road_does_not_accelerate() {
        let p = IdmParams::urban_car();
        assert!(p.acceleration(p.desired_speed, f64::INFINITY, 0.0).abs() < EPS);
    }

    #[test]
    fn vehicle_faster_than_desired_speed_decelerates() {
        let p = IdmParams::urban_car();
        assert!(p.acceleration(p.desired_speed * 1.2, f64::INFINITY, 0.0) < 0.0);
    }

    #[test]
    fn acceleration_is_zero_at_equilibrium_gap() {
        let p = IdmParams::urban_car();
        for speed in [2.0, 5.0, 10.0, 13.0] {
            let gap = p.equilibrium_gap(speed);
            assert!(p.acceleration(speed, gap, 0.0).abs() < 1e-9, "v={speed}");
        }
    }

    #[test]
    fn closing_in_on_a_stopped_vehicle_brakes_hard() {
        let p = IdmParams::urban_car();
        let a = p.acceleration(13.0, 20.0, 13.0);
        assert!(a < -p.comfortable_deceleration, "a={a}");
    }

    #[test]
    fn deceleration_is_capped_and_overlap_triggers_emergency_braking() {
        let p = IdmParams::urban_car();
        assert_eq!(p.acceleration(10.0, 0.01, 10.0), -MAX_EMERGENCY_DECELERATION);
        assert_eq!(p.acceleration(10.0, 0.0, 0.0), -MAX_EMERGENCY_DECELERATION);
        assert_eq!(p.acceleration(10.0, -1.0, 0.0), -MAX_EMERGENCY_DECELERATION);
    }

    #[test]
    fn desired_gap_never_falls_below_minimum_gap() {
        let p = IdmParams::urban_car();
        // A fast-receding leader would make the dynamic term negative.
        assert!((p.desired_gap(10.0, -20.0) - p.minimum_gap).abs() < EPS);
    }

    #[test]
    fn equilibrium_speed_inverts_equilibrium_gap() {
        let p = IdmParams::urban_car();
        for speed in [1.0, 4.0, 8.0, 12.0] {
            let gap = p.equilibrium_gap(speed);
            assert!((p.equilibrium_speed(gap) - speed).abs() < 1e-6, "v={speed}");
        }
        assert_eq!(p.equilibrium_speed(p.minimum_gap), 0.0);
        assert!(p.equilibrium_gap(p.desired_speed).is_infinite());
    }

    #[test]
    fn default_is_urban_car() {
        assert_eq!(IdmParams::default(), IdmParams::urban_car());
    }
}
