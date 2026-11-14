//! One definition of a JSON shape that validates documents and writes the JSON Schema and TypeScript declarations
//! for them, so the three cannot disagree.
//!
//! A type derives [`Shape`], reading the serde attributes it already carries. Deserialising it through serde is
//! validating, and the same descriptor writes the JSON Schema ([`json_schema`], [`schema_definitions`]) and the
//! declarations ([`typescript_declarations`]).
//!
//! # Compile-time checks
//!
//! The derive refuses at compile time what could never validate: a constraint on a type it does not apply to, a
//! pattern outside the supported subset, a flattened field or newtype variant that is not a struct, a property key
//! used twice once a tag and flattened fields are counted, an attribute it does not read, and two unit variants in an
//! untagged enum. Two different types with one definition name cannot be told apart at compile time, because they may
//! live in different crates, so [`Definitions::of`] panics naming both; `#[shape(name = "...")]` renames one.
//!
//! # Limits that follow from JSON text, and from JSON Schema
//!
//! - Numbers are `f64`s, as `JSON.parse` reads them (see [`Value`]). Integer types are bounded by
//!   [`MAX_SAFE_INTEGER`] in both the validator and the schema.
//! - Reading goes through `serde_json`, which refuses nesting deeper than 128 levels and an unpaired surrogate
//!   escape. A JSON Schema validator in JavaScript accepts both, so the schema accepts documents this crate cannot
//!   read; the agreement tests leave them out for that reason.
//! - A union is checked in time linear in the document: alternatives that cannot match the value's kind or lack a
//!   required key are discarded first, and an alternative that accepted a value is remembered.
//! - Patterns are a subset of ECMAScript regular expressions over Unicode scalar values, compiled to an automaton, so
//!   matching is linear in the text.
//! - In draft-07 a `$ref` ignores its sibling keywords, so a field of a named type that carries a description is
//!   written as `{"$ref": ..., "description": ...}` and a validator that follows the draft to the letter drops the
//!   description (and only the description: every validation keyword is in the referenced definition). Draft
//!   2020-12 applies both. The consumer that publishes draft-07 decides, against its own published file, whether that
//!   matters to it.

// The derive names this crate by path, which inside the crate itself is `self`.
extern crate self as json_shape;

mod def;
mod path;
mod pattern;
mod schema;
mod shape;
mod typescript;
mod validate;
mod value;

pub use def::{Class, Constraint, Definitions, FieldDef, Kind, ObjectDef, Registry, ShapeDef};
pub use json_shape_derive::Shape;
pub use path::{Issue, Issues, Path, PathSegment};
pub use pattern::{Pattern, PatternError};
pub use schema::{Draft, SchemaOptions, json_schema, schema_definitions, schema_of};
pub use shape::{Map, OpenObject, Shape};
pub use typescript::typescript_declarations;
pub use validate::{accepts, check, check_with_work};
pub use value::{MAX_SAFE_INTEGER, Value};

/// What the derive's generated code names; not part of the contract.
#[doc(hidden)]
pub mod private {
    pub use serde;

    use crate::def::{Class, Definitions, ShapeDef};
    use crate::path::Path;
    use crate::value::Value;

    /// Whether `actual` is one of `allowed`, for a compile-time assertion.
    pub const fn class_in(actual: Class, allowed: &[Class]) -> bool {
        let mut position = 0;
        while position < allowed.len() {
            if allowed[position] as u8 == actual as u8 {
                return true;
            }
            position += 1;
        }
        false
    }

    const fn same(left: &str, right: &str) -> bool {
        let (left, right) = (left.as_bytes(), right.as_bytes());
        if left.len() != right.len() {
            return false;
        }
        let mut position = 0;
        while position < left.len() {
            if left[position] != right[position] {
                return false;
            }
            position += 1;
        }
        true
    }

    /// Whether no key appears twice across `parts`, for a compile-time assertion.
    pub const fn keys_unique(parts: &[&[&str]]) -> bool {
        let mut first_part = 0;
        while first_part < parts.len() {
            let mut first_key = 0;
            while first_key < parts[first_part].len() {
                let mut second_part = first_part;
                while second_part < parts.len() {
                    let mut second_key = if second_part == first_part {
                        first_key + 1
                    } else {
                        0
                    };
                    while second_key < parts[second_part].len() {
                        if same(parts[first_part][first_key], parts[second_part][second_key]) {
                            return false;
                        }
                        second_key += 1;
                    }
                    second_part += 1;
                }
                first_key += 1;
            }
            first_part += 1;
        }
        true
    }

    /// The keys of every part in one array of the length `N`, which is the sum of their lengths.
    pub const fn concat_keys<const N: usize>(parts: &[&[&'static str]]) -> [&'static str; N] {
        let mut joined = [""; N];
        let mut written = 0;
        let mut part = 0;
        while part < parts.len() {
            let mut key = 0;
            while key < parts[part].len() {
                joined[written] = parts[part][key];
                written += 1;
                key += 1;
            }
            part += 1;
        }
        assert!(written == N, "the length does not match the keys");
        joined
    }

    /// Whether `alternative` accepts `value`, remembered in `path`.
    pub fn decide(
        path: &mut Path,
        definitions: &Definitions,
        alternative: &ShapeDef,
        value: &Value,
    ) -> bool {
        crate::validate::decide(path, definitions, alternative, value)
    }
}

#[cfg(test)]
mod tests {
    use super::Class;
    use super::private::{class_in, concat_keys, keys_unique};

    #[test]
    fn classes_are_matched_by_identity() {
        assert!(class_in(Class::String, &[Class::Integer, Class::String]));
        assert!(!class_in(Class::Named, &[Class::Integer, Class::String]));
    }

    #[test]
    fn keys_are_unique_only_when_no_part_repeats_one() {
        assert!(keys_unique(&[&["a", "b"], &["c"], &[]]));
        assert!(!keys_unique(&[&["a", "b"], &["c", "a"]]));
        assert!(!keys_unique(&[&["a", "a"]]));
    }

    #[test]
    fn keys_are_joined_in_order() {
        assert_eq!(
            concat_keys::<3>(&[&["a"], &[], &["b", "c"]]),
            ["a", "b", "c"]
        );
    }
}
