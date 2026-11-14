//! WebAssembly bindings used by the browser simulation worker (ADR-0006).
//!
//! The boundary is coarse-grained: the worker calls `step(n)` once per frame and reads one
//! packed snapshot buffer.

use wasm_bindgen::prelude::*;

use crate::ring::{RingRoad, RingRoadConfig};

/// Floats per vehicle in [`RingRoadSim::snapshot`]: position (m), speed (m/s).
pub const SNAPSHOT_STRIDE: usize = 2;

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

#[cfg(test)]
mod tests {
    use super::*;

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
