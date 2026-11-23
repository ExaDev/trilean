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

/// A value an expression evaluates to, of one of eight kinds.
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
    /// An ordered list of values, each of any kind, a list included. A list holds at most the evaluator's value entry
    /// limit in entries, counted over every list in the value.
    List {
        /// The items, in order.
        items: Vec<ComputedValue>,
    },
    /// A rectangular matrix of real or complex entries that share one unit, in rows. Its entries count towards the
    /// evaluator's value entry limit, one per cell, so a matrix is bounded exactly as a list is.
    Matrix {
        /// The real part of each entry, row by row. Every row has the same number of entries, and there is at least
        /// one row of at least one entry.
        rows: Vec<Vec<f64>>,
        /// The imaginary part of each entry in the same shape as `rows`, present only when some entry is complex.
        imaginary: Option<Vec<Vec<f64>>>,
        /// The unit every entry is measured in, when it has one.
        unit: Option<Unit>,
    },
}

impl ComputedValue {
    /// The entries the value holds, counted over every list in it: a list holds one entry per item plus the entries of
    /// each item that is itself a list, and any other value holds none. It is what the evaluator's value entry limit
    /// bounds and what a `call` is charged for the lists it is given.
    pub fn entry_count(&self) -> usize {
        match self {
            Self::List { items } => items.iter().map(|item| 1 + item.entry_count()).sum(),
            Self::Matrix { rows, .. } => rows.iter().map(Vec::len).sum(),
            _ => 0,
        }
    }
}
