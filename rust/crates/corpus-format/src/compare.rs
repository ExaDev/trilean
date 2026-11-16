//! How an expectation is compared with what an implementation returned.
//!
//! Without a tolerance two numbers are equal when they are the same double: `-0` is not `0`, and NaN is NaN. With one,
//! every finite number in the compared value is held to it (see [`Tolerance`]). A member of an actual object whose
//! value is [`Decoded::Undefined`] counts as absent, since JSON has no `undefined`; an expectation of `$undefined`
//! requires the member to be there and to be undefined. Every other value must match structurally.

use std::collections::HashMap;

use crate::decode::Decoded;
use crate::envelope::Tolerance;
use crate::trail::{Step, Trail, render};

/// Where two values differ.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    /// The place, as `$` followed by `.name` and `[index]` steps.
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for Mismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

fn mismatch<T>(trail: &[Step<'_>], message: impl Into<String>) -> Result<T, Mismatch> {
    Err(Mismatch {
        path: render(trail),
        message: message.into(),
    })
}

fn shown(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// The position of a finite double in the order of all finite doubles, as an integer; both zeros are the one point 0.
fn ordered_bits(value: f64) -> i128 {
    let bits = value.to_bits();
    let magnitude = i128::from(bits & !(1 << 63));
    if bits >> 63 == 1 {
        -magnitude
    } else {
        magnitude
    }
}

fn within(actual: f64, expected: f64, tolerance: Option<&Tolerance>) -> bool {
    if actual.to_bits() == expected.to_bits() || (actual.is_nan() && expected.is_nan()) {
        return true;
    }
    let Some(tolerance) = tolerance else {
        return false;
    };
    if !actual.is_finite() || !expected.is_finite() {
        return false;
    }
    if actual == expected {
        return true;
    }
    match tolerance {
        Tolerance::Absolute { absolute } => (actual - expected).abs() < *absolute,
        Tolerance::Ulps { ulps } => {
            let distance = (ordered_bits(actual) - ordered_bits(expected)).unsigned_abs();
            distance <= u128::from(*ulps)
        }
    }
}

fn describe(value: &Decoded) -> &'static str {
    match value {
        Decoded::Null => "null",
        Decoded::Bool(_) => "a boolean",
        Decoded::Number(_) => "a number",
        Decoded::Text(_) => "a text",
        Decoded::Undefined => "undefined",
        Decoded::Array(_) => "an array",
        Decoded::Object(_) => "an object",
        Decoded::Custom { .. } => "a custom value",
    }
}

/// The members of an object by name, the first of a repeated name winning, built once so a lookup is constant time.
fn index(members: &[(Vec<u16>, Decoded)]) -> HashMap<&[u16], &Decoded> {
    let mut by_name = HashMap::with_capacity(members.len());
    for (name, value) in members {
        by_name.entry(name.as_slice()).or_insert(value);
    }
    by_name
}

fn walk<'a>(
    actual: &'a Decoded,
    expected: &'a Decoded,
    tolerance: Option<&Tolerance>,
    partial: bool,
    trail: &mut Trail<'a>,
) -> Result<(), Mismatch> {
    match (expected, actual) {
        (Decoded::Number(wanted), Decoded::Number(got)) => {
            if within(*got, *wanted, tolerance) {
                Ok(())
            } else {
                mismatch(trail, format!("expected {wanted:?}, got {got:?}"))
            }
        }
        (Decoded::Array(wanted), Decoded::Array(got)) => {
            if wanted.len() != got.len() {
                return mismatch(
                    trail,
                    format!("expected {} elements, got {}", wanted.len(), got.len()),
                );
            }
            for (position, (item, other)) in wanted.iter().zip(got).enumerate() {
                trail.push(Step::Index(position));
                let result = walk(other, item, tolerance, partial, trail);
                trail.pop();
                result?;
            }
            Ok(())
        }
        (Decoded::Object(wanted), Decoded::Object(got)) => {
            let present = index(got);
            for (name, item) in wanted {
                trail.push(Step::Units(name));
                let result = match present.get(name.as_slice()) {
                    Some(other) => walk(other, item, tolerance, partial, trail),
                    None if matches!(item, Decoded::Undefined) => mismatch(
                        trail,
                        "expected a member that is undefined, the member is absent",
                    ),
                    None => mismatch(trail, "expected a member, the member is absent"),
                };
                trail.pop();
                result?;
            }
            if !partial {
                let expected = index(wanted);
                for (name, other) in got {
                    if !matches!(other, Decoded::Undefined)
                        && !expected.contains_key(name.as_slice())
                    {
                        trail.push(Step::Units(name));
                        let result = mismatch(trail, "the member is not expected");
                        trail.pop();
                        return result;
                    }
                }
            }
            Ok(())
        }
        (Decoded::Text(wanted), Decoded::Text(got)) if wanted == got => Ok(()),
        (Decoded::Text(wanted), Decoded::Text(got)) => mismatch(
            trail,
            format!("expected {:?}, got {:?}", shown(wanted), shown(got)),
        ),
        (Decoded::Null, Decoded::Null) | (Decoded::Undefined, Decoded::Undefined) => Ok(()),
        (Decoded::Bool(wanted), Decoded::Bool(got)) if wanted == got => Ok(()),
        (
            Decoded::Custom {
                name: left,
                value: a,
            },
            Decoded::Custom {
                name: right,
                value: b,
            },
        ) if left == right && a.json_equal(b) => Ok(()),
        _ => mismatch(
            trail,
            format!("expected {}, got {}", describe(expected), describe(actual)),
        ),
    }
}

/// Whether `actual` equals `expected` under the rules above, and where it first does not.
pub fn compare(
    actual: &Decoded,
    expected: &Decoded,
    tolerance: Option<&Tolerance>,
) -> Result<(), Mismatch> {
    walk(actual, expected, tolerance, false, &mut Vec::new())
}

/// Whether `actual` matches `expected` where `expected` names only some of the members: an object matches when every
/// member it gives matches (a member of `actual` it does not name is not looked at), an array matches element by
/// element at the same length, and any other value must be equal, numbers by the tolerance.
pub fn subset(
    actual: &Decoded,
    expected: &Decoded,
    tolerance: Option<&Tolerance>,
) -> Result<(), Mismatch> {
    walk(actual, expected, tolerance, true, &mut Vec::new())
}

/// Whether the fragments occur in `text` in order, each after the end of the one before, all as UTF-16 code units. With
/// `ignore_ascii_case` the letters A to Z and a to z are compared without regard to case, and no other character is.
/// An empty fragment is refused, since it would match anywhere.
pub fn fragments(
    text: &[u16],
    fragments: &[Vec<u16>],
    ignore_ascii_case: bool,
) -> Result<(), String> {
    let fold = |unit: u16| -> u16 {
        if ignore_ascii_case && (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
            unit + 32
        } else {
            unit
        }
    };
    let mut from = 0;
    for fragment in fragments {
        if fragment.is_empty() {
            return Err("a fragment is not empty".to_owned());
        }
        match find(&text[from..], fragment, fold) {
            Some(start) => from += start + fragment.len(),
            None => {
                return Err(format!(
                    "{:?} does not occur in {:?} after position {from}",
                    shown(fragment),
                    shown(text)
                ));
            }
        }
    }
    Ok(())
}

/// The first position of `pattern` in `text`, comparing units as `fold` maps them, by the Knuth-Morris-Pratt search: the
/// work is linear in the lengths of the two, whatever they hold. `pattern` is not empty.
fn find(text: &[u16], pattern: &[u16], fold: impl Fn(u16) -> u16) -> Option<usize> {
    let wanted: Vec<u16> = pattern.iter().map(|unit| fold(*unit)).collect();
    // `reach[n]` is the length of the longest proper prefix of `wanted[..=n]` that is also a suffix of it.
    let mut reach = vec![0usize; wanted.len()];
    let mut matched = 0;
    for position in 1..wanted.len() {
        while matched > 0 && wanted[position] != wanted[matched] {
            matched = reach[matched - 1];
        }
        if wanted[position] == wanted[matched] {
            matched += 1;
        }
        reach[position] = matched;
    }
    matched = 0;
    for (position, unit) in text.iter().enumerate() {
        let unit = fold(*unit);
        while matched > 0 && unit != wanted[matched] {
            matched = reach[matched - 1];
        }
        if unit == wanted[matched] {
            matched += 1;
        }
        if matched == wanted.len() {
            return Some(position + 1 - wanted.len());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn object(members: Vec<(&str, Decoded)>) -> Decoded {
        Decoded::Object(
            members
                .into_iter()
                .map(|(name, value)| (units(name), value))
                .collect(),
        )
    }

    fn number(value: f64) -> Decoded {
        Decoded::Number(value)
    }

    fn equal(actual: &Decoded, expected: &Decoded) -> bool {
        compare(actual, expected, None).is_ok()
    }

    #[test]
    fn numbers_are_the_same_double() {
        assert!(equal(&number(1.5), &number(1.5)));
        assert!(!equal(&number(1.5), &number(1.6)));
        assert!(!equal(&number(-0.0), &number(0.0)));
        assert!(!equal(&number(0.0), &number(-0.0)));
        assert!(equal(&number(f64::NAN), &number(f64::NAN)));
        assert!(equal(&number(f64::INFINITY), &number(f64::INFINITY)));
        assert!(!equal(&number(f64::INFINITY), &number(f64::NEG_INFINITY)));
    }

    #[test]
    fn an_absolute_tolerance_is_a_strict_bound() {
        let tolerance = Tolerance::Absolute { absolute: 0.5 };
        let within = |actual, expected| {
            compare(&number(actual), &number(expected), Some(&tolerance)).is_ok()
        };
        assert!(within(1.4, 1.0));
        assert!(!within(1.5, 1.0));
        assert!(within(-0.0, 0.0));
    }

    #[test]
    fn an_ulps_tolerance_counts_representable_doubles_and_both_zeros_are_one_point() {
        let tolerance = Tolerance::Ulps { ulps: 1 };
        let next = f64::from_bits(1.0_f64.to_bits() + 1);
        let after = f64::from_bits(1.0_f64.to_bits() + 2);
        let within = |actual, expected| {
            compare(&number(actual), &number(expected), Some(&tolerance)).is_ok()
        };
        assert!(within(next, 1.0));
        assert!(!within(after, 1.0));
        assert!(within(f64::from_bits(1), -0.0));
        assert!(within(-f64::from_bits(1), 0.0));
        assert!(!within(f64::from_bits(2), -f64::from_bits(1)));
        assert!(!within(f64::from_bits(1), -f64::from_bits(1)));
    }

    #[test]
    fn a_tolerance_never_applies_to_a_value_that_is_not_finite() {
        let tolerance = Tolerance::Absolute { absolute: 1e300 };
        assert!(compare(&number(f64::MAX), &number(f64::INFINITY), Some(&tolerance)).is_err());
        assert!(compare(&number(f64::NAN), &number(1.0), Some(&tolerance)).is_err());
    }

    #[test]
    fn a_tolerance_holds_for_every_number_inside_a_value() {
        let tolerance = Tolerance::Absolute { absolute: 0.1 };
        let actual = object(vec![("a", Decoded::Array(vec![number(1.01)]))]);
        let expected = object(vec![("a", Decoded::Array(vec![number(1.0)]))]);
        assert!(compare(&actual, &expected, Some(&tolerance)).is_ok());
        assert!(compare(&actual, &expected, None).is_err());
    }

    #[test]
    fn structure_must_match() {
        let a = Decoded::Array(vec![number(1.0), Decoded::Null]);
        assert!(equal(&a, &a.clone()));
        assert!(!equal(&a, &Decoded::Array(vec![number(1.0)])));
        assert!(!equal(&Decoded::Null, &Decoded::Bool(false)));
        assert!(!equal(
            &Decoded::Text(units("a")),
            &Decoded::Text(units("b"))
        ));
        assert!(equal(
            &Decoded::Text(vec![0xD800]),
            &Decoded::Text(vec![0xD800])
        ));
    }

    #[test]
    fn an_undefined_member_of_the_actual_object_counts_as_absent() {
        let actual = object(vec![("a", number(1.0)), ("b", Decoded::Undefined)]);
        assert!(equal(&actual, &object(vec![("a", number(1.0))])));
        assert!(!equal(
            &object(vec![("a", number(1.0))]),
            &object(vec![("a", number(1.0)), ("b", number(2.0))])
        ));
    }

    #[test]
    fn an_expected_undefined_requires_a_present_undefined_member() {
        let expected = object(vec![("a", Decoded::Undefined)]);
        assert!(equal(&object(vec![("a", Decoded::Undefined)]), &expected));
        assert!(!equal(&object(vec![]), &expected));
        assert!(!equal(&object(vec![("a", Decoded::Null)]), &expected));
    }

    #[test]
    fn member_order_does_not_matter() {
        let one = object(vec![("a", number(1.0)), ("b", number(2.0))]);
        let two = object(vec![("b", number(2.0)), ("a", number(1.0))]);
        assert!(equal(&one, &two));
    }

    #[test]
    fn a_subset_names_only_some_members_and_an_array_has_the_same_length() {
        let actual = object(vec![
            ("a", number(1.0)),
            ("b", Decoded::Array(vec![number(1.0), number(2.0)])),
        ]);
        assert!(subset(&actual, &object(vec![("a", number(1.0))]), None).is_ok());
        assert!(subset(&actual, &object(vec![("c", number(1.0))]), None).is_err());
        assert!(
            subset(
                &actual,
                &object(vec![("b", Decoded::Array(vec![number(1.0)]))]),
                None
            )
            .is_err()
        );
        assert!(
            subset(
                &actual,
                &object(vec![("b", Decoded::Array(vec![number(1.0), number(2.0)]))]),
                None
            )
            .is_ok()
        );
        assert!(subset(&number(0.0), &number(-0.0), None).is_err());
    }

    #[test]
    fn a_mismatch_names_its_place() {
        let actual = object(vec![("a", Decoded::Array(vec![number(1.0), number(2.0)]))]);
        let expected = object(vec![("a", Decoded::Array(vec![number(1.0), number(3.0)]))]);
        assert_eq!(
            compare(&actual, &expected, None).unwrap_err().path,
            "$.a[1]"
        );
    }

    #[test]
    fn fragments_occur_in_order_each_after_the_one_before() {
        let text = units("invalid pattern: anchors cannot be quantified");
        let fragment = |text: &str| units(text);
        assert!(fragments(&text, &[fragment("invalid"), fragment("anchors")], false).is_ok());
        assert!(fragments(&text, &[fragment("anchors"), fragment("invalid")], false).is_err());
        assert!(fragments(&units("aa"), &[fragment("a"), fragment("a")], false).is_ok());
        assert!(fragments(&units("a"), &[fragment("a"), fragment("a")], false).is_err());
        assert!(fragments(&text, &[], false).is_ok());
        assert!(fragments(&text, &[Vec::new()], false).is_err());
    }

    #[test]
    fn ignoring_case_folds_ascii_letters_only() {
        assert!(fragments(&units("Anchors"), &[units("aNCHORS")], true).is_ok());
        assert!(fragments(&units("Anchors"), &[units("aNCHORS")], false).is_err());
        assert!(fragments(&units("É"), &[units("é")], true).is_err());
    }

    #[test]
    fn fragments_count_utf16_code_units() {
        let text = units("😀a");
        assert!(fragments(&text, &[vec![0xD83D, 0xDE00], units("a")], false).is_ok());
        assert!(fragments(&text, &[vec![0xDE00], units("a")], false).is_ok());
    }

    fn custom(name: &str, value: json_shape::Value) -> Decoded {
        Decoded::Custom {
            name: name.to_owned(),
            value,
        }
    }

    #[test]
    fn a_registered_encodings_values_are_equal_by_name_and_json_value() {
        use json_shape::Value;
        let one = custom("$big", Value::String("1".to_owned()));
        assert!(equal(&one, &one.clone()));
        assert!(!equal(&one, &custom("$big", Value::String("2".to_owned()))));
        assert!(!equal(
            &one,
            &custom("$other", Value::String("1".to_owned()))
        ));
        // Equal as JSON Schema defines it: the order of an object's members does not matter.
        let first = custom(
            "$big",
            Value::Object(vec![
                ("a".to_owned(), Value::Null),
                ("b".to_owned(), Value::Null),
            ]),
        );
        let second = custom(
            "$big",
            Value::Object(vec![
                ("b".to_owned(), Value::Null),
                ("a".to_owned(), Value::Null),
            ]),
        );
        assert!(equal(&first, &second));
        assert!(!equal(&one, &Decoded::Null));
    }

    #[test]
    fn an_object_of_many_members_is_compared_in_linear_time() {
        // A scan for each member is some 4 * 10^10 steps, which takes minutes; a lookup table takes milliseconds.
        let members = |reverse: bool| {
            let mut names: Vec<usize> = (0..200_000).collect();
            if reverse {
                names.reverse();
            }
            Decoded::Object(
                names
                    .into_iter()
                    .map(|n| (units(&n.to_string()), number(n as f64)))
                    .collect(),
            )
        };
        assert!(equal(&members(false), &members(true)));
        assert!(subset(&members(false), &members(true), None).is_ok());
    }

    #[test]
    fn a_search_that_backs_up_over_a_partial_match_still_finds_it() {
        let find =
            |text: &str, fragment: &str| fragments(&units(text), &[units(fragment)], false).is_ok();
        assert!(find("aaab", "aab"));
        assert!(find("abababc", "ababc"));
        assert!(find("aabaabaaa", "aabaaa"));
        assert!(!find("aabaab", "aabaaa"));
        assert!(find("a", "a"));
        assert!(!find("", "a"));
        assert!(!find("a", "ab"));
    }

    #[test]
    fn a_long_text_and_fragment_are_searched_in_linear_time() {
        // The worst case of a search that tries every start: a text of a's and a fragment of a's ending in a b is some
        // 10^10 steps for these lengths, which takes minutes; the linear search takes milliseconds.
        let text = vec![u16::from(b'a'); 200_000];
        let mut fragment = vec![u16::from(b'a'); 100_000];
        fragment.push(u16::from(b'b'));
        assert!(fragments(&text, &[fragment.clone()], false).is_err());
        let mut found = text;
        found.push(u16::from(b'b'));
        assert!(fragments(&found, &[fragment], false).is_ok());
    }

    #[test]
    fn members_under_a_long_name_are_compared_without_a_path_string_each() {
        // The comparison takes its place as a stack of steps (`walk` has no parameter a path string could be passed in), and
        // writes it out only for a difference: the count of trails written is the work, and is the same however long the
        // name and however many the members. The count does not see a `format!` that bypasses the trail; the signature of
        // `walk`, which this test calls with a trail, makes one impossible without changing it, and a changed signature
        // does not compile here.
        let long = "k".repeat(10_000);
        let wide = |last: f64| {
            let members = Decoded::Object(
                (0..100_000)
                    .map(|n| {
                        (
                            units(&format!("{n:08}")),
                            number(if n == 99_999 { last } else { 0.0 }),
                        )
                    })
                    .collect(),
            );
            Decoded::Object(vec![(units(&long), members)])
        };
        let (one, two) = (wide(1.0), wide(2.0));
        let mut trail: crate::trail::Trail<'_> = Vec::new();
        crate::trail::RENDERED.with(|count| count.set(0));
        assert!(walk(&one, &one, None, false, &mut trail).is_ok());
        assert_eq!(crate::trail::RENDERED.with(std::cell::Cell::get), 0);
        let mismatch = walk(&two, &one, None, false, &mut trail).unwrap_err();
        assert_eq!(crate::trail::RENDERED.with(std::cell::Cell::get), 1);
        assert!(trail.is_empty());
        assert!(mismatch.path.ends_with(".00099999"));
        assert_eq!(mismatch.path.len(), 1 + 1 + 10_000 + 1 + 8);
    }
}
