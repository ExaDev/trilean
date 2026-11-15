//! Behaviour that is defined by ECMAScript and that other crates writing the same text need.

/// A number as ECMAScript's `Number.prototype.toString` writes it, which is also how `JSON.stringify` writes one: the
/// shortest digits that read back as the same double, written positionally for magnitudes from 1e-6 up to below 1e21 and
/// with an exponent outside that range, `0` for both zeros, and `NaN`, `Infinity` and `-Infinity` as ECMAScript names
/// them. A message, a command's output or a JSON document that names a number uses this so that it reads the same in
/// every implementation.
pub use json_shape::number_to_string;
