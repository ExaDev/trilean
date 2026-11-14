//! An ordered JSON value. Object keys keep the order of the input, which `serde_json::Value` does not without its
//! `preserve_order` feature (and that feature adds `indexmap` to the graph), so opaque payloads keep their key order.

use std::collections::HashMap;
use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

/// The largest integer that a JavaScript number, and so a JSON document read by JavaScript, holds exactly.
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A JSON value.
///
/// Numbers are finite `f64`s, each read as the nearest double to its literal, as `JSON.parse` reads it: an integer above 2^53 is rounded when it is read (which
/// is why no integer type accepts one), `-0` and `0` are one value, and a number is not distinguishable from the
/// same number written another way (`1e2` and `100`), so a document does not round-trip digit for digit. `Display`
/// writes a number as `JSON.stringify` does. `Serialize` writes the same double, a whole number as an integer wherever
/// `i64` holds it and any other with `serde_json`'s float text, which reads back as the same double but is not always
/// the text `JSON.stringify` writes (`1e21` is `1000000000000000000000.0`).
///
/// An object is a list of pairs in input order, and a duplicate key keeps its first position and its last value, as
/// `JSON.parse` does. `==` (from `PartialEq`) compares objects in that order and numbers as `f64`s; use
/// [`Value::json_equal`] for JSON Schema's equality, which ignores key order.
///
/// Reading goes through serde, so the parser's own limits apply: `serde_json` refuses nesting deeper than 128 levels
/// and an unpaired surrogate escape, which `JSON.parse` and so a JSON Schema validator in JavaScript accept. A value
/// built another way has no depth limit, and `Display`, `json_equal`, `Drop` and validation recurse.
/// [`Value::get`] is linear in the size of the object.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

impl Value {
    /// The value under `key` when this is an object that has it.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(flag) => Some(*flag),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Value)]> {
        match self {
            Value::Object(pairs) => Some(pairs),
            _ => None,
        }
    }

    /// The JSON Schema name of this value's type, with every number called `number`.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }

    /// Whether two values are equal as JSON Schema defines it: objects regardless of key order, numbers by value.
    /// Linear in the size of the values, times a logarithm for sorting object keys.
    pub fn json_equal(&self, other: &Value) -> bool {
        self.canonical() == other.canonical()
    }

    /// The text of the value with object keys in sorted order, so two values are equal as JSON Schema defines it
    /// exactly when their canonical texts are equal.
    pub fn canonical(&self) -> String {
        match self {
            Value::Array(items) => {
                let parts: Vec<String> = items.iter().map(Value::canonical).collect();
                format!("[{}]", parts.join(","))
            }
            Value::Object(pairs) => {
                let mut sorted: Vec<&(String, Value)> = pairs.iter().collect();
                sorted.sort_by(|left, right| left.0.cmp(&right.0));
                let parts: Vec<String> = sorted
                    .iter()
                    .map(|(key, value)| {
                        format!("{}:{}", Value::String(key.clone()), value.canonical())
                    })
                    .collect();
                format!("{{{}}}", parts.join(","))
            }
            other => other.to_string(),
        }
    }
}

/// A number as `JSON.stringify` writes it: digits for magnitudes from 1e-6 up to 1e21, an exponent outside that, and
/// `0` for `-0`.
fn number_text(number: f64) -> String {
    if number == 0.0 {
        return "0".to_owned();
    }
    if (1e-6..1e21).contains(&number.abs()) {
        return format!("{number}");
    }
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

impl fmt::Display for Value {
    /// Compact JSON text, with numbers written as `JSON.stringify` writes them.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Null => formatter.write_str("null"),
            Value::Bool(flag) => write!(formatter, "{flag}"),
            Value::Number(number) => formatter.write_str(&number_text(*number)),
            Value::String(text) => {
                formatter.write_str(&serde_json::to_string(text).map_err(|_| fmt::Error)?)
            }
            Value::Array(items) => {
                formatter.write_str("[")?;
                for (position, item) in items.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str(",")?;
                    }
                    write!(formatter, "{item}")?;
                }
                formatter.write_str("]")
            }
            Value::Object(pairs) => {
                formatter.write_str("{")?;
                for (position, (key, value)) in pairs.iter().enumerate() {
                    if position > 0 {
                        formatter.write_str(",")?;
                    }
                    formatter.write_str(&serde_json::to_string(key).map_err(|_| fmt::Error)?)?;
                    write!(formatter, ":{value}")?;
                }
                formatter.write_str("}")
            }
        }
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_bool<E: de::Error>(self, flag: bool) -> Result<Value, E> {
        Ok(Value::Bool(flag))
    }

    fn visit_i64<E: de::Error>(self, number: i64) -> Result<Value, E> {
        Ok(Value::Number(number as f64))
    }

    fn visit_u64<E: de::Error>(self, number: u64) -> Result<Value, E> {
        Ok(Value::Number(number as f64))
    }

    fn visit_f64<E: de::Error>(self, number: f64) -> Result<Value, E> {
        if number.is_finite() {
            Ok(Value::Number(number))
        } else {
            Err(E::custom("a JSON number must be finite"))
        }
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Value, E> {
        Ok(Value::String(text.to_owned()))
    }

    fn visit_string<E: de::Error>(self, text: String) -> Result<Value, E> {
        Ok(Value::String(text))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = sequence.next_element::<Value>()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut pairs: Vec<(String, Value)> = Vec::new();
        let mut positions: HashMap<String, usize> = HashMap::new();
        while let Some((key, value)) = map.next_entry::<String, Value>()? {
            match positions.get(&key) {
                Some(position) => pairs[*position].1 = value,
                None => {
                    positions.insert(key.clone(), pairs.len());
                    pairs.push((key, value));
                }
            }
        }
        Ok(Value::Object(pairs))
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(ValueVisitor)
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(flag) => serializer.serialize_bool(*flag),
            Value::Number(number) => {
                // A whole number is written without a fraction, as `JSON.stringify` writes it, wherever `i64` holds it.
                if number.fract() == 0.0 && number.abs() < 9.0e18 {
                    serializer.serialize_i64(*number as i64)
                } else {
                    serializer.serialize_f64(*number)
                }
            }
            Value::String(text) => serializer.serialize_str(text),
            Value::Array(items) => {
                let mut sequence = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    sequence.serialize_element(item)?;
                }
                sequence.end()
            }
            Value::Object(pairs) => {
                let mut map = serializer.serialize_map(Some(pairs.len()))?;
                for (key, value) in pairs {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}
