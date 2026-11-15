//! The encodings a corpus file uses for what JSON cannot hold, and one set of rules for reading them.
//!
//! JSON has no `-0`, infinity or NaN, no `undefined`, no text with an unpaired surrogate, and no object whose keys are
//! integer-like in insertion order. A corpus writes each as an object with one member whose name starts with `$`
//! (or, for text, is `codeUnits`):
//!
//! - `{ "$number": "-0" | "Infinity" | "-Infinity" | "NaN" }`
//! - `{ "$undefined": true }`
//! - `{ "$object": [[name, value], ...] }`: an object whose members are in the order given. A name is a text, is not
//!   repeated and is not integer-like (a JavaScript object orders integer-like names first, so the order would be
//!   lost).
//! - `{ "codeUnits": [0 .. 65535, ...] }`: a text given by its UTF-16 code units.
//!
//! The set is closed. An object with a member whose name starts with `$` is one of the above, or one a repository
//! registered, or it is refused; so is an encoding with any other member beside it, or with a value of the wrong form.
//! Nothing is passed through as an ordinary object, because a loader that does so reads a mistake as data.

use std::collections::BTreeSet;

use json_shape::Value;

/// A decoded value. Text is UTF-16 code units, since that is what a case compares.
#[derive(Clone, Debug, PartialEq)]
pub enum Decoded {
    Null,
    Bool(bool),
    /// Any double, including `-0`, the infinities and NaN, which only an encoding can write.
    Number(f64),
    Text(Vec<u16>),
    Undefined,
    Array(Vec<Decoded>),
    /// Members in the order given. A name is a text.
    Object(Vec<(Vec<u16>, Decoded)>),
    /// A value of an encoding a repository registered, as the document wrote it.
    Custom {
        name: String,
        value: Value,
    },
}

/// Why a value could not be decoded, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodeError {
    /// The place in the value, as `$` followed by `.name` and `[index]` steps.
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

/// A check a repository's own encoding applies to the value of its member.
pub type EncodingCheck = fn(&Value) -> Result<(), String>;

/// The encodings a repository registers beside the shared set, each by the name of its member (with the `$`) and the
/// check its value must pass.
#[derive(Clone, Debug, Default)]
pub struct Encodings {
    extra: Vec<(String, EncodingCheck)>,
}

impl Encodings {
    /// Only the shared set.
    pub fn shared() -> Self {
        Encodings::default()
    }

    /// Adds an encoding. The name starts with `$` and is not one the shared set has.
    pub fn with(mut self, name: &str, check: EncodingCheck) -> Self {
        assert!(
            name.starts_with('$') && !SHARED.contains(&name),
            "{name} is not a name a repository may register"
        );
        self.extra.push((name.to_owned(), check));
        self
    }
}

const SHARED: [&str; 3] = ["$number", "$undefined", "$object"];

const NUMBER_NAMES: [(&str, f64); 4] = [
    ("-0", -0.0),
    ("Infinity", f64::INFINITY),
    ("-Infinity", f64::NEG_INFINITY),
    ("NaN", f64::NAN),
];

fn fail<T>(path: &str, message: impl Into<String>) -> Result<T, DecodeError> {
    Err(DecodeError {
        path: path.to_owned(),
        message: message.into(),
    })
}

/// Whether a name is an array index in the sense of ECMAScript: the canonical text of an integer from 0 to 2^32 - 2.
fn integer_like(name: &[u16]) -> bool {
    let Ok(text) = String::from_utf16(name) else {
        return false;
    };
    text.parse::<u32>()
        .is_ok_and(|number| number != u32::MAX && number.to_string() == text)
}

fn text_of(value: &Value, path: &str) -> Result<Vec<u16>, DecodeError> {
    match value {
        Value::String(text) => Ok(text.encode_utf16().collect()),
        Value::Object(pairs) if matches!(pairs.as_slice(), [(key, _)] if key == "codeUnits") => {
            code_units(&pairs[0].1, path)
        }
        _ => fail(
            path,
            "expected a text: a string or { \"codeUnits\": [...] }",
        ),
    }
}

fn code_units(value: &Value, path: &str) -> Result<Vec<u16>, DecodeError> {
    let Some(items) = value.as_array() else {
        return fail(path, "\"codeUnits\" must be an array of code units");
    };
    items
        .iter()
        .map(|item| {
            item.as_f64()
                .filter(|number| {
                    number.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(number)
                })
                .map(|number| number as u16)
                .ok_or_else(|| DecodeError {
                    path: path.to_owned(),
                    message: "a code unit is an integer from 0 to 65535".to_owned(),
                })
        })
        .collect()
}

fn decode_at(value: &Value, encodings: &Encodings, path: &str) -> Result<Decoded, DecodeError> {
    match value {
        Value::Null => Ok(Decoded::Null),
        Value::Bool(flag) => Ok(Decoded::Bool(*flag)),
        Value::Number(number) => Ok(Decoded::Number(*number)),
        Value::String(text) => Ok(Decoded::Text(text.encode_utf16().collect())),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(position, item)| decode_at(item, encodings, &format!("{path}[{position}]")))
            .collect::<Result<_, _>>()
            .map(Decoded::Array),
        Value::Object(pairs) => decode_object(pairs, encodings, path),
    }
}

fn decode_object(
    pairs: &[(String, Value)],
    encodings: &Encodings,
    path: &str,
) -> Result<Decoded, DecodeError> {
    let marker = pairs
        .iter()
        .find(|(name, _)| name.starts_with('$') || name == "codeUnits");
    let Some((name, member)) = marker else {
        let mut members = Vec::with_capacity(pairs.len());
        for (key, item) in pairs {
            members.push((
                key.encode_utf16().collect(),
                decode_at(item, encodings, &format!("{path}.{key}"))?,
            ));
        }
        return Ok(Decoded::Object(members));
    };
    if pairs.len() != 1 {
        return fail(
            path,
            format!("an encoding has the one member \"{name}\" and no other"),
        );
    }
    let at = format!("{path}.{name}");
    match name.as_str() {
        "$number" => {
            let Some(text) = member.as_str() else {
                return fail(
                    &at,
                    "must be \"-0\", \"Infinity\", \"-Infinity\" or \"NaN\"",
                );
            };
            NUMBER_NAMES
                .iter()
                .find(|(known, _)| *known == text)
                .map(|(_, number)| Decoded::Number(*number))
                .map_or_else(
                    || {
                        fail(
                            &at,
                            "must be \"-0\", \"Infinity\", \"-Infinity\" or \"NaN\"",
                        )
                    },
                    Ok,
                )
        }
        "$undefined" => {
            if member.as_bool() == Some(true) {
                Ok(Decoded::Undefined)
            } else {
                fail(&at, "must be true")
            }
        }
        "$object" => decode_members(member, encodings, &at),
        "codeUnits" => code_units(member, &at).map(Decoded::Text),
        other => match encodings.extra.iter().find(|(known, _)| known == other) {
            Some((_, check)) => check(member)
                .map(|()| Decoded::Custom {
                    name: other.to_owned(),
                    value: member.clone(),
                })
                .or_else(|message| fail(&at, message)),
            None => fail(path, format!("{other} is not an encoding of this corpus")),
        },
    }
}

fn decode_members(member: &Value, encodings: &Encodings, at: &str) -> Result<Decoded, DecodeError> {
    let Some(entries) = member.as_array() else {
        return fail(at, "must be an array of [name, value] pairs");
    };
    let mut seen: BTreeSet<Vec<u16>> = BTreeSet::new();
    let mut members = Vec::with_capacity(entries.len());
    for (position, entry) in entries.iter().enumerate() {
        let here = format!("{at}[{position}]");
        let Some([name, item]) = entry.as_array() else {
            return fail(&here, "must be a [name, value] pair");
        };
        let name = text_of(name, &format!("{here}[0]"))?;
        if integer_like(&name) {
            return fail(
                &here,
                "an integer-like name is not kept in order by a JavaScript object",
            );
        }
        if !seen.insert(name.clone()) {
            return fail(&here, "a name is not repeated");
        }
        members.push((name, decode_at(item, encodings, &format!("{here}[1]"))?));
    }
    Ok(Decoded::Object(members))
}

/// Decodes a document's value: the encodings above become the value they stand for, an ordinary object stays one,
/// and anything the set does not allow is an error naming the place.
pub fn decode(value: &Value, encodings: &Encodings) -> Result<Decoded, DecodeError> {
    decode_at(value, encodings, "$")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(pairs: &[(&str, Value)]) -> Value {
        Value::Object(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), value.clone()))
                .collect(),
        )
    }

    fn text(value: &str) -> Value {
        Value::String(value.to_owned())
    }

    fn read(value: &Value) -> Result<Decoded, DecodeError> {
        decode(value, &Encodings::shared())
    }

    fn units(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[test]
    fn the_four_special_numbers_decode() {
        for (name, expected) in NUMBER_NAMES {
            let decoded = read(&object(&[("$number", text(name))])).unwrap();
            let Decoded::Number(number) = decoded else {
                panic!("not a number");
            };
            assert_eq!(number.to_bits(), expected.to_bits(), "{name}");
        }
    }

    #[test]
    fn a_malformed_number_encoding_is_refused() {
        for value in [
            object(&[("$number", Value::Number(5.0))]),
            object(&[("$number", text("1"))]),
            object(&[("$number", text("nan"))]),
            object(&[("$number", text("Infinity")), ("other", Value::Null)]),
            object(&[("$number", Value::Null)]),
        ] {
            assert!(read(&value).is_err(), "{value}");
        }
    }

    #[test]
    fn undefined_is_the_one_true() {
        assert_eq!(
            read(&object(&[("$undefined", Value::Bool(true))])),
            Ok(Decoded::Undefined)
        );
        assert!(read(&object(&[("$undefined", Value::Bool(false))])).is_err());
        assert!(read(&object(&[("$undefined", Value::Null)])).is_err());
    }

    #[test]
    fn code_units_decode_to_text_with_an_unpaired_surrogate_kept() {
        let value = object(&[(
            "codeUnits",
            Value::Array(vec![Value::Number(97.0), Value::Number(55296.0)]),
        )]);
        assert_eq!(read(&value), Ok(Decoded::Text(vec![97, 0xD800])));
        assert_eq!(read(&text("😀")), Ok(Decoded::Text(units("😀"))));
        for bad in [
            Value::Number(65536.0),
            Value::Number(-1.0),
            Value::Number(1.5),
            text("a"),
        ] {
            let value = object(&[("codeUnits", Value::Array(vec![bad]))]);
            assert!(read(&value).is_err());
        }
        assert!(
            read(&object(&[
                ("codeUnits", Value::Array(vec![])),
                ("x", Value::Null)
            ]))
            .is_err()
        );
    }

    #[test]
    fn an_object_with_ordered_members_keeps_its_order() {
        let pairs = Value::Array(vec![
            Value::Array(vec![text("b"), Value::Number(1.0)]),
            Value::Array(vec![text("a"), Value::Null]),
        ]);
        let decoded = read(&object(&[("$object", pairs)])).unwrap();
        assert_eq!(
            decoded,
            Decoded::Object(vec![
                (units("b"), Decoded::Number(1.0)),
                (units("a"), Decoded::Null)
            ])
        );
    }

    #[test]
    fn an_ordered_object_refuses_a_repeated_or_integer_like_name() {
        let with = |first: &str, second: &str| {
            object(&[(
                "$object",
                Value::Array(vec![
                    Value::Array(vec![text(first), Value::Null]),
                    Value::Array(vec![text(second), Value::Null]),
                ]),
            )])
        };
        assert!(read(&with("a", "a")).is_err());
        assert!(read(&with("a", "1")).is_err());
        assert!(read(&with("a", "0")).is_err());
        assert!(read(&with("a", "4294967294")).is_err());
        assert!(read(&with("a", "01")).is_ok());
        assert!(read(&with("a", "-1")).is_ok());
        assert!(read(&with("a", "4294967295")).is_ok());
        assert!(read(&with("a", "1.5")).is_ok());
    }

    #[test]
    fn a_name_may_be_given_by_code_units() {
        let name = object(&[("codeUnits", Value::Array(vec![Value::Number(55296.0)]))]);
        let value = object(&[(
            "$object",
            Value::Array(vec![Value::Array(vec![name, Value::Null])]),
        )]);
        assert_eq!(
            read(&value),
            Ok(Decoded::Object(vec![(vec![0xD800], Decoded::Null)]))
        );
    }

    #[test]
    fn any_other_dollar_key_is_refused_unless_registered() {
        let value = object(&[("$bigint", text("1"))]);
        let error = read(&value).unwrap_err();
        assert!(error.message.contains("not an encoding"), "{error}");
        let registered = Encodings::shared().with("$bigint", |value| {
            value
                .as_str()
                .filter(|text| text.bytes().all(|byte| byte.is_ascii_digit()))
                .map(|_| ())
                .ok_or_else(|| "must be digits".to_owned())
        });
        assert!(matches!(
            decode(&value, &registered),
            Ok(Decoded::Custom { .. })
        ));
        assert!(decode(&object(&[("$bigint", text("x"))]), &registered).is_err());
    }

    #[test]
    #[should_panic(expected = "not a name a repository may register")]
    fn the_shared_names_cannot_be_registered_again() {
        let _ = Encodings::shared().with("$number", |_| Ok(()));
    }

    #[test]
    fn an_ordinary_object_and_array_decode_in_place() {
        let value = object(&[(
            "a",
            Value::Array(vec![Value::Bool(true), object(&[("b", Value::Null)])]),
        )]);
        assert_eq!(
            read(&value),
            Ok(Decoded::Object(vec![(
                units("a"),
                Decoded::Array(vec![
                    Decoded::Bool(true),
                    Decoded::Object(vec![(units("b"), Decoded::Null)])
                ])
            )]))
        );
    }

    #[test]
    fn an_error_names_its_place() {
        let value = object(&[("a", Value::Array(vec![object(&[("$number", text("x"))])]))]);
        assert_eq!(read(&value).unwrap_err().path, "$.a[0].$number");
    }
}
