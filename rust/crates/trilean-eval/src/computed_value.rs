//! The value an expression evaluates to.

use trilean_json_shape::{Map, Shape};

/// Dimension symbol to exponent, for example `{ "m": 1, "s": -1 }` for metres per second. The dimensions are in the order
/// the document gave them.
pub type Unit = Map<f64>;

/// The unit of a duration.
#[derive(Shape, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DurationUnit {
    /// Milliseconds.
    Ms,
    /// Seconds.
    S,
    /// Minutes.
    Min,
    /// Hours.
    H,
    /// Days.
    D,
}

/// A value an expression evaluates to, of one of six kinds.
#[derive(Shape, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ComputedValue {
    /// A real number, with the unit it is measured in.
    Number {
        /// The number.
        value: f64,
        /// The unit, when it has one.
        unit: Option<Unit>,
    },
    /// A text.
    Text {
        /// The text.
        value: String,
    },
    /// A truth value.
    Boolean {
        /// Whether it is true.
        value: bool,
    },
    /// A point in time.
    Instant {
        /// An ISO-8601 timestamp.
        value: String,
    },
    /// A length of time.
    Duration {
        /// The number of `unit`s.
        value: f64,
        /// What the number counts.
        unit: DurationUnit,
    },
    /// A complex number, stored in rectangular form: there is one canonical form, and no field says which form it was
    /// written in.
    Complex {
        /// The real part.
        re: f64,
        /// The imaginary part.
        im: f64,
        /// The unit, when it has one.
        unit: Option<Unit>,
    },
}
