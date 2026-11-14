//! Vehicle classes and per-vehicle model parameters.
//!
//! Every vehicle carries its own [`VehicleParams`], so heterogeneity (Phase 5: vehicle type
//! catalogue, driver profiles, reaction times) only changes how the parameters are sampled.

use crate::idm::IdmParams;
use crate::package::VehicleClassDto;
use crate::rng::Pcg32;

/// Vehicle class. The discriminant is the class id used in snapshots and masks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum VehicleClass {
    Car = 0,
    Van = 1,
    Truck = 2,
    Bus = 3,
    Motorcycle = 4,
}

impl VehicleClass {
    pub const ALL: [VehicleClass; 5] = [Self::Car, Self::Van, Self::Truck, Self::Bus, Self::Motorcycle];

    /// Bit of this class in lane/connector class masks.
    pub const fn mask(self) -> u8 {
        1 << (self as u8)
    }

    pub fn id(self) -> u8 {
        self as u8
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "car" => Some(Self::Car),
            "van" => Some(Self::Van),
            "truck" => Some(Self::Truck),
            "bus" => Some(Self::Bus),
            "motorcycle" => Some(Self::Motorcycle),
            _ => None,
        }
    }

    pub(crate) fn from_dto(dto: VehicleClassDto) -> Option<Self> {
        match dto {
            VehicleClassDto::Car => Some(Self::Car),
            VehicleClassDto::Van => Some(Self::Van),
            VehicleClassDto::Truck => Some(Self::Truck),
            VehicleClassDto::Bus => Some(Self::Bus),
            VehicleClassDto::Motorcycle => Some(Self::Motorcycle),
            VehicleClassDto::Unknown => None,
        }
    }
}

/// Model parameters of one vehicle/driver combination (SI units).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleParams {
    pub class: VehicleClass,
    /// Vehicle length (m).
    pub length: f64,
    /// Technical top speed (m/s).
    pub max_speed: f64,
    /// Desired speed as a factor of the posted speed limit (IDM `v0 = factor × limit`).
    pub speed_factor: f64,
    /// IDM safe time headway `T` (s).
    pub time_headway: f64,
    /// IDM maximum acceleration `a` (m/s²).
    pub max_acceleration: f64,
    /// IDM comfortable deceleration `b` (m/s², positive).
    pub comfortable_deceleration: f64,
    /// IDM minimum standstill gap `s0` (m).
    pub minimum_gap: f64,
    /// IDM acceleration exponent `δ`.
    pub delta: f64,
    /// Perception delay (s). Stored for Phase 5 (reaction-time model); not applied yet.
    pub reaction_time: f64,
    /// MOBIL politeness factor `p`.
    pub politeness: f64,
    /// MOBIL switching threshold `Δa_th` (m/s²).
    pub lane_change_threshold: f64,
    /// MOBIL safe deceleration imposed on the new follower `b_safe` (m/s², positive).
    pub safe_deceleration: f64,
    /// Multiplier on the junction critical gaps (1 = average driver).
    pub gap_acceptance_factor: f64,
}

impl VehicleParams {
    /// Average driver in a typical vehicle of `class`.
    pub fn for_class(class: VehicleClass) -> Self {
        let car = Self {
            class,
            length: 4.5,
            max_speed: 50.0,
            speed_factor: 1.0,
            time_headway: 1.2,
            max_acceleration: 1.5,
            comfortable_deceleration: 2.0,
            minimum_gap: 2.0,
            delta: 4.0,
            reaction_time: 0.8,
            politeness: 0.25,
            lane_change_threshold: 0.2,
            safe_deceleration: 4.0,
            gap_acceptance_factor: 1.0,
        };
        match class {
            VehicleClass::Car => car,
            VehicleClass::Van => Self {
                length: 5.5,
                max_speed: 44.0,
                max_acceleration: 1.2,
                ..car
            },
            VehicleClass::Truck => Self {
                length: 12.0,
                max_speed: 25.0,
                time_headway: 1.6,
                max_acceleration: 0.7,
                comfortable_deceleration: 1.5,
                politeness: 0.4,
                safe_deceleration: 3.0,
                gap_acceptance_factor: 1.2,
                ..car
            },
            VehicleClass::Bus => Self {
                length: 12.0,
                max_speed: 28.0,
                time_headway: 1.5,
                max_acceleration: 0.8,
                comfortable_deceleration: 1.5,
                politeness: 0.4,
                safe_deceleration: 3.0,
                gap_acceptance_factor: 1.2,
                ..car
            },
            VehicleClass::Motorcycle => Self {
                length: 2.2,
                max_speed: 55.0,
                max_acceleration: 2.5,
                minimum_gap: 1.5,
                gap_acceptance_factor: 0.9,
                ..car
            },
        }
    }

    /// Class defaults with a uniform relative spread `heterogeneity` on desired speed, headway
    /// and acceleration (0 = identical drivers, no random numbers drawn).
    pub fn sample(class: VehicleClass, heterogeneity: f64, rng: &mut Pcg32) -> Self {
        let mut p = Self::for_class(class);
        if heterogeneity > 0.0 {
            let h = heterogeneity.min(0.5);
            p.speed_factor *= rng.uniform(1.0 - h, 1.0 + h);
            p.time_headway *= rng.uniform(1.0 - h, 1.0 + h);
            p.max_acceleration *= rng.uniform(1.0 - h, 1.0 + h);
        }
        p
    }

    /// Desired speed on a road with the given limit.
    pub fn desired_speed(&self, speed_limit: f64) -> f64 {
        (self.speed_factor * speed_limit).min(self.max_speed).max(0.5)
    }

    /// IDM parameters for a road with the given speed limit.
    pub fn idm(&self, speed_limit: f64) -> IdmParams {
        IdmParams {
            desired_speed: self.desired_speed(speed_limit),
            time_headway: self.time_headway,
            max_acceleration: self.max_acceleration,
            comfortable_deceleration: self.comfortable_deceleration,
            minimum_gap: self.minimum_gap,
            delta: self.delta,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_ids_masks_and_names_round_trip() {
        for (i, class) in VehicleClass::ALL.iter().enumerate() {
            assert_eq!(class.id() as usize, i);
            assert_eq!(class.mask(), 1 << i);
        }
        assert_eq!(VehicleClass::from_name("truck"), Some(VehicleClass::Truck));
        assert_eq!(VehicleClass::from_name("tram"), None);
        assert_eq!(
            VehicleClass::from_dto(VehicleClassDto::Bus),
            Some(VehicleClass::Bus)
        );
        assert_eq!(
            VehicleClass::from_dto(VehicleClassDto::Van),
            Some(VehicleClass::Van)
        );
        assert_eq!(
            VehicleClass::from_dto(VehicleClassDto::Car),
            Some(VehicleClass::Car)
        );
        assert_eq!(
            VehicleClass::from_dto(VehicleClassDto::Truck),
            Some(VehicleClass::Truck)
        );
        assert_eq!(
            VehicleClass::from_dto(VehicleClassDto::Motorcycle),
            Some(VehicleClass::Motorcycle)
        );
        assert_eq!(VehicleClass::from_dto(VehicleClassDto::Unknown), None);
    }

    #[test]
    fn class_defaults_are_plausible() {
        for class in VehicleClass::ALL {
            let p = VehicleParams::for_class(class);
            assert_eq!(p.class, class);
            assert!(p.length > 1.0 && p.length < 20.0);
            assert!(p.max_acceleration > 0.0 && p.comfortable_deceleration > 0.0);
        }
        let truck = VehicleParams::for_class(VehicleClass::Truck);
        assert!(truck.desired_speed(36.0) <= 25.0);
    }

    #[test]
    fn sampling_without_heterogeneity_draws_nothing() {
        let mut rng = Pcg32::new(1, 1);
        let before = rng.clone();
        let p = VehicleParams::sample(VehicleClass::Car, 0.0, &mut rng);
        assert_eq!(p, VehicleParams::for_class(VehicleClass::Car));
        assert_eq!(rng, before);
    }

    #[test]
    fn sampling_with_heterogeneity_spreads_parameters() {
        let mut rng = Pcg32::new(1, 1);
        let a = VehicleParams::sample(VehicleClass::Car, 0.2, &mut rng);
        let b = VehicleParams::sample(VehicleClass::Car, 0.2, &mut rng);
        assert_ne!(a.speed_factor, b.speed_factor);
        assert!((0.8..1.2).contains(&a.speed_factor));
    }

    #[test]
    fn idm_parameters_follow_the_speed_limit() {
        let p = VehicleParams::for_class(VehicleClass::Car);
        let idm = p.idm(13.9);
        assert_eq!(idm.desired_speed, 13.9);
        assert_eq!(idm.time_headway, p.time_headway);
        assert_eq!(p.desired_speed(0.0), 0.5);
    }
}
