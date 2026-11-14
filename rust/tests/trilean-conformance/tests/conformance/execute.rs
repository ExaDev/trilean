//! Runs the regex cases against the native crate. A file reaches this module only after `validate` has accepted it in full, so a field that the format requires is read without a second check of its shape.

use serde_json::{Map, Value, json};
use trilean_regex::{
    CharClassNode, RegexNode, compile_ecmascript_subset_utf16, compile_pattern_utf16,
    parse_regex_utf16, test_pattern,
};

use crate::validate::decode_text;

type Check<T> = Result<T, String>;

/// What running a file did: how many cases it executed, and what failed.
pub struct Outcome {
    pub executed: usize,
    pub failures: Vec<String>,
}

/// Executes every case of a validated file that this implementation does not skip. A case marked `skip: ts` is executed, since the mark names the implementation that skips it.
pub fn run_file(name: &str, file: &Value) -> Outcome {
    let mut outcome = Outcome {
        executed: 0,
        failures: Vec::new(),
    };
    let cases = file["cases"].as_array().map_or(&[][..], Vec::as_slice);
    for case in cases {
        if case.get("skip").and_then(Value::as_str) == Some("rust") {
            continue;
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
    let pattern = decode_text(&case["pattern"], "pattern")?;
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
            .map(|fragment| decode_text(fragment, "message"))
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
    let pattern = decode_text(&case["pattern"], "pattern")?;
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
        let input = decode_text(&item["input"], "input")?;
        let expected = item["matches"].as_bool().unwrap_or(false);
        let label = units_text(&input);
        let check = |entry: &str, actual: bool| {
            if actual == expected {
                Ok(())
            } else {
                Err(format!(
                    "{entry}: input code units {label} gave {actual}, expected {expected}"
                ))
            }
        };
        let (counted, visits) = compiled.test_utf16_counted(&input);
        check("compiled once", counted)?;
        check("compiled per call", compile(&pattern)?.test_utf16(&input))?;
        if let Ok(text) = String::from_utf16(&input) {
            check("compiled once, as text", compiled.test(&text))?;
            if !ecmascript && let Some(source) = &pattern_text {
                check(
                    "test_pattern",
                    test_pattern(source, &text).map_err(|error| error.to_string())?,
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
