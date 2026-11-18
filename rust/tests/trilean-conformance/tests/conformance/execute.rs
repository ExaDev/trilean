//! Runs the cases of the kinds the native crates execute against them: the regex cases, the cases that read a document as one of trilean's schemas, the ones that read and write a document again, the ones that write a number, and the ones that evaluate a tree (see `evaluate`). A file reaches this module only after `validate` has accepted it in full, so a field that the format requires is read without a second check of its shape.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};
use trilean_regex::{
    CharClassNode, RegexInputError, RegexNode, TestPatternError, compile_ecmascript_subset_utf16,
    compile_pattern_utf16, parse_regex_utf16, test_pattern,
};

use crate::evaluate;
use crate::validate::decode_text;

type Check<T> = Result<T, String>;

/// What running a file did: how many cases it executed, and what failed.
pub struct Outcome {
    pub executed: usize,
    pub failures: Vec<String>,
    /// The node kinds and operators the trees of the executed `evaluate` cases hold, as `(field, value)` pairs.
    pub evaluated_tags: BTreeSet<(String, String)>,
}

/// Executes every case of a validated file that is of a regex kind and that this implementation does not skip. A case marked `skip: ts` is executed, since the mark names the implementation that skips it.
pub fn run_file(name: &str, file: &Value) -> Outcome {
    let mut outcome = Outcome {
        executed: 0,
        failures: Vec::new(),
        evaluated_tags: BTreeSet::new(),
    };
    let cases = file["cases"].as_array().map_or(&[][..], Vec::as_slice);
    for case in cases {
        let executes = match case["kind"].as_str() {
            Some("regex-parse" | "regex-match" | "validate" | "serialise" | "number-format") => {
                true
            }
            Some("evaluate") => evaluate::executes(case),
            _ => false,
        };
        if !executes || case.get("skip").and_then(Value::as_str) == Some("rust") {
            continue;
        }
        if case["kind"].as_str() == Some("evaluate") {
            evaluate::collect_tags(&case["tree"], &mut outcome.evaluated_tags);
            evaluate::collect_tags(&case["resolvers"]["trees"], &mut outcome.evaluated_tags);
        }
        outcome.executed += 1;
        if let Err(error) = run_case(case) {
            outcome.failures.push(format!(
                "{name}: {} ({}): {error}",
                case["id"].as_str().unwrap_or("?"),
                case["from"].as_str().unwrap_or("?")
            ));
        }
    }
    outcome
}

fn run_case(case: &Value) -> Check<()> {
    match case["kind"].as_str() {
        Some("regex-parse") => run_parse_case(case),
        Some("regex-match") => run_match_case(case),
        Some("validate") => run_validate_case(case),
        Some("serialise") => run_serialise_case(case),
        Some("number-format") => run_number_format_case(case),
        Some("evaluate") => evaluate::run_case(case),
        other => Err(format!("no executor for the kind {other:?}")),
    }
}

fn units_text(units: &[u16]) -> String {
    format!("{units:?}")
}

fn node_to_json(node: &RegexNode) -> Value {
    match node {
        RegexNode::Literal { code_unit } => json!({ "kind": "literal", "codeUnit": code_unit }),
        RegexNode::AnyChar => json!({ "kind": "anyChar" }),
        RegexNode::CharClass(class) => class_to_json(class),
        RegexNode::AnchorStart => json!({ "kind": "anchorStart" }),
        RegexNode::AnchorEnd => json!({ "kind": "anchorEnd" }),
        RegexNode::Concat(operands) => {
            json!({ "kind": "concat", "operands": operands.iter().map(node_to_json).collect::<Vec<_>>() })
        }
        RegexNode::Alternation(branches) => {
            json!({ "kind": "alternation", "branches": branches.iter().map(node_to_json).collect::<Vec<_>>() })
        }
        RegexNode::Star(operand) => json!({ "kind": "star", "operand": node_to_json(operand) }),
        RegexNode::Plus(operand) => json!({ "kind": "plus", "operand": node_to_json(operand) }),
        RegexNode::Optional(operand) => {
            json!({ "kind": "optional", "operand": node_to_json(operand) })
        }
        RegexNode::Repeat { operand, min, max } => {
            let mut repeat = Map::new();
            repeat.insert("kind".to_owned(), json!("repeat"));
            repeat.insert("operand".to_owned(), node_to_json(operand));
            repeat.insert("min".to_owned(), json!(min));
            // JSON has no `undefined`, so an unbounded repeat leaves `max` out.
            if let Some(max) = max {
                repeat.insert("max".to_owned(), json!(max));
            }
            Value::Object(repeat)
        }
    }
}

fn class_to_json(class: &CharClassNode) -> Value {
    json!({
        "kind": "charClass",
        "negated": class.negated,
        "ranges": class.ranges.iter().map(|range| json!({ "from": range.from, "to": range.to })).collect::<Vec<_>>(),
    })
}

/// Structural equality, the order of an object's members not counting and a number being equal to the number it reads as, so `97` and `97.0` are one value.
fn values_equal(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| values_equal(x, y))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, x)| b.get(key).is_some_and(|y| values_equal(x, y)))
        }
        _ => actual == expected,
    }
}

/// An object matches when every key `expected` gives matches; an array matches element by element at the same length; any other value must be equal.
fn subset_matches(actual: &Value, expected: &Value) -> bool {
    match expected {
        Value::Object(keys) => keys
            .iter()
            .all(|(key, want)| actual.get(key).is_some_and(|got| subset_matches(got, want))),
        Value::Array(items) => actual.as_array().is_some_and(|got| {
            got.len() == items.len() && got.iter().zip(items).all(|(x, y)| subset_matches(x, y))
        }),
        _ => values_equal(actual, expected),
    }
}

/// Whether every fragment occurs in `text`, each after the end of the one before.
fn contains_in_order(text: &[u16], fragments: &[Vec<u16>]) -> bool {
    let mut from = 0;
    for fragment in fragments {
        let found = text[from..]
            .windows(fragment.len())
            .position(|window| window == fragment.as_slice());
        match found {
            Some(at) => from += at + fragment.len(),
            None => return false,
        }
    }
    true
}

fn run_parse_case(case: &Value) -> Check<()> {
    let pattern = decode_text(&case["pattern"])?;
    let parsed = parse_regex_utf16(&pattern);
    let expectation = &case["expect"];
    if let Some(ast) = expectation.get("ast") {
        let node =
            parsed.map_err(|error| format!("{} was refused: {error}", units_text(&pattern)))?;
        let actual = node_to_json(&node);
        return if values_equal(&actual, ast) {
            Ok(())
        } else {
            Err(format!("parsed to {actual}, expected {ast}"))
        };
    }
    if let Some(subset) = expectation.get("astSubset") {
        let node =
            parsed.map_err(|error| format!("{} was refused: {error}", units_text(&pattern)))?;
        let actual = node_to_json(&node);
        return if subset_matches(&actual, subset) {
            Ok(())
        } else {
            Err(format!("parsed to {actual}, which lacks {subset}"))
        };
    }
    let expected = &expectation["error"];
    let error = parsed.err().ok_or_else(|| {
        format!(
            "{} parsed, but the case expects an error",
            units_text(&pattern)
        )
    })?;
    if let Some(index) = expected.get("index").and_then(Value::as_u64)
        && u64::try_from(error.index()) != Ok(index)
    {
        return Err(format!(
            "error at index {}, expected {index}",
            error.index()
        ));
    }
    if let Some(fragments) = expected.get("message").and_then(Value::as_array) {
        let fragments = fragments
            .iter()
            .map(decode_text)
            .collect::<Check<Vec<_>>>()?;
        if !contains_in_order(error.reason_utf16(), &fragments) {
            return Err(format!(
                "reason {:?} lacks, in order, {fragments:?}",
                error.reason()
            ));
        }
    }
    Ok(())
}

/// The work a pattern may do for an input: `factor` times (pattern length + 1) times (input length + 1), in UTF-16 code units, which is the bound the corpus states.
fn work_limit(factor: u64, pattern: &[u16], input: &[u16]) -> u128 {
    u128::from(factor) * (pattern.len() as u128 + 1) * (input.len() as u128 + 1)
}

fn run_match_case(case: &Value) -> Check<()> {
    let pattern = decode_text(&case["pattern"])?;
    let ecmascript = case.get("dialect").and_then(Value::as_str) == Some("ecmascript");
    let compile = |units: &[u16]| {
        if ecmascript {
            compile_ecmascript_subset_utf16(units).map_err(|error| error.to_string())
        } else {
            compile_pattern_utf16(units).map_err(|error| error.to_string())
        }
    };
    let compiled = compile(&pattern)
        .map_err(|error| format!("{} was refused: {error}", units_text(&pattern)))?;
    let pattern_text = String::from_utf16(&pattern).ok();
    for item in case["inputs"].as_array().map_or(&[][..], Vec::as_slice) {
        let input = decode_text(&item["input"])?;
        // A refused input has no answer: every way of testing it is refused, with an error that names a limit.
        let expected = item["matches"].as_bool();
        let label = units_text(&input);
        let check = |entry: &str, actual: Result<bool, RegexInputError>| {
            let actual = actual.ok();
            if actual == expected {
                Ok(())
            } else {
                Err(format!(
                    "{entry}: input code units {label} gave {actual:?}, expected {expected:?}"
                ))
            }
        };
        let (counted, visits) = match compiled.test_utf16_counted(&input) {
            Ok((matched, visits)) => (Ok(matched), visits),
            Err(error) => (Err(error), 0),
        };
        check("compiled once", counted)?;
        check("compiled per call", compile(&pattern)?.test_utf16(&input))?;
        if let Ok(text) = String::from_utf16(&input) {
            check("compiled once, as text", compiled.test(&text))?;
            if !ecmascript && let Some(source) = &pattern_text {
                check(
                    "test_pattern",
                    match test_pattern(source, &text) {
                        Ok(matched) => Ok(matched),
                        Err(TestPatternError::Input(error)) => Err(error),
                        Err(error) => return Err(error.to_string()),
                    },
                )?;
            }
        }
        if let Some(factor) = item
            .get("workBound")
            .and_then(|bound| bound["factor"].as_u64())
        {
            let limit = work_limit(factor, &pattern, &input);
            if u128::try_from(visits).ok().is_none_or(|v| v > limit) {
                return Err(format!(
                    "input code units {label}: {visits} state visits, over the bound of {limit}"
                ));
            }
        }
    }
    Ok(())
}

/// The corpus JSON value as the value a schema reads, with each `{"$number": ...}` that names a number the canonical
/// JSON form cannot hold replaced by that number. `Ok(None)` when the value holds a NaN or an infinity, which no value
/// of `json_shape` can: a schema refuses such a number, so a case that has one expects a refusal. A name `$number`
/// does not know is an error, so a misspelt name cannot be read as a refusal.
fn decode_value(value: &Value) -> Check<Option<json_shape::Value>> {
    Ok(Some(match value {
        Value::Null => json_shape::Value::Null,
        Value::Bool(flag) => json_shape::Value::Bool(*flag),
        Value::Number(number) => json_shape::Value::Number(
            number
                .as_f64()
                .ok_or_else(|| format!("the number {number} is not a double"))?,
        ),
        Value::String(text) => json_shape::Value::String(text.clone()),
        Value::Array(items) => {
            let mut decoded = Vec::with_capacity(items.len());
            for item in items {
                match decode_value(item)? {
                    Some(item) => decoded.push(item),
                    None => return Ok(None),
                }
            }
            json_shape::Value::Array(decoded)
        }
        Value::Object(members) => {
            if members.len() == 1
                && let Some(Value::String(name)) = members.get("$number")
            {
                return match name.as_str() {
                    "-0" => Ok(Some(json_shape::Value::Number(-0.0))),
                    "Infinity" | "-Infinity" | "NaN" => Ok(None),
                    other => Err(format!(
                        "$number names {other}, which is not a number a corpus file names"
                    )),
                };
            }
            let mut decoded = Vec::with_capacity(members.len());
            for (key, entry) in members {
                match decode_value(entry)? {
                    Some(entry) => decoded.push((key.clone(), entry)),
                    None => return Ok(None),
                }
            }
            json_shape::Value::Object(decoded)
        }
    }))
}

/// Whether two values are equal as the corpus compares them: the same doubles, a negative zero not being a zero, and
/// an object's members in any order.
fn identical(read: &json_shape::Value, expected: &json_shape::Value) -> bool {
    use json_shape::Value::{Array, Bool, Null, Number, Object, String};
    match (read, expected) {
        (Null, Null) => true,
        (Bool(a), Bool(b)) => a == b,
        (Number(a), Number(b)) => a.to_bits() == b.to_bits() || (a == b && *a != 0.0),
        (String(a), String(b)) => a == b,
        (Array(a), Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| identical(x, y)),
        (Object(a), Object(b)) => {
            a.len() == b.len()
                && a.iter().all(|(key, x)| {
                    b.iter()
                        .find(|(name, _)| name == key)
                        .is_some_and(|(_, y)| identical(x, y))
                })
        }
        _ => false,
    }
}

/// The path of an issue as the corpus writes it: a list of keys and indexes.
fn path_of(issue: &json_shape::Issue) -> Value {
    Value::Array(
        issue
            .path
            .iter()
            .map(|step| match step {
                json_shape::PathSegment::Key(key) => json!(key),
                json_shape::PathSegment::Index(index) => json!(index),
            })
            .collect(),
    )
}

fn run_validate_case(case: &Value) -> Check<()> {
    let name = case["schema"].as_str().unwrap_or_default();
    let wanted = &case["expect"];
    let accepted = wanted["ok"].as_bool() == Some(true);
    let read = match decode_value(&case["input"])? {
        Some(input) => trilean::schemas::read(name, &input)
            .ok_or_else(|| format!("no schema is exported under the name {name}"))?,
        None => Err(Vec::new()),
    };
    match (read, accepted) {
        (Ok(read), true) => match wanted.get("value") {
            None => Ok(()),
            Some(expected) => {
                let expected = decode_value(expected)?
                    .ok_or("the expected value holds a NaN or an infinity")?;
                if identical(&read, &expected) {
                    Ok(())
                } else {
                    Err(format!("{name} read {read}, expected {expected}"))
                }
            }
        },
        (Err(issues), false) => match wanted.get("paths").and_then(Value::as_array) {
            None => Ok(()),
            Some(expected) => {
                let mut found: Vec<String> = issues
                    .iter()
                    .map(|issue| path_of(issue).to_string())
                    .collect();
                found.sort();
                found.dedup();
                let mut expected: Vec<String> = expected.iter().map(Value::to_string).collect();
                expected.sort();
                if found == expected {
                    Ok(())
                } else {
                    Err(format!(
                        "{name} refused at {found:?}, expected {expected:?}"
                    ))
                }
            }
        },
        (Ok(read), false) => Err(format!("{name} accepted the input and read {read}")),
        (Err(issues), true) => Err(format!(
            "{name} refused the input: {}",
            issues
                .iter()
                .map(|issue| format!("{} {}", issue.pointer(), issue.message))
                .collect::<Vec<_>>()
                .join("; ")
        )),
    }
}

fn run_serialise_case(case: &Value) -> Check<()> {
    let name = case["schema"].as_str().unwrap_or_default();
    let text = case["input"].as_str().unwrap_or_default();
    let input: json_shape::Value =
        serde_json::from_str(text).map_err(|error| format!("the input is not JSON: {error}"))?;
    let read = trilean::schemas::read(name, &input)
        .ok_or_else(|| format!("no schema is exported under the name {name}"))?
        .map_err(|issues| format!("{name} refused the input: {} problems", issues.len()))?;
    let written = read.to_string();
    let expected = case["expect"].as_str().unwrap_or_default();
    if written == expected {
        Ok(())
    } else {
        Err(format!("written {written}, expected {expected}"))
    }
}

fn run_number_format_case(case: &Value) -> Check<()> {
    let value = &case["value"];
    let number = match value {
        Value::Object(members) => match members.get("$number").and_then(Value::as_str) {
            Some("-0") => -0.0,
            Some("Infinity") => f64::INFINITY,
            Some("-Infinity") => f64::NEG_INFINITY,
            Some("NaN") => f64::NAN,
            other => return Err(format!("$number names {other:?}")),
        },
        other => other
            .as_f64()
            .ok_or("a number-format case needs a number")?,
    };
    let written = trilean::ecmascript::number_to_string(number);
    let expected = case["expect"].as_str().unwrap_or_default();
    if written == expected {
        Ok(())
    } else {
        Err(format!("written {written}, expected {expected}"))
    }
}
