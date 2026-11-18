//! The arithmetic the evaluator's operations are built from: units, durations and complex numbers.

use std::cmp::Ordering;

use json_shape::Map;

use crate::computed_value::{DurationUnit, Unit};

/// A unit with every zero exponent dropped, so that dividing a unit by itself is the same dimensionless unit as no unit.
/// An absent unit is the empty one.
fn normalise_unit(unit: Option<&Unit>) -> Vec<(String, f64)> {
    unit.map_or_else(Vec::new, |unit| {
        unit.0
            .iter()
            .filter(|(_, exponent)| *exponent != 0.0)
            .cloned()
            .collect()
    })
}

/// Whether two units are the same dimension, an absent unit being dimensionless.
pub(crate) fn units_equal(left: Option<&Unit>, right: Option<&Unit>) -> bool {
    let left = normalise_unit(left);
    let right = normalise_unit(right);
    left.len() == right.len()
        && left.iter().all(|(dimension, exponent)| {
            right
                .iter()
                .any(|(other, value)| other == dimension && value == exponent)
        })
}

/// Whether a unit is dimensionless.
pub(crate) fn is_dimensionless(unit: Option<&Unit>) -> bool {
    units_equal(unit, None)
}

/// The unit of a product (`sign` 1) or a quotient (`sign` -1): the exponents of `right` added to or subtracted from
/// those of `left`, dimension by dimension, in the order the dimensions first appear, with zeros dropped.
fn combine_units(left: Option<&Unit>, right: Option<&Unit>, sign: f64) -> Unit {
    let mut combined = normalise_unit(left);
    for (dimension, exponent) in normalise_unit(right) {
        match combined.iter_mut().find(|(name, _)| *name == dimension) {
            Some((_, value)) => *value += sign * exponent,
            None => combined.push((dimension, sign * exponent)),
        }
    }
    let unit = Map(combined);
    Map(normalise_unit(Some(&unit)))
}

/// The unit of a product.
pub(crate) fn multiply_units(left: Option<&Unit>, right: Option<&Unit>) -> Unit {
    combine_units(left, right, 1.0)
}

/// The unit of a quotient.
pub(crate) fn divide_units(left: Option<&Unit>, right: Option<&Unit>) -> Unit {
    combine_units(left, right, -1.0)
}

/// How many milliseconds one of each duration unit is. Every unit is a whole multiple of every finer one.
pub(crate) fn milliseconds_per(unit: DurationUnit) -> u64 {
    match unit {
        DurationUnit::Ms => 1,
        DurationUnit::S => 1_000,
        DurationUnit::Min => 60_000,
        DurationUnit::H => 3_600_000,
        DurationUnit::D => 86_400_000,
    }
}

/// A duration's magnitude in milliseconds, by multiplying, which overflows for very large spans: arithmetic on
/// durations uses it, comparison does not.
pub(crate) fn to_milliseconds(value: f64, unit: DurationUnit) -> f64 {
    #[allow(
        clippy::cast_precision_loss,
        reason = "the sizes are at most 86,400,000, which a double holds exactly"
    )]
    let size = milliseconds_per(unit) as f64;
    value * size
}

/// A finite, non-negative double as `significand * 2^exponent` with an integer significand, read from its bits.
fn exact_parts(magnitude: f64) -> (u128, i32) {
    let bits = magnitude.to_bits();
    // Eleven bits, so the cast is exact.
    let exponent_field = ((bits >> 52) & 0x7ff) as i32;
    let fraction = u128::from(bits & ((1_u64 << 52) - 1));
    if exponent_field == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1_u128 << 52), exponent_field - 1075)
    }
}

/// The order of `left << shift` and `right`, for products of a significand and a unit's size (each below 2^81).
fn shifted_order(left: u128, shift: u32, right: u128) -> Ordering {
    if left == 0 || right == 0 {
        return left.cmp(&right);
    }
    let left_bits = 128 - left.leading_zeros();
    let right_bits = 128 - right.leading_zeros();
    // A shifted value of more bits than `right` has is the larger, and one that would not fit in 128 bits has more.
    if left_bits + shift > right_bits {
        return Ordering::Greater;
    }
    (left << shift).cmp(&right)
}

/// The exact order of `left * left_size` and `right * right_size` for finite doubles of the same sign.
fn exact_order(left: f64, left_size: u64, right: f64, right_size: u64) -> Ordering {
    let (left_significand, left_exponent) = exact_parts(left.abs());
    let (right_significand, right_exponent) = exact_parts(right.abs());
    let left_product = left_significand * u128::from(left_size);
    let right_product = right_significand * u128::from(right_size);
    let shift = left_exponent - right_exponent;
    let magnitude_order = if shift >= 0 {
        shifted_order(left_product, shift.unsigned_abs(), right_product)
    } else {
        shifted_order(right_product, shift.unsigned_abs(), left_product).reverse()
    };
    // Of two negative numbers, the one with the larger magnitude is the smaller.
    if left < 0.0 {
        magnitude_order.reverse()
    } else {
        magnitude_order
    }
}

/// The order of two durations, or `None` when a NaN leaves them unordered.
///
/// A value that is not finite is ordered as a number is, since a unit only scales by a positive amount. Two finite
/// durations are ordered exactly: both are divided into the coarser unit, which is correctly rounded and monotone, so
/// differing quotients give the true order; equal quotients are settled from the doubles' binary expansions, comparing
/// each value times its unit's size in milliseconds as integers. Multiplying into milliseconds instead would overflow.
pub(crate) fn compare_durations(
    left: f64,
    left_unit: DurationUnit,
    right: f64,
    right_unit: DurationUnit,
) -> Option<Ordering> {
    if left.is_nan() || right.is_nan() {
        return None;
    }
    if !left.is_finite() || !right.is_finite() {
        return left.partial_cmp(&right);
    }
    let left_size = milliseconds_per(left_unit);
    let right_size = milliseconds_per(right_unit);
    let shared = left_size.max(right_size);
    #[allow(
        clippy::cast_precision_loss,
        reason = "the ratios of the sizes are at most 86,400,000, which a double holds exactly"
    )]
    let (left_ratio, right_ratio) = ((shared / left_size) as f64, (shared / right_size) as f64);
    let left_shared = left / left_ratio;
    let right_shared = right / right_ratio;
    if left_shared < right_shared {
        return Some(Ordering::Less);
    }
    if left_shared > right_shared {
        return Some(Ordering::Greater);
    }
    let left_sign = sign_of(left);
    let right_sign = sign_of(right);
    if left_sign != right_sign {
        return Some(left_sign.cmp(&right_sign));
    }
    if left_sign == 0 {
        return Some(Ordering::Equal);
    }
    Some(exact_order(left, left_size, right, right_size))
}

/// -1, 0 or 1, both zeros being 0.
fn sign_of(value: f64) -> i8 {
    if value > 0.0 {
        1
    } else if value < 0.0 {
        -1
    } else {
        0
    }
}

/// `value * 2^exponent`, applied in two halves because `2^exponent` alone is infinite beyond 1023 and a quotient can
/// need a shift of about twice that.
fn scale_by_power_of_two(value: f64, exponent: i32) -> f64 {
    let first = exponent / 2;
    value * 2_f64.powi(first) * 2_f64.powi(exponent - first)
}

/// The exponent of the power of two that brings a non-zero magnitude to between a quarter and a half.
fn scale_to_about_a_quarter(larger: f64) -> i32 {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the binary logarithm of a finite non-zero double lies within -1075 and 1024"
    )]
    let floor = larger.log2().floor() as i32;
    -floor - 2
}

/// The components of `dividend / divisor` for a non-zero divisor, with both operands scaled by powers of two so that
/// the conjugate formula neither overflows nor underflows, and the scale applied once at the end. A zero dividend
/// gives zero in both components.
pub(crate) fn divide_complex(dividend: (f64, f64), divisor: (f64, f64)) -> (f64, f64) {
    let larger_dividend = dividend.0.abs().max(dividend.1.abs());
    if larger_dividend == 0.0 {
        return (0.0, 0.0);
    }
    let larger_divisor = divisor.0.abs().max(divisor.1.abs());
    let dividend_scale = scale_to_about_a_quarter(larger_dividend);
    let divisor_scale = scale_to_about_a_quarter(larger_divisor);
    let a = scale_by_power_of_two(dividend.0, dividend_scale);
    let b = scale_by_power_of_two(dividend.1, dividend_scale);
    let c = scale_by_power_of_two(divisor.0, divisor_scale);
    let d = scale_by_power_of_two(divisor.1, divisor_scale);
    let denominator = c * c + d * d;
    let shift = divisor_scale - dividend_scale;
    (
        scale_by_power_of_two((a * c + b * d) / denominator, shift),
        scale_by_power_of_two((b * c - a * d) / denominator, shift),
    )
}

/// `base` raised to a non-negative integer `exponent` by squaring: one squaring and at most one product per bit of
/// the exponent, the last squaring skipped. Halving with `floor` and testing oddness with `%` are exact for every
/// finite double, including those past the largest safe integer.
pub(crate) fn power_by_squaring<T: Clone>(
    base: T,
    exponent: f64,
    identity: T,
    multiply: impl Fn(&T, &T) -> T,
) -> T {
    let mut result = identity;
    let mut factor = base;
    let mut remaining = exponent;
    while remaining > 0.0 {
        if remaining % 2.0 == 1.0 {
            result = multiply(&result, &factor);
        }
        remaining = (remaining / 2.0).floor();
        if remaining > 0.0 {
            factor = multiply(&factor, &factor);
        }
    }
    result
}

/// Whether a double is an integer, as `Number.isInteger` decides it.
pub(crate) fn is_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::{compare_durations, divide_complex};
    use crate::computed_value::DurationUnit;

    #[test]
    fn durations_are_ordered_exactly_where_dividing_into_one_unit_loses_the_difference() {
        // 1e300 days overflows when multiplied into milliseconds, and is still ordered against milliseconds.
        assert_eq!(
            compare_durations(1e300, DurationUnit::D, f64::MAX, DurationUnit::Ms),
            Some(Ordering::Less)
        );
        // The smallest subnormal of milliseconds rounds to zero in days, and is still greater than zero days.
        assert_eq!(
            compare_durations(5e-324, DurationUnit::Ms, 0.0, DurationUnit::D),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_durations(-5e-324, DurationUnit::Ms, -0.0, DurationUnit::D),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_durations(60_000.0, DurationUnit::Ms, 1.0, DurationUnit::Min),
            Some(Ordering::Equal)
        );
        assert_eq!(
            compare_durations(f64::NAN, DurationUnit::Ms, 1.0, DurationUnit::Min),
            None
        );
    }

    #[test]
    fn a_complex_quotient_neither_overflows_nor_underflows_on_the_way() {
        assert_eq!(divide_complex((8.0, 0.0), (1.0, 0.0)), (8.0, 0.0));
        assert_eq!(divide_complex((1e308, 1e308), (1e308, 1e308)), (1.0, 0.0));
        assert_eq!(divide_complex((0.0, 0.0), (3.0, 4.0)), (0.0, 0.0));
    }
}
