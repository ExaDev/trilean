//! One definition of a JSON shape that validates documents and writes the JSON Schema and TypeScript declarations
//! for them, so the three cannot disagree.
//!
//! A type derives [`Shape`], reading the serde attributes it already carries. Deserialising it through serde is
//! validating, and the same descriptor writes the JSON Schema ([`json_schema`], [`schema_definitions`]) and the
//! declarations ([`typescript_declarations`]).

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

pub use def::{Constraint, Definitions, FieldDef, Kind, ObjectDef, Registry, ShapeDef};
pub use json_shape_derive::Shape;
pub use path::{Issue, Issues, Path, PathSegment};
pub use pattern::{Pattern, PatternError};
pub use schema::{Draft, SchemaOptions, json_schema, schema_definitions, schema_of};
pub use shape::{Map, OpenObject, Shape};
pub use typescript::typescript_declarations;
pub use validate::{accepts, check};
pub use value::{MAX_SAFE_INTEGER, Value};

/// What the derive's generated code names; not part of the contract.
#[doc(hidden)]
pub mod private {
    pub use serde;
}
