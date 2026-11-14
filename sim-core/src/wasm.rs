//! WebAssembly bindings used by the browser simulation worker (ADR-0006).
//!
//! The boundary is coarse-grained: the worker calls `step(n)` once per frame and reads one
//! packed snapshot buffer.

use wasm_bindgen::prelude::*;

use crate::ring::{RingRoad, RingRoadConfig};
use crate::sim::Simulation;

/// Floats per vehicle in [`RingRoadSim::snapshot`]: position (m), speed (m/s).
pub const SNAPSHOT_STRIDE: usize = 2;

/// Floats per vehicle in [`NetworkSim::snapshot`].
pub const NETWORK_SNAPSHOT_STRIDE: usize = crate::sim::SNAPSHOT_STRIDE;

#[wasm_bindgen]
pub struct RingRoadSim {
    ring: RingRoad,
}

#[wasm_bindgen]
impl RingRoadSim {
    /// Creates a Sugiyama-style ring road. Returns an error instead of panicking on bad input.
    #[wasm_bindgen(constructor)]
    pub fn new(
        vehicle_count: u32,
        length: f64,
        heterogeneity: f64,
        seed: u32,
    ) -> Result<RingRoadSim, JsError> {
        let defaults = RingRoadConfig::default();
        let count = vehicle_count as usize;
        if count == 0 || length.is_nan() || length <= 0.0 || length / count as f64 <= defaults.vehicle_length
        {
            return Err(JsError::new("invalid ring configuration: vehicles do not fit"));
        }
        let config = RingRoadConfig {
            vehicle_count: count,
            length,
            heterogeneity: heterogeneity.clamp(0.0, 0.5),
            seed: u64::from(seed),
            ..defaults
        };
        Ok(Self {
            ring: RingRoad::new(config),
        })
    }

    pub fn step(&mut self, steps: u32) {
        self.ring.run(steps as usize);
    }

    pub fn perturb(&mut self, index: u32, speed_factor: f64) {
        self.ring.perturb(index as usize, speed_factor);
    }

    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f64 {
        self.ring.time()
    }

    #[wasm_bindgen(getter, js_name = vehicleCount)]
    pub fn vehicle_count(&self) -> u32 {
        self.ring.vehicle_count() as u32
    }

    #[wasm_bindgen(getter)]
    pub fn length(&self) -> f64 {
        self.ring.config().length
    }

    #[wasm_bindgen(getter, js_name = timeStep)]
    pub fn time_step(&self) -> f64 {
        self.ring.config().time_step
    }

    #[wasm_bindgen(getter, js_name = desiredSpeed)]
    pub fn desired_speed(&self) -> f64 {
        self.ring.config().params.desired_speed
    }

    #[wasm_bindgen(getter, js_name = meanSpeed)]
    pub fn mean_speed(&self) -> f64 {
        self.ring.mean_speed()
    }

    /// Packed `[position, speed]` per vehicle (see [`SNAPSHOT_STRIDE`]).
    pub fn snapshot(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.ring.vehicle_count() * SNAPSHOT_STRIDE);
        for (x, v) in self.ring.positions().iter().zip(self.ring.speeds()) {
            out.push(*x as f32);
            out.push(*v as f32);
        }
        out
    }
}

/// Simulation on an imported road network (network package v1). See `sim-core/README.md` for
/// the configuration keys, the snapshot layout and the signal state encoding.
#[wasm_bindgen]
pub struct NetworkSim {
    sim: Simulation,
}

#[wasm_bindgen]
impl NetworkSim {
    /// Parses the network package and the configuration (`""` or `"{}"` for defaults).
    /// `seed` is a JavaScript `BigInt`.
    #[wasm_bindgen(constructor)]
    pub fn new(package_json: &str, config_json: &str, seed: u64) -> Result<NetworkSim, JsError> {
        Simulation::from_json(package_json, config_json, seed)
            .map(|sim| Self { sim })
            .map_err(|e| JsError::new(&e))
    }

    /// Advances the simulation by `steps` fixed time steps.
    pub fn step(&mut self, steps: u32) {
        self.sim.run(steps as usize);
    }

    /// Simulated time in seconds.
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f64 {
        self.sim.time()
    }

    #[wasm_bindgen(getter, js_name = timeStep)]
    pub fn time_step(&self) -> f64 {
        self.sim.time_step()
    }

    #[wasm_bindgen(getter, js_name = vehicleCount)]
    pub fn vehicle_count(&self) -> u32 {
        self.sim.vehicle_count() as u32
    }

    /// Floats per vehicle in [`Self::snapshot`].
    #[wasm_bindgen(getter, js_name = snapshotStride)]
    pub fn snapshot_stride(&self) -> u32 {
        NETWORK_SNAPSHOT_STRIDE as u32
    }

    /// `Float32Array` with [`NETWORK_SNAPSHOT_STRIDE`] floats per vehicle:
    /// `x, y, z, heading, speed, length, classId, flags, vehicleId`.
    pub fn snapshot(&self) -> Vec<f32> {
        self.sim.snapshot()
    }

    /// Statistics as JSON (`spawned`, `arrived`, `active`, `waitingToEnter`, …).
    #[wasm_bindgen(js_name = statsJson)]
    pub fn stats_json(&self) -> String {
        self.sim.stats_json()
    }

    /// `Uint8Array`, one entry per signal group (order of [`Self::signal_group_ids_json`]):
    /// 0 = red, 1 = amber, 2 = green.
    #[wasm_bindgen(js_name = signalStates)]
    pub fn signal_states(&self) -> Vec<u8> {
        self.sim.signal_states()
    }

    /// JSON array of signal group ids in package order (controllers, then groups).
    #[wasm_bindgen(js_name = signalGroupIdsJson)]
    pub fn signal_group_ids_json(&self) -> String {
        serde_json::to_string(&self.sim.signal_group_ids()).unwrap_or_default()
    }

    /// Sets the arrival rate of an entry (boundary) node in vehicles per hour.
    #[wasm_bindgen(js_name = setDemand)]
    pub fn set_demand(&mut self, node_id: &str, vehicles_per_hour: f64) -> Result<(), JsError> {
        self.sim
            .set_demand(node_id, vehicles_per_hour)
            .map_err(|e| JsError::new(&e))
    }

    /// Current arrival rate of an entry node (vehicles per hour), `undefined` if unknown.
    pub fn demand(&self, node_id: &str) -> Option<f64> {
        self.sim.demand(node_id)
    }

    /// Overrides the routing travel time of a link (seconds) for vehicles generated from now on.
    #[wasm_bindgen(js_name = setLinkTravelTime)]
    pub fn set_link_travel_time(&mut self, link_id: &str, seconds: f64) -> Result<(), JsError> {
        self.sim
            .set_link_travel_time(link_id, seconds)
            .map_err(|e| JsError::new(&e))
    }

    /// Hex checksum of the complete simulation state (determinism checks).
    #[wasm_bindgen(js_name = stateChecksum)]
    pub fn state_checksum(&self) -> String {
        format!("{:016x}", self.sim.state_checksum())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synth::FIXTURE;

    #[test]
    fn network_sim_exposes_the_simulation() {
        let mut sim = NetworkSim::new(FIXTURE, r#"{"defaultDemand": 1800}"#, 42)
            .ok()
            .unwrap();
        sim.step(300);
        assert!((sim.time() - 30.0).abs() < 1e-9);
        assert_eq!(sim.time_step(), 0.1);
        assert!(sim.vehicle_count() > 0);
        assert_eq!(sim.snapshot_stride(), 9);
        assert_eq!(
            sim.snapshot().len(),
            sim.vehicle_count() as usize * NETWORK_SNAPSHOT_STRIDE
        );
        assert!(sim.stats_json().contains("\"spawned\""));
        assert_eq!(sim.signal_states().len(), 2);
        assert_eq!(sim.signal_group_ids_json(), r#"["n0:g0","n0:g1"]"#);
        assert!(sim.set_demand("n1", 100.0).is_ok());
        assert_eq!(sim.demand("n1"), Some(100.0));
        assert!(sim.set_link_travel_time("l2", 20.0).is_ok());
        assert_eq!(sim.state_checksum().len(), 16);
        let again = {
            let mut s = NetworkSim::new(FIXTURE, r#"{"defaultDemand": 1800}"#, 42)
                .ok()
                .unwrap();
            s.step(300);
            s.state_checksum()
        };
        let mut reference = NetworkSim::new(FIXTURE, r#"{"defaultDemand": 1800}"#, 42)
            .ok()
            .unwrap();
        reference.step(300);
        assert_eq!(reference.state_checksum(), again);
    }

    #[test]
    fn snapshot_packs_position_and_speed() {
        let mut sim = RingRoadSim::new(10, 200.0, 0.0, 1).ok().unwrap();
        sim.step(10);
        let snap = sim.snapshot();
        assert_eq!(snap.len(), 10 * SNAPSHOT_STRIDE);
        assert_eq!(sim.vehicle_count(), 10);
        assert!((sim.time() - 1.0).abs() < 1e-9);
        assert!((sim.length() - 200.0).abs() < 1e-9);
        assert!((sim.time_step() - 0.1).abs() < 1e-12);
        assert!(sim.desired_speed() > 0.0);
        assert!(snap.chunks(2).all(|c| c[0] >= 0.0 && c[1] >= 0.0));
        assert!(sim.mean_speed() > 0.0);
    }

    #[test]
    fn perturb_slows_the_vehicle_down() {
        let mut sim = RingRoadSim::new(10, 200.0, 0.0, 1).ok().unwrap();
        let before = sim.snapshot()[1];
        sim.perturb(0, 0.5);
        assert!((sim.snapshot()[1] - before * 0.5).abs() < 1e-5);
    }
}
