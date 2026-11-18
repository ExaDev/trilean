//! A JSON value with no further meaning imposed by this crate, for every opaque payload.

use std::any::TypeId;

use trilean_json_shape::{Class, Issues, Kind, Path, Registry, Shape, ShapeDef, Value};

/// A JSON value that this package does not interpret: a reference key, a table identifier, a collection reference or a
/// delegation payload. It is a value of any JSON kind, whose members are in the order the document gave them and whose
/// object keys never include `__proto__`.
#[derive(Clone, Debug, PartialEq)]
pub struct JsonValue(pub Value);

const NAME: &str = "JsonValue";

fn without_prototype_keys(value: &Value) -> Value {
    match value {
        Value::Array(elements) => {
            Value::Array(elements.iter().map(without_prototype_keys).collect())
        }
        Value::Object(pairs) => Value::Object(
            pairs
                .iter()
                .filter(|(key, _)| key != "__proto__")
                .map(|(key, entry)| (key.clone(), without_prototype_keys(entry)))
                .collect(),
        ),
        other => other.clone(),
    }
}

impl Shape for JsonValue {
    const CLASS: Class = Class::Named;

    fn reference() -> ShapeDef {
        ShapeDef::new(Kind::Ref(NAME.to_owned()))
    }

    fn definition() -> ShapeDef {
        let itself = || Box::new(Self::reference());
        ShapeDef::new(Kind::OneOf(vec![
            ShapeDef::new(Kind::String {
                min_length: None,
                pattern: None,
            }),
            ShapeDef::new(Kind::Number {
                min: None,
                exclusive_min: None,
                max: None,
            }),
            ShapeDef::new(Kind::Bool),
            ShapeDef::new(Kind::Null),
            ShapeDef::new(Kind::Array {
                items: itself(),
                min_items: None,
                max_items: None,
                unique: false,
            }),
            ShapeDef::new(Kind::Map {
                values: itself(),
                min_properties: None,
                key_pattern: None,
            }),
        ]))
        .described("A JSON value that this package does not interpret.")
    }

    fn register(registry: &mut Registry) {
        if registry.reserve(NAME, TypeId::of::<Self>(), std::any::type_name::<Self>()) {
            registry.define(NAME, Self::definition());
        }
    }

    fn build(value: &Value, _: &mut Path) -> Result<Self, Issues> {
        Ok(JsonValue(without_prototype_keys(value)))
    }
}
