//! The node rules that combine values that are already evaluated: the three-valued connectives, comparison, text
//! comparison, membership, negation and arithmetic. None of them consults a resolver.

use std::cmp::Ordering;

use crate::computed_value::{ComputedValue, DurationUnit, Unit};
use crate::evaluation::{IndeterminateCode, IndeterminateReason};
use crate::tree::{ArithmeticOperator, ComparisonOperator, TextComparisonOperator};

use super::instant;
use super::numeric::{
    compare_durations, divide_complex, divide_units, is_dimensionless, is_integer, multiply_units,
    power_by_squaring, to_milliseconds, units_equal,
};
use super::regex::EcmaScriptRegex;

/// Why an evaluation is indeterminate, and whether the reason is an exhausted resource limit, which `exists`
/// propagates instead of reading as "the value resolved". The flag travels with the reason wherever a node forwards
/// it, as the identity of the reason object does in the TypeScript implementation.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Reason {
    pub(crate) reason: IndeterminateReason,
    pub(crate) exhausted: bool,
}

/// A definite value, or why there is none.
pub(crate) type Outcome<T> = Result<T, Reason>;

pub(crate) fn indeterminate<T>(code: IndeterminateCode, message: impl Into<String>) -> Outcome<T> {
    Err(Reason {
        reason: IndeterminateReason {
            code,
            message: message.into(),
        },
        exhausted: false,
    })
}

pub(crate) fn wrong_type<T>(message: impl Into<String>) -> Outcome<T> {
    indeterminate(IndeterminateCode::WrongType, message)
}

pub(crate) fn domain_error<T>(message: impl Into<String>) -> Outcome<T> {
    indeterminate(IndeterminateCode::DomainError, message)
}

/// The indeterminate result for an exhausted resource limit.
pub(crate) fn exhausted<T>(message: impl Into<String>) -> Outcome<T> {
    Err(Reason {
        reason: IndeterminateReason {
            code: IndeterminateCode::DomainError,
            message: message.into(),
        },
        exhausted: true,
    })
}

/// The tie-break rule: the first indeterminate reason in the node's declared operand order, except that a
/// `not-yet-known` reason outranks every other, because the operand it belongs to may still settle as an absorbing
/// value.
pub(crate) fn first_indeterminate<'a, T: 'a>(
    outcomes: impl IntoIterator<Item = &'a Outcome<T>>,
) -> Option<Reason> {
    let mut first: Option<&Reason> = None;
    for outcome in outcomes {
        if let Err(reason) = outcome {
            if reason.reason.code == IndeterminateCode::NotYetKnown {
                return Some(reason.clone());
            }
            first = first.or(Some(reason));
        }
    }
    first.cloned()
}

/// The three-valued AND: a definite `false` absorbs any indeterminacy.
pub(crate) fn combine_and(left: &Outcome<bool>, right: &Outcome<bool>) -> Outcome<bool> {
    if matches!(left, Ok(false)) || matches!(right, Ok(false)) {
        return Ok(false);
    }
    first_indeterminate([left, right]).map_or(Ok(true), Err)
}

/// The three-valued OR: a definite `true` absorbs any indeterminacy.
pub(crate) fn combine_or(left: &Outcome<bool>, right: &Outcome<bool>) -> Outcome<bool> {
    if matches!(left, Ok(true)) || matches!(right, Ok(true)) {
        return Ok(true);
    }
    first_indeterminate([left, right]).map_or(Ok(false), Err)
}

/// The name of a value's kind, as messages give it.
pub(crate) fn kind_name(value: &ComputedValue) -> &'static str {
    match value {
        ComputedValue::Number { .. } => "number",
        ComputedValue::Text { .. } => "text",
        ComputedValue::Boolean { .. } => "boolean",
        ComputedValue::Instant { .. } => "instant",
        ComputedValue::Duration { .. } => "duration",
        ComputedValue::Complex { .. } => "complex",
    }
}

fn comparison_name(op: ComparisonOperator) -> &'static str {
    match op {
        ComparisonOperator::Gt => "gt",
        ComparisonOperator::Gte => "gte",
        ComparisonOperator::Lt => "lt",
        ComparisonOperator::Lte => "lte",
        ComparisonOperator::Eq => "eq",
        ComparisonOperator::Neq => "neq",
    }
}

fn arithmetic_name(op: ArithmeticOperator) -> &'static str {
    match op {
        ArithmeticOperator::Add => "add",
        ArithmeticOperator::Subtract => "subtract",
        ArithmeticOperator::Multiply => "multiply",
        ArithmeticOperator::Divide => "divide",
        ArithmeticOperator::Power => "power",
        ArithmeticOperator::Modulo => "modulo",
    }
}

/// The operator applied to two numbers, with IEEE 754 semantics: every comparison with a NaN is false except `neq`.
fn apply_comparison(op: ComparisonOperator, left: f64, right: f64) -> bool {
    match op {
        ComparisonOperator::Gt => left > right,
        ComparisonOperator::Gte => left >= right,
        ComparisonOperator::Lt => left < right,
        ComparisonOperator::Lte => left <= right,
        ComparisonOperator::Eq => left == right,
        ComparisonOperator::Neq => left != right,
    }
}

fn unparseable_instant<T>(value: &str) -> Outcome<T> {
    wrong_type(format!("'{value}' is not a parseable ISO-8601 timestamp"))
}

fn epoch_of(value: &str) -> Outcome<f64> {
    instant::parse(value).map_or_else(|| unparseable_instant(value), Ok)
}

fn instant_from_epoch(epoch: f64) -> Outcome<ComputedValue> {
    instant::format(epoch).map_or_else(
        || domain_error("the resulting instant falls outside the representable timestamp range"),
        |value| Ok(ComputedValue::Instant { value }),
    )
}

/// `compare`: two numbers of one unit, two instants by their epoch milliseconds, two durations in whatever units they
/// carry, two booleans or two complex values for equality only. Text is never compared here, and any other pairing
/// is `wrong-type`.
pub(crate) fn compare_values(
    op: ComparisonOperator,
    left: &ComputedValue,
    right: &ComputedValue,
) -> Outcome<bool> {
    let mismatch = |article: &str, kind: &str| {
        wrong_type(format!(
            "cannot compare {article} '{kind}' value with a '{}' value",
            kind_name(right)
        ))
    };
    match left {
        ComputedValue::Number { value, unit } => {
            let ComputedValue::Number {
                value: other,
                unit: other_unit,
            } = right
            else {
                return mismatch("a", "number");
            };
            if !units_equal(unit.as_ref(), other_unit.as_ref()) {
                return wrong_type("cannot compare numbers with incompatible units");
            }
            Ok(apply_comparison(op, *value, *other))
        }
        ComputedValue::Text { .. } => {
            wrong_type("text values are not comparable via 'compare'; use 'textCompare'")
        }
        ComputedValue::Boolean { value } => {
            let ComputedValue::Boolean { value: other } = right else {
                return mismatch("a", "boolean");
            };
            match op {
                ComparisonOperator::Eq => Ok(value == other),
                ComparisonOperator::Neq => Ok(value != other),
                _ => wrong_type(format!(
                    "booleans have no natural ordering; '{}' is only defined for 'eq'/'neq'",
                    comparison_name(op)
                )),
            }
        }
        ComputedValue::Instant { value } => {
            let ComputedValue::Instant { value: other } = right else {
                return mismatch("an", "instant");
            };
            let left_epoch = epoch_of(value)?;
            let right_epoch = epoch_of(other)?;
            Ok(apply_comparison(op, left_epoch, right_epoch))
        }
        ComputedValue::Duration { value, unit } => {
            let ComputedValue::Duration {
                value: other,
                unit: other_unit,
            } = right
            else {
                return mismatch("a", "duration");
            };
            // The order compared with zero applies the operator to the durations; a NaN leaves them unordered.
            let order = match compare_durations(*value, *unit, *other, *other_unit) {
                Some(Ordering::Less) => -1.0,
                Some(Ordering::Equal) => 0.0,
                Some(Ordering::Greater) => 1.0,
                None => f64::NAN,
            };
            Ok(apply_comparison(op, order, 0.0))
        }
        ComputedValue::Complex { re, im, unit } => {
            if !matches!(op, ComparisonOperator::Eq | ComparisonOperator::Neq) {
                return wrong_type(format!(
                    "ordering operator '{}' is not defined for complex values; the complex plane has no total order",
                    comparison_name(op)
                ));
            }
            let ComputedValue::Complex {
                re: other_re,
                im: other_im,
                unit: other_unit,
            } = right
            else {
                return mismatch("a", "complex");
            };
            if !units_equal(unit.as_ref(), other_unit.as_ref()) {
                return wrong_type("cannot compare complex values with incompatible units");
            }
            let equal = re == other_re && im == other_im;
            Ok(if op == ComparisonOperator::Eq {
                equal
            } else {
                !equal
            })
        }
    }
}

/// `textCompare`: both operands must be text. `equals` and `notEquals` are exact equality, `matches` and `notMatches`
/// read the right text as an ECMAScript regular expression through `regex`, and `portableMatches` and
/// `portableNotMatches` read it in trilean-regex's portable grammar.
pub(crate) fn compare_text(
    op: TextComparisonOperator,
    left: &ComputedValue,
    right: &ComputedValue,
    regex: &dyn EcmaScriptRegex,
) -> Outcome<bool> {
    let ComputedValue::Text { value: text } = left else {
        return wrong_type(format!(
            "'textCompare' requires 'text' operands; the left operand is '{}'",
            kind_name(left)
        ));
    };
    let ComputedValue::Text { value: pattern } = right else {
        return wrong_type(format!(
            "'textCompare' requires 'text' operands; the right operand is '{}'",
            kind_name(right)
        ));
    };
    match op {
        TextComparisonOperator::Equals => Ok(text == pattern),
        TextComparisonOperator::NotEquals => Ok(text != pattern),
        TextComparisonOperator::Matches | TextComparisonOperator::NotMatches => {
            let is_match = regex.test(pattern, text).map_err(|reason| Reason {
                reason,
                exhausted: false,
            })?;
            Ok(is_match == (op == TextComparisonOperator::Matches))
        }
        TextComparisonOperator::PortableMatches | TextComparisonOperator::PortableNotMatches => {
            let compiled = trilean_regex::compile_pattern(pattern).or_else(|error| {
                wrong_type(format!(
                    "'{pattern}' is not a valid trilean-regex pattern: {error}"
                ))
            })?;
            let is_match = compiled.test(text).or_else(|error| {
                domain_error(format!(
                    "the text cannot be tested against '{pattern}': {error}"
                ))
            })?;
            Ok(is_match == (op == TextComparisonOperator::PortableMatches))
        }
    }
}

/// `memberOf`'s equality of an operand and a candidate, across every kind: a kind mismatch, or numbers or complex
/// values of incompatible units, is `wrong-type` and never simply "not equal".
pub(crate) fn membership_match(
    operand: &ComputedValue,
    candidate: &ComputedValue,
) -> Outcome<bool> {
    let mismatch = |article: &str, kind: &str| {
        wrong_type(format!(
            "cannot compare {article} '{kind}' value with a '{}' value for membership",
            kind_name(candidate)
        ))
    };
    match (operand, candidate) {
        (
            ComputedValue::Number { value, unit },
            ComputedValue::Number {
                value: other,
                unit: other_unit,
            },
        ) => {
            if !units_equal(unit.as_ref(), other_unit.as_ref()) {
                return wrong_type("cannot compare numbers with incompatible units for membership");
            }
            Ok(value == other)
        }
        (ComputedValue::Number { .. }, _) => mismatch("a", "number"),
        (ComputedValue::Text { value }, ComputedValue::Text { value: other }) => Ok(value == other),
        (ComputedValue::Text { .. }, _) => mismatch("a", "text"),
        (ComputedValue::Boolean { value }, ComputedValue::Boolean { value: other }) => {
            Ok(value == other)
        }
        (ComputedValue::Boolean { .. }, _) => mismatch("a", "boolean"),
        (ComputedValue::Instant { value }, ComputedValue::Instant { value: other }) => {
            let left = epoch_of(value)?;
            let right = epoch_of(other)?;
            Ok(left == right)
        }
        (ComputedValue::Instant { .. }, _) => mismatch("an", "instant"),
        (
            ComputedValue::Duration { value, unit },
            ComputedValue::Duration {
                value: other,
                unit: other_unit,
            },
        ) => Ok(compare_durations(*value, *unit, *other, *other_unit) == Some(Ordering::Equal)),
        (ComputedValue::Duration { .. }, _) => mismatch("a", "duration"),
        (
            ComputedValue::Complex { re, im, unit },
            ComputedValue::Complex {
                re: other_re,
                im: other_im,
                unit: other_unit,
            },
        ) => {
            if !units_equal(unit.as_ref(), other_unit.as_ref()) {
                return wrong_type(
                    "cannot compare complex values with incompatible units for membership",
                );
            }
            Ok(re == other_re && im == other_im)
        }
        (ComputedValue::Complex { .. }, _) => mismatch("a", "complex"),
    }
}

/// `negate`: a number, a duration in its own unit, or both parts of a complex value. It is never "zero minus".
pub(crate) fn negate(operand: &ComputedValue) -> Outcome<ComputedValue> {
    match operand {
        ComputedValue::Number { value, unit } => Ok(ComputedValue::Number {
            value: -value,
            unit: unit.clone(),
        }),
        ComputedValue::Duration { value, unit } => Ok(ComputedValue::Duration {
            value: -value,
            unit: *unit,
        }),
        ComputedValue::Complex { re, im, unit } => Ok(ComputedValue::Complex {
            re: -re,
            im: -im,
            unit: unit.clone(),
        }),
        ComputedValue::Text { .. }
        | ComputedValue::Instant { .. }
        | ComputedValue::Boolean { .. } => {
            wrong_type(format!("cannot negate a '{}' value", kind_name(operand)))
        }
    }
}

fn arithmetic_on_numbers(
    op: ArithmeticOperator,
    left: f64,
    left_unit: Option<&Unit>,
    right: f64,
    right_unit: Option<&Unit>,
) -> Outcome<ComputedValue> {
    let number = |value: f64, unit: Option<Unit>| Ok(ComputedValue::Number { value, unit });
    match op {
        ArithmeticOperator::Add | ArithmeticOperator::Subtract => {
            if !units_equal(left_unit, right_unit) {
                return wrong_type(format!(
                    "cannot {} numbers with incompatible units",
                    arithmetic_name(op)
                ));
            }
            let value = if op == ArithmeticOperator::Add {
                left + right
            } else {
                left - right
            };
            number(value, left_unit.cloned())
        }
        ArithmeticOperator::Multiply => {
            number(left * right, Some(multiply_units(left_unit, right_unit)))
        }
        ArithmeticOperator::Divide => {
            if right == 0.0 {
                return domain_error("division by zero");
            }
            number(left / right, Some(divide_units(left_unit, right_unit)))
        }
        ArithmeticOperator::Power => {
            if !is_dimensionless(left_unit) || !is_dimensionless(right_unit) {
                return wrong_type("'power' requires dimensionless operands");
            }
            if left < 0.0 && !is_integer(right) {
                return domain_error(
                    "a negative base raised to a non-integer power is not a real number",
                );
            }
            if left == 0.0 && right < 0.0 {
                return domain_error("zero raised to a negative power is a division by zero");
            }
            number(ecmascript_power(left, right), None)
        }
        ArithmeticOperator::Modulo => {
            if !is_dimensionless(left_unit) || !is_dimensionless(right_unit) {
                return wrong_type("'modulo' requires dimensionless operands");
            }
            if right == 0.0 {
                return domain_error("modulo by zero");
            }
            number(left % right, None)
        }
    }
}

/// ECMAScript's `**`, which differs from IEEE 754 `pow` in one place: a base of magnitude one raised to an infinite
/// exponent is NaN, where `pow` gives 1.
fn ecmascript_power(base: f64, exponent: f64) -> f64 {
    if exponent.is_nan() || (base.abs() == 1.0 && exponent.is_infinite()) {
        return f64::NAN;
    }
    base.powf(exponent)
}

fn arithmetic_on_durations(
    op: ArithmeticOperator,
    left: f64,
    left_unit: DurationUnit,
    right: f64,
    right_unit: DurationUnit,
) -> Outcome<ComputedValue> {
    let left = to_milliseconds(left, left_unit);
    let right = to_milliseconds(right, right_unit);
    match op {
        ArithmeticOperator::Add => Ok(ComputedValue::Duration {
            value: left + right,
            unit: DurationUnit::Ms,
        }),
        ArithmeticOperator::Subtract => Ok(ComputedValue::Duration {
            value: left - right,
            unit: DurationUnit::Ms,
        }),
        _ => wrong_type(format!(
            "arithmetic operator '{}' is not defined between two 'duration' values",
            arithmetic_name(op)
        )),
    }
}

/// A complex value as its parts and unit.
#[derive(Clone)]
struct Complex {
    re: f64,
    im: f64,
    unit: Option<Unit>,
}

impl Complex {
    fn into_value(self) -> ComputedValue {
        ComputedValue::Complex {
            re: self.re,
            im: self.im,
            unit: self.unit,
        }
    }
}

/// A number or complex value as a complex one: a real number is promoted with a zero imaginary part.
fn as_complex(value: &ComputedValue) -> Option<Complex> {
    match value {
        ComputedValue::Number { value, unit } => Some(Complex {
            re: *value,
            im: 0.0,
            unit: unit.clone(),
        }),
        ComputedValue::Complex { re, im, unit } => Some(Complex {
            re: *re,
            im: *im,
            unit: unit.clone(),
        }),
        _ => None,
    }
}

fn multiply_complex(left: &Complex, right: &Complex) -> Complex {
    Complex {
        re: left.re * right.re - left.im * right.im,
        im: left.re * right.im + left.im * right.re,
        unit: Some(multiply_units(left.unit.as_ref(), right.unit.as_ref())),
    }
}

fn reciprocal(value: &Complex) -> Complex {
    let (re, im) = divide_complex((1.0, 0.0), (value.re, value.im));
    Complex {
        re,
        im,
        unit: Some(divide_units(
            Some(&trilean_json_shape::Map(Vec::new())),
            value.unit.as_ref(),
        )),
    }
}

/// Complex arithmetic over the rectangular form, a real operand promoted. `power` keeps its exponent an unpromoted
/// real number, so it reads the operands as they were given.
fn arithmetic_on_complex(
    op: ArithmeticOperator,
    left_value: &ComputedValue,
    right_value: &ComputedValue,
) -> Outcome<ComputedValue> {
    let (Some(left), Some(right)) = (as_complex(left_value), as_complex(right_value)) else {
        return wrong_type("arithmetic requires numeric operands");
    };
    match op {
        ArithmeticOperator::Add | ArithmeticOperator::Subtract => {
            if !units_equal(left.unit.as_ref(), right.unit.as_ref()) {
                return wrong_type(format!(
                    "cannot {} complex values with incompatible units",
                    arithmetic_name(op)
                ));
            }
            let (re, im) = if op == ArithmeticOperator::Add {
                (left.re + right.re, left.im + right.im)
            } else {
                (left.re - right.re, left.im - right.im)
            };
            Ok(ComputedValue::Complex {
                re,
                im,
                unit: left.unit,
            })
        }
        ArithmeticOperator::Multiply => Ok(multiply_complex(&left, &right).into_value()),
        ArithmeticOperator::Divide => {
            // Zero is the one complex value with no reciprocal, and it is zero in both parts.
            if right.re == 0.0 && right.im == 0.0 {
                return domain_error("division by zero");
            }
            let (re, im) = divide_complex((left.re, left.im), (right.re, right.im));
            Ok(ComputedValue::Complex {
                re,
                im,
                unit: Some(divide_units(left.unit.as_ref(), right.unit.as_ref())),
            })
        }
        // A remainder needs an order to say how many whole divisors fit, and the complex plane has none.
        ArithmeticOperator::Modulo => domain_error("'modulo' is undefined for complex values"),
        ArithmeticOperator::Power => power_with_complex(left_value, right_value),
    }
}

/// `power` with a complex operand: defined only for a real integer exponent, computed by squaring. A negative exponent
/// is the reciprocal of the positive power when that is finite and non-zero, and otherwise the positive power of the
/// reciprocal, which stays representable where the positive power does not.
fn power_with_complex(base: &ComputedValue, exponent: &ComputedValue) -> Outcome<ComputedValue> {
    let ComputedValue::Number {
        value: exponent_value,
        unit: exponent_unit,
    } = exponent
    else {
        return wrong_type("'power' with a complex operand requires a real integer exponent");
    };
    if !is_integer(*exponent_value) {
        return wrong_type("'power' with a complex operand requires a real integer exponent");
    }
    let Some(base) = as_complex(base) else {
        return wrong_type("'power' with a complex operand requires a real integer exponent");
    };
    if !is_dimensionless(base.unit.as_ref()) || !is_dimensionless(exponent_unit.as_ref()) {
        return wrong_type("'power' requires dimensionless operands");
    }
    let identity = Complex {
        re: 1.0,
        im: 0.0,
        unit: Some(trilean_json_shape::Map(Vec::new())),
    };
    if *exponent_value >= 0.0 {
        return Ok(
            power_by_squaring(base, *exponent_value, identity, multiply_complex).into_value(),
        );
    }
    if base.re == 0.0 && base.im == 0.0 {
        return domain_error("division by zero");
    }
    let positive = power_by_squaring(
        base.clone(),
        -exponent_value,
        identity.clone(),
        multiply_complex,
    );
    let larger = positive.re.abs().max(positive.im.abs());
    if larger.is_finite() && larger > 0.0 {
        return Ok(reciprocal(&positive).into_value());
    }
    Ok(power_by_squaring(
        reciprocal(&base),
        -exponent_value,
        identity,
        multiply_complex,
    )
    .into_value())
}

fn arithmetic_by_kind(
    op: ArithmeticOperator,
    left: &ComputedValue,
    right: &ComputedValue,
) -> Outcome<ComputedValue> {
    use ComputedValue::{Complex as ComplexValue, Duration, Instant, Number};
    match (left, right, op) {
        (Instant { value: later }, Instant { value: earlier }, ArithmeticOperator::Subtract) => {
            let later = epoch_of(later)?;
            let earlier = epoch_of(earlier)?;
            return Ok(Duration {
                value: later - earlier,
                unit: DurationUnit::Ms,
            });
        }
        (Instant { value }, Duration { value: span, unit }, ArithmeticOperator::Add)
        | (Duration { value: span, unit }, Instant { value }, ArithmeticOperator::Add) => {
            let epoch = epoch_of(value)?;
            return instant_from_epoch(epoch + to_milliseconds(*span, *unit));
        }
        _ => {}
    }
    let mixed = || {
        wrong_type(format!(
            "arithmetic operator '{}' is not defined between a '{}' and a '{}' value",
            arithmetic_name(op),
            kind_name(left),
            kind_name(right)
        ))
    };
    if matches!(left, Instant { .. }) || matches!(right, Instant { .. }) {
        return mixed();
    }
    if let (
        Duration { value, unit },
        Duration {
            value: other,
            unit: other_unit,
        },
    ) = (left, right)
    {
        return arithmetic_on_durations(op, *value, *unit, *other, *other_unit);
    }
    if matches!(left, Duration { .. }) || matches!(right, Duration { .. }) {
        return mixed();
    }
    let numeric = |value: &ComputedValue| matches!(value, Number { .. } | ComplexValue { .. });
    if !numeric(left) {
        return wrong_type(format!(
            "arithmetic requires numeric operands; got a '{}' value",
            kind_name(left)
        ));
    }
    if !numeric(right) {
        return wrong_type(format!(
            "arithmetic requires numeric operands; got a '{}' value",
            kind_name(right)
        ));
    }
    match (left, right) {
        (
            Number { value, unit },
            Number {
                value: other,
                unit: other_unit,
            },
        ) => arithmetic_on_numbers(op, *value, unit.as_ref(), *other, other_unit.as_ref()),
        _ => arithmetic_on_complex(op, left, right),
    }
}

/// Whether a value's numeric parts are all finite; the kinds arithmetic does not produce have none.
fn has_finite_magnitude(value: &ComputedValue) -> bool {
    match value {
        ComputedValue::Number { value, .. } | ComputedValue::Duration { value, .. } => {
            value.is_finite()
        }
        ComputedValue::Complex { re, im, .. } => re.is_finite() && im.is_finite(),
        ComputedValue::Text { .. }
        | ComputedValue::Boolean { .. }
        | ComputedValue::Instant { .. } => true,
    }
}

/// `arithmetic`: the result by operand kind, except that a definite result that overflowed to an infinity or became
/// NaN is a `domain-error`, since no computed value can carry it.
pub(crate) fn arithmetic(
    op: ArithmeticOperator,
    left: &ComputedValue,
    right: &ComputedValue,
) -> Outcome<ComputedValue> {
    let result = arithmetic_by_kind(op, left, right)?;
    if has_finite_magnitude(&result) {
        Ok(result)
    } else {
        domain_error("result is not a finite number")
    }
}

/// `reference`'s expected-unit check: with a declared unit, the resolved value must be a number or complex value of
/// that unit.
pub(crate) fn check_reference_unit(
    expected: Option<&Unit>,
    resolved: &ComputedValue,
) -> Outcome<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let unit = match resolved {
        ComputedValue::Number { unit, .. } | ComputedValue::Complex { unit, .. } => unit,
        _ => {
            return wrong_type(
                "a unit was expected on a reference that resolved to a non-numeric value",
            );
        }
    };
    if units_equal(Some(expected), unit.as_ref()) {
        Ok(())
    } else {
        wrong_type("the resolved value's unit does not match the reference's expected unit")
    }
}
