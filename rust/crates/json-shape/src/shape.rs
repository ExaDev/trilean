//! The trait a type implements to be described, validated and emitted, and its implementations for the types a
//! derived shape is built from.

use std::borrow::Cow;

use crate::def::{Definitions, Kind, Registry, ShapeDef};
use crate::path::{Issues, Path};
use crate::validate::check;
use crate::value::{MAX_SAFE_INTEGER, Value};

/// A type with a shape. `#[derive(Shape)]` implements it from the type's serde attributes and `#[shape(...)]`.
pub trait Shape: Sized {
    /// Whether a field of this type may be absent from its object.
    const OPTIONAL: bool = false;

    /// How a field of this type is described: a named type gives a reference to its definition, a built-in gives
    /// its shape inline.
    fn reference() -> ShapeDef;

    /// The complete shape of this type, which for a named type is what its definition holds.
    fn definition() -> ShapeDef {
        Self::reference()
    }

    /// Adds this type and every named type it refers to to `registry`.
    fn register(registry: &mut Registry);

    /// Adds the named types this type's fields refer to, without this type itself, for a type whose fields are
    /// merged into another object's definition.
    fn register_members(registry: &mut Registry) {
        Self::register(registry);
    }

    /// The value of a field of this type that is absent from its object, for a type that allows that.
    fn absent() -> Option<Self> {
        None
    }

    /// The definitions this type is described by.
    fn definitions() -> Cow<'static, Definitions> {
        Cow::Owned(Definitions::of::<Self>())
    }

    /// Converts a value that already matches this type's shape. A mismatch means the shape and the conversion
    /// disagree, and is reported as an issue rather than a panic.
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues>;

    /// Validates `value` against this type's shape, collecting every issue with its path, then converts it. This is
    /// what deserialising a derived type does, so deserialising is validating.
    fn from_json(value: &Value) -> Result<Self, Issues> {
        let issues = check(&Self::definitions(), &Self::reference(), value);
        if !issues.is_empty() {
            return Err(Issues(issues));
        }
        Self::build(value, &mut Path::new())
    }

    /// Whether `value` matches this type's shape.
    fn accepts(value: &Value) -> bool {
        check(&Self::definitions(), &Self::reference(), value).is_empty()
    }
}

fn mismatch<T>(path: &Path, expected: &str) -> Result<T, Issues> {
    Err(Issues::at(
        path,
        format!("the shape and the conversion disagree: expected {expected}"),
    ))
}

impl Shape for String {
    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::String {
            min_length: None,
            pattern: None,
        })
    }
    fn register(_: &mut Registry) {}
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        match value.as_str() {
            Some(text) => Ok(text.to_owned()),
            None => mismatch(path, "a string"),
        }
    }
}

impl Shape for bool {
    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Bool)
    }
    fn register(_: &mut Registry) {}
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        match value.as_bool() {
            Some(flag) => Ok(flag),
            None => mismatch(path, "a boolean"),
        }
    }
}

impl Shape for f64 {
    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Number {
            min: None,
            max: None,
        })
    }
    fn register(_: &mut Registry) {}
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        match value.as_f64() {
            Some(number) => Ok(number),
            None => mismatch(path, "a number"),
        }
    }
}

/// Any JSON value, kept in order.
impl Shape for Value {
    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Any)
    }
    fn register(_: &mut Registry) {}
    fn build(value: &Value, _: &mut Path) -> Result<Self, Issues> {
        Ok(value.clone())
    }
}

macro_rules! integer_shape {
    ($type:ty, $min:expr, $max:expr, $convert:expr) => {
        impl Shape for $type {
            fn reference() -> ShapeDef {
                ShapeDef::new(Kind::Integer {
                    min: Some($min),
                    max: Some($max),
                })
            }
            fn register(_: &mut Registry) {}
            fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
                match value.as_f64() {
                    // The shape bounds the number to a whole value the integer type holds, so the cast is exact.
                    Some(number) if number.fract() == 0.0 => {
                        let convert: fn(i64) -> Option<$type> = $convert;
                        convert(number as i64)
                            .map_or_else(|| mismatch(path, "an integer in range"), Ok)
                    }
                    _ => mismatch(path, "an integer"),
                }
            }
        }
    };
}

integer_shape!(u8, 0.0, f64::from(u8::MAX), |n| u8::try_from(n).ok());
integer_shape!(u16, 0.0, f64::from(u16::MAX), |n| u16::try_from(n).ok());
integer_shape!(u32, 0.0, f64::from(u32::MAX), |n| u32::try_from(n).ok());
integer_shape!(i32, f64::from(i32::MIN), f64::from(i32::MAX), |n| {
    i32::try_from(n).ok()
});
// Wider integers are bounded by what a JavaScript number holds exactly, which is the largest integer the corpus allows.
integer_shape!(u64, 0.0, MAX_SAFE_INTEGER, |n| u64::try_from(n).ok());
integer_shape!(usize, 0.0, MAX_SAFE_INTEGER, |n| usize::try_from(n).ok());
integer_shape!(i64, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER, Some);

impl<T: Shape> Shape for Vec<T> {
    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Array {
            items: Box::new(T::reference()),
            min_items: None,
            max_items: None,
            unique: false,
        })
    }
    fn register(registry: &mut Registry) {
        T::register(registry);
    }
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        let Some(elements) = value.as_array() else {
            return mismatch(path, "an array");
        };
        let mut built = Vec::with_capacity(elements.len());
        for (position, element) in elements.iter().enumerate() {
            path.push_index(position);
            let item = T::build(element, path);
            path.pop();
            built.push(item?);
        }
        Ok(built)
    }
}

/// An absent field, and so an optional one. A field that is present is described by `T` alone, so `null` is not an
/// accepted spelling of absence.
impl<T: Shape> Shape for Option<T> {
    const OPTIONAL: bool = true;
    fn reference() -> ShapeDef {
        T::reference()
    }
    fn register(registry: &mut Registry) {
        T::register(registry);
    }
    fn absent() -> Option<Self> {
        Some(None)
    }
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        T::build(value, path).map(Some)
    }
}

impl<T: Shape> Shape for Box<T> {
    fn reference() -> ShapeDef {
        T::reference()
    }
    fn definition() -> ShapeDef {
        T::definition()
    }
    fn register(registry: &mut Registry) {
        T::register(registry);
    }
    fn register_members(registry: &mut Registry) {
        T::register_members(registry);
    }
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        T::build(value, path).map(Box::new)
    }
}

/// An object whose values all have one shape, kept in input order.
#[derive(Clone, Debug, PartialEq)]
pub struct Map<T>(pub Vec<(String, T)>);

impl<T: Shape> Shape for Map<T> {
    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Map {
            values: Box::new(T::reference()),
            min_properties: None,
            key_pattern: None,
        })
    }
    fn register(registry: &mut Registry) {
        T::register(registry);
    }
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        let Some(pairs) = value.as_object() else {
            return mismatch(path, "an object");
        };
        let mut built = Vec::with_capacity(pairs.len());
        for (key, entry) in pairs {
            path.push_key(key);
            let item = T::build(entry, path);
            path.pop();
            built.push((key.clone(), item?));
        }
        Ok(Map(built))
    }
}

/// An object with any keys and any values, kept in input order.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenObject(pub Vec<(String, Value)>);

impl Shape for OpenObject {
    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Object(crate::def::ObjectDef::default()))
    }
    fn register(_: &mut Registry) {}
    fn build(value: &Value, path: &mut Path) -> Result<Self, Issues> {
        match value.as_object() {
            Some(pairs) => Ok(OpenObject(pairs.to_vec())),
            None => mismatch(path, "an object"),
        }
    }
}
