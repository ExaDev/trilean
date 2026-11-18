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

use std::collections::HashSet;

use trilean_json_shape::Value;

use crate::canonical::MAX_DEPTH;
use crate::trail::{Step, Trail, render};

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

    /// Adds an encoding. The name starts with `$` and is not one the shared set has or one already added, which is
    /// refused with the reason.
    pub fn with(mut self, name: &str, check: EncodingCheck) -> Result<Self, String> {
        if !name.starts_with('$') || name.len() < 2 {
            return Err(format!("{name} does not start with `$` and a name"));
        }
        if SHARED.contains(&name) || self.extra.iter().any(|(known, _)| known == name) {
            return Err(format!("{name} is already an encoding"));
        }
        self.extra.push((name.to_owned(), check));
        Ok(self)
    }
}

const SHARED: [&str; 3] = ["$number", "$undefined", "$object"];

const NUMBER_NAMES: [(&str, f64); 4] = [
    ("-0", -0.0),
    ("Infinity", f64::INFINITY),
    ("-Infinity", f64::NEG_INFINITY),
    ("NaN", f64::NAN),
];

fn fail<T>(trail: &[Step<'_>], message: impl Into<String>) -> Result<T, DecodeError> {
    Err(DecodeError {
        path: render(trail),
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

/// Runs `f` with `step` added to the trail, and takes it off again.
fn within<'a, T>(trail: &mut Trail<'a>, step: Step<'a>, f: impl FnOnce(&mut Trail<'a>) -> T) -> T {
    trail.push(step);
    let result = f(trail);
    trail.pop();
    result
}

fn text_of<'a>(value: &'a Value, trail: &mut Trail<'a>) -> Result<Vec<u16>, DecodeError> {
    match value {
        Value::String(text) => Ok(text.encode_utf16().collect()),
        Value::Object(pairs) if matches!(pairs.as_slice(), [(key, _)] if key == "codeUnits") => {
            code_units(&pairs[0].1, trail)
        }
        _ => fail(
            trail,
            "expected a text: a string or { \"codeUnits\": [...] }",
        ),
    }
}

fn code_units(value: &Value, trail: &[Step<'_>]) -> Result<Vec<u16>, DecodeError> {
    let Some(items) = value.as_array() else {
        return fail(trail, "\"codeUnits\" must be an array of code units");
    };
    let mut units = Vec::with_capacity(items.len());
    for item in items {
        match item
            .as_f64()
            .filter(|number| number.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(number))
        {
            Some(number) => units.push(number as u16),
            None => return fail(trail, "a code unit is an integer from 0 to 65535"),
        }
    }
    Ok(units)
}

fn decode_at<'a>(
    value: &'a Value,
    encodings: &Encodings,
    trail: &mut Trail<'a>,
    depth: usize,
) -> Result<Decoded, DecodeError> {
    if matches!(value, Value::Array(_) | Value::Object(_)) && depth > MAX_DEPTH {
        return fail(trail, format!("nesting is deeper than {MAX_DEPTH} levels"));
    }
    match value {
        Value::Null => Ok(Decoded::Null),
        Value::Bool(flag) => Ok(Decoded::Bool(*flag)),
        Value::Number(number) => Ok(Decoded::Number(*number)),
        Value::String(text) => Ok(Decoded::Text(text.encode_utf16().collect())),
        Value::Array(items) => {
            let mut decoded = Vec::with_capacity(items.len());
            for (position, item) in items.iter().enumerate() {
                decoded.push(within(trail, Step::Index(position), |trail| {
                    decode_at(item, encodings, trail, depth + 1)
                })?);
            }
            Ok(Decoded::Array(decoded))
        }
        Value::Object(pairs) => decode_object(pairs, encodings, trail, depth),
    }
}

fn decode_object<'a>(
    pairs: &'a [(String, Value)],
    encodings: &Encodings,
    trail: &mut Trail<'a>,
    depth: usize,
) -> Result<Decoded, DecodeError> {
    let marker = pairs
        .iter()
        .find(|(name, _)| name.starts_with('$') || name == "codeUnits");
    let Some((name, member)) = marker else {
        let mut members = Vec::with_capacity(pairs.len());
        for (key, item) in pairs {
            members.push((
                key.encode_utf16().collect(),
                within(trail, Step::Key(key), |trail| {
                    decode_at(item, encodings, trail, depth + 1)
                })?,
            ));
        }
        return Ok(Decoded::Object(members));
    };
    if pairs.len() != 1 {
        return fail(
            trail,
            format!("an encoding has the one member \"{name}\" and no other"),
        );
    }
    let at = |trail: &mut Trail<'a>| trail.push(Step::Key(name));
    match name.as_str() {
        "$number" => {
            at(trail);
            let result = match member.as_str().and_then(|text| {
                NUMBER_NAMES
                    .iter()
                    .find(|(known, _)| *known == text)
                    .map(|(_, number)| *number)
            }) {
                Some(number) => Ok(Decoded::Number(number)),
                None => fail(
                    trail,
                    "must be \"-0\", \"Infinity\", \"-Infinity\" or \"NaN\"",
                ),
            };
            trail.pop();
            result
        }
        "$undefined" => within(trail, Step::Key(name), |trail| {
            if member.as_bool() == Some(true) {
                Ok(Decoded::Undefined)
            } else {
                fail(trail, "must be true")
            }
        }),
        "$object" => within(trail, Step::Key(name), |trail| {
            decode_members(member, encodings, trail, depth)
        }),
        "codeUnits" => within(trail, Step::Key(name), |trail| {
            code_units(member, trail).map(Decoded::Text)
        }),
        other => match encodings.extra.iter().find(|(known, _)| known == other) {
            Some((_, check)) => within(trail, Step::Key(name), |trail| {
                check(member)
                    .map(|()| Decoded::Custom {
                        name: other.to_owned(),
                        value: member.clone(),
                    })
                    .or_else(|message| fail(trail, message))
            }),
            None => fail(trail, format!("{other} is not an encoding of this corpus")),
        },
    }
}

fn decode_members<'a>(
    member: &'a Value,
    encodings: &Encodings,
    trail: &mut Trail<'a>,
    depth: usize,
) -> Result<Decoded, DecodeError> {
    let Some(entries) = member.as_array() else {
        return fail(trail, "must be an array of [name, value] pairs");
    };
    let mut seen: HashSet<Vec<u16>> = HashSet::with_capacity(entries.len());
    let mut members = Vec::with_capacity(entries.len());
    for (position, entry) in entries.iter().enumerate() {
        let decoded = within(trail, Step::Index(position), |trail| {
            let Some([name, item]) = entry.as_array() else {
                return fail(trail, "must be a [name, value] pair");
            };
            let name = within(trail, Step::Index(0), |trail| text_of(name, trail))?;
            if integer_like(&name) {
                return fail(
                    trail,
                    "an integer-like name is not kept in order by a JavaScript object",
                );
            }
            if !seen.insert(name.clone()) {
                return fail(trail, "a name is not repeated");
            }
            let item = within(trail, Step::Index(1), |trail| {
                decode_at(item, encodings, trail, depth + 3)
            })?;
            Ok((name, item))
        })?;
        members.push(decoded);
    }
    Ok(Decoded::Object(members))
}

/// Decodes a document's value: the encodings above become the value they stand for, an ordinary object stays one,
/// and anything the set does not allow is an error naming the place.
pub fn decode(value: &Value, encodings: &Encodings) -> Result<Decoded, DecodeError> {
    decode_at(value, encodings, &mut Vec::new(), 1)
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
        let registered = Encodings::shared()
            .with("$bigint", |value| {
                value
                    .as_str()
                    .filter(|text| text.bytes().all(|byte| byte.is_ascii_digit()))
                    .map(|_| ())
                    .ok_or_else(|| "must be digits".to_owned())
            })
            .unwrap();
        assert!(matches!(
            decode(&value, &registered),
            Ok(Decoded::Custom { .. })
        ));
        assert!(decode(&object(&[("$bigint", text("x"))]), &registered).is_err());
    }

    #[test]
    fn a_name_a_repository_may_not_register_is_refused_with_the_reason() {
        let check: EncodingCheck = |_| Ok(());
        for name in ["$number", "$undefined", "$object"] {
            let error = Encodings::shared().with(name, check).unwrap_err();
            assert!(error.contains("already an encoding"), "{error}");
        }
        for name in ["number", "", "$", "codeUnits"] {
            assert!(Encodings::shared().with(name, check).is_err(), "{name:?}");
        }
        let twice = Encodings::shared()
            .with("$a", check)
            .unwrap()
            .with("$a", check);
        assert!(twice.is_err());
    }

    #[test]
    fn nesting_past_the_bound_is_refused_and_does_not_recurse_without_end() {
        let nested = |levels: usize| {
            (1..levels).fold(Value::Array(Vec::new()), |inner, _| {
                Value::Array(vec![inner])
            })
        };
        assert!(read(&nested(MAX_DEPTH)).is_ok());
        let error = read(&nested(MAX_DEPTH + 1)).unwrap_err();
        assert!(error.message.contains("deeper than"), "{error}");
        let mut value = Value::Null;
        for _ in 0..100_000 {
            value = Value::Array(vec![value]);
        }
        assert!(read(&value).is_err());
        let mut current = value;
        while let Value::Array(mut items) = current {
            current = items.pop().unwrap_or(Value::Null);
        }
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

    #[test]
    fn members_under_a_long_name_are_decoded_without_a_path_string_each() {
        // The decoding takes its place as a stack of steps (`decode_at` has no parameter a path string could be passed in),
        // and writes it out only for an error: the count of trails written is the work. The count does not see a `format!`
        // that bypasses the trail; the signature of `decode_at`, which this test calls with a trail, makes one impossible
        // without changing it, and a changed signature does not compile here.
        let long = "k".repeat(10_000);
        let members = |bad: bool| {
            let mut pairs: Vec<(String, Value)> = (0..100_000)
                .map(|n| (format!("{n:08}"), Value::Number(f64::from(n))))
                .collect();
            if bad {
                pairs.push(("z".to_owned(), object(&[("$number", text("x"))])));
            }
            Value::Object(vec![(long.clone(), Value::Object(pairs))])
        };
        let (good, bad) = (members(false), members(true));
        let encodings = Encodings::shared();
        let mut trail: Trail<'_> = Vec::new();
        crate::trail::RENDERED.with(|count| count.set(0));
        assert!(decode_at(&good, &encodings, &mut trail, 1).is_ok());
        assert_eq!(crate::trail::RENDERED.with(std::cell::Cell::get), 0);
        let error = decode_at(&bad, &encodings, &mut trail, 1).unwrap_err();
        assert_eq!(crate::trail::RENDERED.with(std::cell::Cell::get), 1);
        assert!(trail.is_empty());
        assert_eq!(error.path.len(), 1 + 1 + 10_000 + 1 + 1 + 1 + 7);
        assert!(error.path.ends_with(".z.$number"));
    }
}
