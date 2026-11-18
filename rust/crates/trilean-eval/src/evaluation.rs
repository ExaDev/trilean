//! The reason an evaluation has no definite result.

use trilean_json_shape::Shape;

/// Which of the four categories of reason applies.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IndeterminateCode {
    /// A resolver reports that the value is not there.
    NotFound,
    /// A resolver has not been given the value yet, so a later evaluation may settle it either way. It is the only
    /// reason that is not a property of the data.
    NotYetKnown,
    /// An operand is of the wrong kind, or a pattern, tree or function is not usable.
    WrongType,
    /// An operation was attempted outside its domain.
    DomainError,
}

/// Why an evaluation is indeterminate.
#[derive(Shape, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IndeterminateReason {
    /// Which of the four reason categories applies.
    pub code: IndeterminateCode,
    /// A human-readable explanation, for logging and debugging.
    pub message: String,
}
