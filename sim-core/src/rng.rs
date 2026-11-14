//! Deterministic pseudo-random numbers: PCG32 (PCG-XSH-RR 64/32, O'Neill 2014).
//!
//! Every simulation owns its own generator, seeded explicitly, so identical inputs and seeds
//! produce identical runs (ADR-0007).

const MULTIPLIER: u64 = 6_364_136_223_846_793_005;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pcg32 {
    state: u64,
    increment: u64,
}

impl Pcg32 {
    /// Creates a generator from a seed and a stream id (like `pcg32_srandom_r`).
    pub fn new(seed: u64, stream: u64) -> Self {
        let mut rng = Self {
            state: 0,
            increment: (stream << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed);
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MULTIPLIER).wrapping_add(self.increment);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rotation = (old >> 59) as u32;
        xorshifted.rotate_right(rotation)
    }

    /// Uniform in `[0, 1)` with 53 bits of precision.
    pub fn next_f64(&mut self) -> f64 {
        let high = u64::from(self.next_u32()) >> 6; // 26 bits
        let low = u64::from(self.next_u32()) >> 5; // 27 bits
        ((high << 27) | low) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in `[low, high)`.
    pub fn uniform(&mut self, low: f64, high: f64) -> f64 {
        debug_assert!(low <= high);
        low + (high - low) * self.next_f64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_reference_sequence_of_pcg_c_basic() {
        // Reference output of the pcg32-demo program for seed 42, stream 54.
        let mut rng = Pcg32::new(42, 54);
        let expected = [
            0xa15c_02b7_u32,
            0x7b47_f409,
            0xba1d_3330,
            0x83d2_f293,
            0xbfa4_784b,
            0xcbed_606e,
        ];
        for value in expected {
            assert_eq!(rng.next_u32(), value);
        }
    }

    #[test]
    fn same_seed_gives_same_sequence() {
        let mut a = Pcg32::new(7, 1);
        let mut b = Pcg32::new(7, 1);
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn different_seeds_or_streams_diverge() {
        let first = |seed, stream| Pcg32::new(seed, stream).next_u32();
        assert_ne!(first(1, 1), first(2, 1));
        assert_ne!(first(1, 1), first(1, 2));
    }

    #[test]
    fn floats_are_in_unit_interval_and_roughly_uniform() {
        let mut rng = Pcg32::new(123, 0);
        let n = 100_000;
        let mut sum = 0.0;
        for _ in 0..n {
            let x = rng.next_f64();
            assert!((0.0..1.0).contains(&x));
            sum += x;
        }
        let mean = sum / f64::from(n);
        assert!((mean - 0.5).abs() < 0.01, "mean {mean}");
    }

    #[test]
    fn uniform_respects_bounds() {
        let mut rng = Pcg32::new(5, 5);
        for _ in 0..10_000 {
            let x = rng.uniform(-2.0, 3.0);
            assert!((-2.0..3.0).contains(&x));
        }
    }
}
