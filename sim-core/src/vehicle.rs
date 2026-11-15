//! Vehicle classes, the vehicle type catalogue (#50) and per-vehicle model parameters.
//!
//! Every vehicle carries its own [`VehicleParams`]: the vehicle type (data, see
//! [`VehicleCatalogue`]) provides the physical capabilities, the driver profile
//! ([`crate::driver`]) how they are used.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::idm::IdmParams;
use crate::package::VehicleClassDto;
use crate::rng::Pcg32;

/// Vehicle class. The discriminant is the class id used in snapshots and masks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

/// A vehicle type of the catalogue: physical capabilities plus the IDM/MOBIL defaults of an
/// average driver in it (SI units). Driver profiles scale these values.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleType {
    /// Class used for lane permissions (`allowed`), routing and the snapshot class id.
    pub class: VehicleClass,
    pub length: f64,
    pub width: f64,
    /// Height (m) and gross weight (t): routing avoids links whose limits they exceed (#125).
    #[serde(default = "default_height")]
    pub height: f64,
    #[serde(default = "default_weight")]
    pub weight: f64,
    /// Technical top speed (m/s).
    pub max_speed: f64,
    /// IDM maximum acceleration `a` (m/s²).
    pub max_acceleration: f64,
    /// IDM comfortable deceleration `b` (m/s²).
    pub comfortable_deceleration: f64,
    /// IDM time headway `T` (s).
    pub time_headway: f64,
    /// IDM standstill gap `s0` (m).
    pub minimum_gap: f64,
    /// IDM acceleration exponent `δ`.
    pub delta: f64,
    /// MOBIL safe deceleration `b_safe` (m/s²).
    pub safe_deceleration: f64,
    /// MOBIL politeness `p`.
    pub politeness: f64,
    /// Multiplier on junction critical gaps (long vehicles need larger gaps).
    pub gap_acceptance: f64,
    /// Usable power at the wheels per vehicle mass (W/kg); limits climbing (#87, [`crate::grade`]).
    pub specific_power: f64,
}

/// Partial override of a vehicle type (`vehicleTypes` in the configuration).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleTypePatch {
    pub class: Option<VehicleClass>,
    pub length: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub weight: Option<f64>,
    pub max_speed: Option<f64>,
    pub max_acceleration: Option<f64>,
    pub comfortable_deceleration: Option<f64>,
    pub time_headway: Option<f64>,
    pub minimum_gap: Option<f64>,
    pub delta: Option<f64>,
    pub safe_deceleration: Option<f64>,
    pub politeness: Option<f64>,
    pub gap_acceptance: Option<f64>,
    pub specific_power: Option<f64>,
}

fn default_height() -> f64 {
    1.5
}

fn default_weight() -> f64 {
    1.5
}

impl VehicleType {
    /// Built-in type with the same name as a class (`car`, `van`, `truck`, `bus`, `motorcycle`).
    pub fn for_class(class: VehicleClass) -> Self {
        let car = Self {
            class,
            length: 4.5,
            width: 1.8,
            height: 1.5,
            weight: 1.5,
            max_speed: 50.0,
            max_acceleration: 1.5,
            comfortable_deceleration: 2.0,
            time_headway: 1.2,
            minimum_gap: 2.0,
            delta: 4.0,
            safe_deceleration: 4.0,
            politeness: 0.25,
            gap_acceptance: 1.0,
            specific_power: 50.0,
        };
        let heavy = Self {
            width: 2.55,
            comfortable_deceleration: 1.5,
            politeness: 0.4,
            safe_deceleration: 3.0,
            gap_acceptance: 1.2,
            height: 3.8,
            weight: 18.0,
            // Rigid truck or bus, about 220 kW for 18 t.
            specific_power: 10.0,
            ..car
        };
        match class {
            VehicleClass::Car => car,
            VehicleClass::Van => Self {
                length: 5.5,
                width: 2.0,
                height: 2.6,
                weight: 3.5,
                max_speed: 44.0,
                max_acceleration: 1.2,
                specific_power: 35.0,
                ..car
            },
            // Rigid truck (up to 12 m).
            VehicleClass::Truck => Self {
                length: 12.0,
                max_speed: 25.0,
                time_headway: 1.6,
                max_acceleration: 0.7,
                ..heavy
            },
            VehicleClass::Bus => Self {
                length: 12.0,
                height: 3.2,
                max_speed: 28.0,
                time_headway: 1.5,
                max_acceleration: 0.8,
                ..heavy
            },
            VehicleClass::Motorcycle => Self {
                length: 2.2,
                width: 0.8,
                height: 1.3,
                weight: 0.3,
                max_speed: 55.0,
                max_acceleration: 2.5,
                minimum_gap: 1.5,
                gap_acceptance: 0.9,
                specific_power: 80.0,
                ..car
            },
        }
    }

    /// Articulated truck (tractor + semi-trailer, 16.5 m).
    pub fn articulated_truck() -> Self {
        Self {
            length: 16.5,
            height: 4.0,
            weight: 40.0,
            time_headway: 1.8,
            max_acceleration: 0.5,
            gap_acceptance: 1.3,
            // About 330 kW for 40 t.
            specific_power: 7.0,
            ..Self::for_class(VehicleClass::Truck)
        }
    }

    fn apply(&mut self, p: &VehicleTypePatch) {
        let set = |dst: &mut f64, v: Option<f64>| {
            if let Some(v) = v {
                *dst = v;
            }
        };
        if let Some(c) = p.class {
            self.class = c;
        }
        set(&mut self.length, p.length);
        set(&mut self.width, p.width);
        set(&mut self.height, p.height);
        set(&mut self.weight, p.weight);
        set(&mut self.max_speed, p.max_speed);
        set(&mut self.max_acceleration, p.max_acceleration);
        set(&mut self.comfortable_deceleration, p.comfortable_deceleration);
        set(&mut self.time_headway, p.time_headway);
        set(&mut self.minimum_gap, p.minimum_gap);
        set(&mut self.delta, p.delta);
        set(&mut self.safe_deceleration, p.safe_deceleration);
        set(&mut self.politeness, p.politeness);
        set(&mut self.gap_acceptance, p.gap_acceptance);
        set(&mut self.specific_power, p.specific_power);
    }

    fn validate(&self, name: &str) -> Result<(), String> {
        let positive = [
            self.length,
            self.width,
            self.height,
            self.weight,
            self.max_speed,
            self.max_acceleration,
            self.comfortable_deceleration,
            self.delta,
            self.safe_deceleration,
            self.gap_acceptance,
            self.specific_power,
        ];
        let non_negative = [self.time_headway, self.minimum_gap, self.politeness];
        if positive.iter().all(|v| v.is_finite() && *v > 0.0)
            && non_negative.iter().all(|v| v.is_finite() && *v >= 0.0)
            && self.length <= 30.0
        {
            Ok(())
        } else {
            Err(format!("vehicle type '{name}' has invalid parameters"))
        }
    }

    /// Parameters of an average driver in this vehicle.
    pub fn params(&self) -> VehicleParams {
        VehicleParams {
            class: self.class,
            length: self.length,
            width: self.width,
            height: self.height,
            weight: self.weight,
            max_speed: self.max_speed,
            speed_factor: 1.0,
            time_headway: self.time_headway,
            max_acceleration: self.max_acceleration,
            comfortable_deceleration: self.comfortable_deceleration,
            minimum_gap: self.minimum_gap,
            delta: self.delta,
            reaction_time: 0.0,
            politeness: self.politeness,
            lane_change_threshold: 0.2,
            safe_deceleration: self.safe_deceleration,
            gap_acceptance_factor: self.gap_acceptance,
            specific_power: self.specific_power,
            lapse_rate: 0.0,
            lapse_duration: 0.0,
            familiar: false,
            vehicle_type: 0,
            driver_profile: NO_PROFILE,
        }
    }
}

/// Names of the built-in vehicle types, in catalogue order.
pub const BUILTIN_TYPES: [&str; 6] = ["car", "van", "truck", "articulatedTruck", "bus", "motorcycle"];

/// The vehicle type catalogue: built-in types (in [`BUILTIN_TYPES`] order) followed by custom
/// types from the configuration (sorted by name). The index of a type is stable for a
/// configuration and reported in [`VehicleParams::vehicle_type`].
#[derive(Debug, Clone, PartialEq)]
pub struct VehicleCatalogue {
    types: Vec<(String, VehicleType)>,
}

impl Default for VehicleCatalogue {
    fn default() -> Self {
        Self::builtin()
    }
}

impl VehicleCatalogue {
    pub fn builtin() -> Self {
        let get = |name: &str| match name {
            "articulatedTruck" => VehicleType::articulated_truck(),
            _ => VehicleType::for_class(VehicleClass::from_name(name).unwrap_or(VehicleClass::Car)),
        };
        Self {
            types: BUILTIN_TYPES.iter().map(|&n| (n.to_string(), get(n))).collect(),
        }
    }

    /// Built-in catalogue with overrides: a patch of a built-in name changes that type, any other
    /// name adds a type based on the built-in type of its `class` (required).
    pub fn with_overrides(patches: &BTreeMap<String, VehicleTypePatch>) -> Result<Self, String> {
        let mut cat = Self::builtin();
        for (name, patch) in patches {
            match cat.index(name) {
                Some(i) => cat.types[i as usize].1.apply(patch),
                None => {
                    let class = patch
                        .class
                        .ok_or_else(|| format!("new vehicle type '{name}' needs a class"))?;
                    let mut t = VehicleType::for_class(class);
                    t.apply(patch);
                    cat.types.push((name.clone(), t));
                }
            }
        }
        for (name, t) in &cat.types {
            t.validate(name)?;
        }
        Ok(cat)
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }

    pub fn index(&self, name: &str) -> Option<u16> {
        self.types.iter().position(|(n, _)| n == name).map(|i| i as u16)
    }

    pub fn get(&self, index: u16) -> &VehicleType {
        &self.types[index as usize].1
    }

    pub fn name(&self, index: u16) -> &str {
        &self.types[index as usize].0
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &VehicleType)> {
        self.types.iter().map(|(n, t)| (n.as_str(), t))
    }

    /// The catalogue as a JSON object `{name: type}` (same keys as the `vehicleTypes` config).
    pub fn to_json(&self) -> String {
        let map: BTreeMap<&str, &VehicleType> = self.iter().collect();
        serde_json::to_string(&map).unwrap_or_default()
    }
}

/// `profile` value of vehicles without a driver profile (legacy sampling).
pub const NO_PROFILE: u8 = u8::MAX;

/// Model parameters of one vehicle/driver combination (SI units).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VehicleParams {
    pub class: VehicleClass,
    /// Vehicle length (m).
    pub length: f64,
    /// Vehicle width (m).
    pub width: f64,
    /// Vehicle height (m) and gross weight (t), for link limits (#125).
    pub height: f64,
    pub weight: f64,
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
    /// Perception delay of the leader's state (s), see `sim::perception`.
    pub reaction_time: f64,
    /// MOBIL politeness factor `p`.
    pub politeness: f64,
    /// MOBIL switching threshold `Δa_th` (m/s²).
    pub lane_change_threshold: f64,
    /// MOBIL safe deceleration imposed on the new follower `b_safe` (m/s², positive).
    pub safe_deceleration: f64,
    /// Multiplier on the junction critical gaps (1 = average driver).
    pub gap_acceptance_factor: f64,
    /// Usable power at the wheels per mass (W/kg), see [`crate::grade`].
    pub specific_power: f64,
    /// Distraction lapses per second (Poisson rate, 0 = never distracted).
    pub lapse_rate: f64,
    /// Mean duration of a distraction lapse (s).
    pub lapse_duration: f64,
    /// Familiar with the network (commuter): re-routes on experienced travel times (#55).
    pub familiar: bool,
    /// Index in the vehicle catalogue.
    pub vehicle_type: u16,
    /// Index of the driver profile, [`NO_PROFILE`] for legacy sampling.
    pub driver_profile: u8,
}

impl VehicleParams {
    /// Average driver in the built-in vehicle type of `class` (reaction time 0.8 s).
    pub fn for_class(class: VehicleClass) -> Self {
        let mut p = VehicleType::for_class(class).params();
        p.reaction_time = 0.8;
        let name = class_type_name(class);
        p.vehicle_type = BUILTIN_TYPES.iter().position(|&n| n == name).unwrap_or(0) as u16;
        p
    }

    /// Class defaults with a uniform relative spread `heterogeneity` on desired speed, headway
    /// and acceleration (0 = identical drivers, no random numbers drawn).
    pub fn sample(class: VehicleClass, heterogeneity: f64, rng: &mut Pcg32) -> Self {
        let mut p = Self::for_class(class);
        p.spread(heterogeneity, rng);
        p
    }

    /// Applies the legacy uniform spread on desired speed, headway and acceleration.
    pub(crate) fn spread(&mut self, heterogeneity: f64, rng: &mut Pcg32) {
        if heterogeneity > 0.0 {
            let h = heterogeneity.min(0.5);
            self.speed_factor *= rng.uniform(1.0 - h, 1.0 + h);
            self.time_headway *= rng.uniform(1.0 - h, 1.0 + h);
            self.max_acceleration *= rng.uniform(1.0 - h, 1.0 + h);
        }
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

fn class_type_name(class: VehicleClass) -> &'static str {
    match class {
        VehicleClass::Car => "car",
        VehicleClass::Van => "van",
        VehicleClass::Truck => "truck",
        VehicleClass::Bus => "bus",
        VehicleClass::Motorcycle => "motorcycle",
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
            assert_eq!(VehicleClass::from_name(class_type_name(*class)), Some(*class));
        }
        assert_eq!(VehicleClass::from_name("tram"), None);
        for (dto, class) in [
            (VehicleClassDto::Car, VehicleClass::Car),
            (VehicleClassDto::Van, VehicleClass::Van),
            (VehicleClassDto::Truck, VehicleClass::Truck),
            (VehicleClassDto::Bus, VehicleClass::Bus),
            (VehicleClassDto::Motorcycle, VehicleClass::Motorcycle),
        ] {
            assert_eq!(VehicleClass::from_dto(dto), Some(class));
        }
        assert_eq!(VehicleClass::from_dto(VehicleClassDto::Unknown), None);
    }

    #[test]
    fn class_defaults_are_plausible() {
        for class in VehicleClass::ALL {
            let p = VehicleParams::for_class(class);
            assert_eq!(p.class, class);
            assert!(p.length > 1.0 && p.length < 20.0);
            assert!(p.width > 0.5 && p.width <= 2.55);
            assert!(p.max_acceleration > 0.0 && p.comfortable_deceleration > 0.0);
            assert_eq!(p.reaction_time, 0.8);
            let cat = VehicleCatalogue::builtin();
            assert_eq!(cat.get(p.vehicle_type).class, class);
        }
        let truck = VehicleParams::for_class(VehicleClass::Truck);
        assert!(truck.desired_speed(36.0) <= 25.0);
    }

    #[test]
    fn builtin_catalogue_lists_rigid_and_articulated_trucks() {
        let cat = VehicleCatalogue::builtin();
        assert_eq!(cat.len(), 6);
        assert!(!cat.is_empty());
        let rigid = cat.get(cat.index("truck").unwrap());
        let artic = cat.get(cat.index("articulatedTruck").unwrap());
        assert_eq!(artic.class, VehicleClass::Truck);
        assert!(artic.length > rigid.length && artic.max_acceleration < rigid.max_acceleration);
        assert_eq!(cat.name(3), "articulatedTruck");
        assert_eq!(cat.index("tram"), None);
        let json = cat.to_json();
        assert!(
            json.contains("\"articulatedTruck\":{\"class\":\"truck\",\"length\":16.5"),
            "{json}"
        );
        assert_eq!(VehicleCatalogue::default(), cat);
    }

    #[test]
    fn catalogue_overrides_patch_and_extend() {
        let patches: BTreeMap<String, VehicleTypePatch> = serde_json::from_str(
            r#"{"car": {"length": 4.8, "maxSpeed": 45},
                "minibus": {"class": "bus", "length": 7.5, "maxAcceleration": 1.1}}"#,
        )
        .unwrap();
        let cat = VehicleCatalogue::with_overrides(&patches).unwrap();
        assert_eq!(cat.len(), 7);
        let car = cat.get(cat.index("car").unwrap());
        assert_eq!((car.length, car.max_speed), (4.8, 45.0));
        assert_eq!(car.time_headway, 1.2, "untouched values keep their defaults");
        let mini = cat.get(cat.index("minibus").unwrap());
        assert_eq!(mini.class, VehicleClass::Bus);
        assert_eq!(mini.length, 7.5);
        assert_eq!(
            mini.time_headway,
            VehicleType::for_class(VehicleClass::Bus).time_headway
        );
        assert_eq!(cat.iter().count(), 7);

        let bad = |json: &str| {
            let p: BTreeMap<String, VehicleTypePatch> = serde_json::from_str(json).unwrap();
            VehicleCatalogue::with_overrides(&p).unwrap_err()
        };
        assert!(bad(r#"{"tram": {"length": 30}}"#).contains("needs a class"));
        assert!(bad(r#"{"car": {"length": -1}}"#).contains("invalid parameters"));
        assert!(bad(r#"{"car": {"length": 40}}"#).contains("invalid parameters"));
        assert!(bad(r#"{"car": {"politeness": -1}}"#).contains("invalid parameters"));
        assert!(serde_json::from_str::<VehicleTypePatch>(r#"{"lenght": 3}"#).is_err());
    }

    #[test]
    fn type_params_carry_the_type_values() {
        let t = VehicleType::articulated_truck();
        let p = t.params();
        assert_eq!(p.length, 16.5);
        assert_eq!(p.width, 2.55);
        assert_eq!(p.reaction_time, 0.0);
        assert_eq!(p.driver_profile, NO_PROFILE);
        assert!(!p.familiar);
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
