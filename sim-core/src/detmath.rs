//! Platform-independent math for simulation state.
//!
//! `f64::ln`, `powf` and friends call the platform's libm, whose last-bit results may differ
//! between native targets and WebAssembly. Everything that feeds simulation *state* uses only
//! IEEE-754 basic operations (+, −, ×, ÷, √), which are exactly rounded everywhere.

const LN_2: f64 = std::f64::consts::LN_2;

/// Natural logarithm from basic operations only (error below 1e-15 relative).
/// Returns `-inf` for 0 and NaN for negative or NaN input.
pub fn ln(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return f64::NEG_INFINITY;
    }
    if x.is_infinite() {
        return f64::INFINITY;
    }
    let (mut x, mut exponent) = (x, 0i64);
    if x < f64::MIN_POSITIVE {
        x *= (1u64 << 54) as f64;
        exponent -= 54;
    }
    let bits = x.to_bits();
    exponent += ((bits >> 52) & 0x7ff) as i64 - 1023;
    // Mantissa in [1, 2), then shifted into [sqrt(1/2), sqrt(2)).
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > std::f64::consts::SQRT_2 {
        m *= 0.5;
        exponent += 1;
    }
    // ln(m) = 2 atanh(z), z = (m - 1) / (m + 1), |z| <= 0.172.
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut term = z;
    let mut sum = 0.0;
    let mut k = 1.0;
    for _ in 0..14 {
        sum += term / k;
        term *= z2;
        k += 2.0;
    }
    2.0 * sum + exponent as f64 * LN_2
}

/// `x^delta` using repeated multiplication for small integer exponents (the IDM default δ = 4)
/// and `powf` otherwise.
pub fn pow_delta(x: f64, delta: f64) -> f64 {
    if delta == 4.0 {
        let x2 = x * x;
        return x2 * x2;
    }
    if delta.fract() == 0.0 && (1.0..=8.0).contains(&delta) {
        let mut r = x;
        for _ in 1..delta as u32 {
            r *= x;
        }
        return r;
    }
    x.powf(delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ln_matches_std_closely() {
        let mut x = 1e-300;
        while x < 1e300 {
            for f in [1.0, 1.3, 1.5, 1.9, 2.7] {
                let v = x * f;
                let rel = (ln(v) - v.ln()).abs() / v.ln().abs().max(1.0);
                assert!(rel < 1e-14, "ln({v}) = {} vs {}", ln(v), v.ln());
            }
            x *= 1e7;
        }
        assert_eq!(ln(1.0), 0.0);
        assert!((ln(std::f64::consts::E) - 1.0).abs() < 1e-15);
    }

    #[test]
    fn ln_special_values() {
        assert!(ln(-1.0).is_nan());
        assert!(ln(f64::NAN).is_nan());
        assert_eq!(ln(0.0), f64::NEG_INFINITY);
        assert_eq!(ln(f64::INFINITY), f64::INFINITY);
        let tiny = f64::MIN_POSITIVE / 1024.0;
        assert!((ln(tiny) - tiny.ln()).abs() < 1e-12);
    }

    #[test]
    fn pow_delta_matches_powf() {
        for x in [0.0, 0.3, 0.9, 1.0, 1.4] {
            for d in [1.0, 2.0, 3.0, 4.0, 5.0, 2.5] {
                assert!((pow_delta(x, d) - f64::powf(x, d)).abs() < 1e-12, "{x}^{d}");
            }
        }
    }
}
