//! Validation of corpus files and the manifest, by hand until the validator is generated from the schema. It
//! accepts exactly what `conformance/case.schema.json` accepts and rejects every case kind it does not validate
//! in full, rather than passing it unchecked: a loader that cannot judge a case must not say it is fine.
//!
//! Strings in the corpus are sequences of UTF-16 code units. A JSON string is read by `serde_json`, which refuses
//! an unpaired surrogate escape, so the file holding one does not load and is rejected; content that needs one is
//! written as `{ "codeUnits": [...] }`, which `decode_text` reads into the same `u16` sequence a JSON string gives.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

type Check<T> = Result<T, String>;

/// The largest value of a UTF-16 code unit, which bounds a literal's `codeUnit` and a range's ends.
const MAX_CODE_UNIT: u64 = 65535;

/// The largest integer a JSON number holds exactly in the JavaScript runners, and so the largest the format allows.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Whether a name (a case id, or a directory or file name of a corpus file) uses only lower-case ASCII letters,
/// digits, dots, hyphens and underscores, and does not start with a punctuation character, so every loader orders
/// names the same way.
pub fn is_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

/// Whether a case's `from` is an original test title (`<test file>.test.ts: <title>`) or a recorded behaviour
/// (`recorded: <package> <source file> (<what>)`), so a reader can tell a pinned original from a recorded one.
fn is_valid_from(from: &str) -> bool {
    if let Some(rest) = from.strip_prefix("recorded: ") {
        return !rest.is_empty();
    }
    from.split_once(".test.ts: ").is_some_and(|(stem, title)| {
        !stem.is_empty()
            && !title.is_empty()
            && stem.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            })
    })
}

/// A string as the UTF-16 code units it denotes: a JSON string, or `{ "codeUnits": [...] }` for content a JSON
/// string cannot carry. The second form is what lets a case hold an unpaired surrogate.
pub fn decode_text(value: &Value, at: &str) -> Check<Vec<u16>> {
    if let Some(text) = value.as_str() {
        return Ok(text.encode_utf16().collect());
    }
    let map = exact_keys(value, at, &["codeUnits"], &[])?;
    array(&map["codeUnits"], at, "\"codeUnits\"")?
        .iter()
        .map(|unit| {
            as_integer(unit)
                .and_then(|unit| u16::try_from(unit).ok())
                .ok_or_else(|| {
                    format!("{at}: a code unit must be an integer from 0 to {MAX_CODE_UNIT}")
                })
        })
        .collect()
}

const COMMON_KEYS: [&str; 3] = ["id", "from", "kind"];
const OPTIONAL_COMMON_KEYS: [&str; 3] = ["skip", "reason", "tolerance"];

fn object<'a>(value: &'a Value, at: &str) -> Check<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| format!("{at}: expected an object"))
}

fn array<'a>(value: &'a Value, at: &str, what: &str) -> Check<&'a Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| format!("{at}: {what} must be an array"))
}

/// The object at `at`, holding every key in `required`, and no key outside `required` and `optional`.
fn exact_keys<'a>(
    value: &'a Value,
    at: &str,
    required: &[&str],
    optional: &[&str],
) -> Check<&'a Map<String, Value>> {
    let map = object(value, at)?;
    for key in required {
        if !map.contains_key(*key) {
            return Err(format!("{at}: missing \"{key}\""));
        }
    }
    for key in map.keys() {
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return Err(format!("{at}: unexpected \"{key}\""));
        }
    }
    Ok(map)
}

fn string_field<'a>(map: &'a Map<String, Value>, key: &str, at: &str) -> Check<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{at}: \"{key}\" must be a string"))
}

fn non_empty_string_field<'a>(map: &'a Map<String, Value>, key: &str, at: &str) -> Check<&'a str> {
    let text = string_field(map, key, at)?;
    if text.is_empty() {
        return Err(format!("{at}: \"{key}\" must not be empty"));
    }
    Ok(text)
}

/// A non-negative JSON integer. Like JSON Schema's `integer`, `97.0` is one, and `97.5` is not.
fn as_integer(value: &Value) -> Option<u64> {
    let integer = if let Some(integer) = value.as_u64() {
        integer
    } else {
        let float = value.as_f64()?;
        if !(float >= 0.0 && float.fract() == 0.0 && float <= MAX_SAFE_INTEGER as f64) {
            return None;
        }
        // The checks above bound the value to a non-negative whole number below 2^53, which `u64` holds exactly.
        float as u64
    };
    (integer <= MAX_SAFE_INTEGER).then_some(integer)
}

fn integer_field(map: &Map<String, Value>, key: &str, at: &str) -> Check<u64> {
    map.get(key)
        .and_then(as_integer)
        .ok_or_else(|| format!("{at}: \"{key}\" must be a non-negative integer"))
}

fn code_unit_field(map: &Map<String, Value>, key: &str, at: &str) -> Check<u64> {
    let value = integer_field(map, key, at)?;
    if value > MAX_CODE_UNIT {
        return Err(format!("{at}: \"{key}\" must be at most {MAX_CODE_UNIT}"));
    }
    Ok(value)
}

fn boolean_field(map: &Map<String, Value>, key: &str, at: &str) -> Check<bool> {
    map.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("{at}: \"{key}\" must be a boolean"))
}

fn check_regex_node(value: &Value, at: &str) -> Check<()> {
    let map = object(value, at)?;
    match string_field(map, "kind", at)? {
        "literal" => {
            exact_keys(value, at, &["kind", "codeUnit"], &[])?;
            code_unit_field(map, "codeUnit", at).map(drop)
        }
        "anyChar" | "anchorStart" | "anchorEnd" => exact_keys(value, at, &["kind"], &[]).map(drop),
        "charClass" => {
            exact_keys(value, at, &["kind", "negated", "ranges"], &[])?;
            boolean_field(map, "negated", at)?;
            let ranges = array(&map["ranges"], at, "\"ranges\"")?;
            if ranges.is_empty() {
                return Err(format!("{at}: \"ranges\" must not be empty"));
            }
            for range in ranges {
                let range_map = exact_keys(range, at, &["from", "to"], &[])?;
                let from = code_unit_field(range_map, "from", at)?;
                let to = code_unit_field(range_map, "to", at)?;
                if from > to {
                    return Err(format!("{at}: a range's from is above its to"));
                }
            }
            Ok(())
        }
        kind @ ("concat" | "alternation") => {
            let key = if kind == "concat" {
                "operands"
            } else {
                "branches"
            };
            exact_keys(value, at, &["kind", key], &[])?;
            array(&map[key], at, key)?
                .iter()
                .try_for_each(|child| check_regex_node(child, at))
        }
        "star" | "plus" | "optional" => {
            exact_keys(value, at, &["kind", "operand"], &[])?;
            check_regex_node(&map["operand"], at)
        }
        "repeat" => {
            exact_keys(value, at, &["kind", "operand", "min"], &["max"])?;
            check_regex_node(&map["operand"], at)?;
            let min = integer_field(map, "min", at)?;
            if map.contains_key("max") && min > integer_field(map, "max", at)? {
                return Err(format!("{at}: a repeat's min is above its max"));
            }
            Ok(())
        }
        other => Err(format!("{at}: unknown regex node kind \"{other}\"")),
    }
}

fn check_regex_parse_expectation(value: &Value, at: &str) -> Check<()> {
    let map = object(value, at)?;
    if let Some(ast) = map.get("ast") {
        exact_keys(value, at, &["ast"], &[])?;
        check_regex_node(ast, at)
    } else if let Some(subset) = map.get("astSubset") {
        exact_keys(value, at, &["astSubset"], &[])?;
        if object(subset, at)?.is_empty() {
            return Err(format!("{at}: \"astSubset\" must name at least one key"));
        }
        Ok(())
    } else {
        let outer = exact_keys(value, at, &["error"], &[])?;
        let error = exact_keys(&outer["error"], at, &[], &["index", "message"])?;
        if error.is_empty() {
            return Err(format!("{at}: \"error\" must name an index or a message"));
        }
        if error.contains_key("index") {
            integer_field(error, "index", at)?;
        }
        if let Some(message) = error.get("message") {
            let fragments = array(message, at, "\"message\"")?;
            if fragments.is_empty() {
                return Err(format!("{at}: \"message\" must not be empty"));
            }
            for fragment in fragments {
                if decode_text(fragment, at)?.is_empty() {
                    return Err(format!("{at}: \"message\" must hold non-empty texts"));
                }
            }
        }
        Ok(())
    }
}

fn check_regex_match_inputs(value: &Value, at: &str) -> Check<()> {
    let inputs = array(value, at, "\"inputs\"")?;
    if inputs.is_empty() {
        return Err(format!("{at}: \"inputs\" must not be empty"));
    }
    for item in inputs {
        let map = exact_keys(item, at, &["input", "matches"], &[])?;
        decode_text(&map["input"], at)?;
        boolean_field(map, "matches", at)?;
    }
    Ok(())
}

fn check_tolerance(value: &Value, at: &str) -> Check<()> {
    let map = exact_keys(value, at, &["ulps"], &[])?;
    integer_field(map, "ulps", at).map(drop)
}

/// Checks one case and returns its id. Only the regex kinds are validated in full; any other kind is refused,
/// even one the schema defines, because a case this loader cannot judge must not read as accepted.
fn check_case(value: &Value, at: &str) -> Check<String> {
    let map = object(value, at)?;
    for key in COMMON_KEYS {
        if !map.contains_key(key) {
            return Err(format!("{at}: missing \"{key}\""));
        }
    }
    let id = non_empty_string_field(map, "id", at)?;
    if !is_name(id) {
        return Err(format!(
            "{at}: a case id uses lower-case ASCII letters, digits, dots, hyphens and underscores"
        ));
    }
    if !is_valid_from(non_empty_string_field(map, "from", at)?) {
        return Err(format!(
            "{at}: \"from\" must be \"<test file>.test.ts: <title>\" or \"recorded: <what>\""
        ));
    }
    if let Some(skip) = map.get("skip")
        && !matches!(skip.as_str(), Some("ts" | "rust"))
    {
        return Err(format!("{at}: \"skip\" must be \"ts\" or \"rust\""));
    }
    if map.contains_key("skip") != map.contains_key("reason") {
        return Err(format!("{at}: \"skip\" and \"reason\" go together"));
    }
    if map.contains_key("reason") {
        non_empty_string_field(map, "reason", at)?;
    }
    if let Some(tolerance) = map.get("tolerance") {
        check_tolerance(tolerance, at)?;
    }
    let kind = string_field(map, "kind", at)?;
    match kind {
        "regex-parse" => {
            exact_keys(
                value,
                at,
                &[COMMON_KEYS.as_slice(), &["pattern", "expect"]].concat(),
                &OPTIONAL_COMMON_KEYS,
            )?;
            decode_text(&map["pattern"], at)?;
            check_regex_parse_expectation(&map["expect"], at)?;
        }
        "regex-match" => {
            exact_keys(
                value,
                at,
                &[COMMON_KEYS.as_slice(), &["pattern", "inputs"]].concat(),
                &OPTIONAL_COMMON_KEYS,
            )?;
            decode_text(&map["pattern"], at)?;
            check_regex_match_inputs(&map["inputs"], at)?;
        }
        other => {
            return Err(format!(
                "{at}: the {other} kind is not validated by this loader, and an unchecked case is not accepted"
            ));
        }
    }
    Ok(id.to_owned())
}

/// What a valid corpus file holds, for the checks that compare files with each other and with the manifest.
pub struct FileFacts {
    pub ids: Vec<String>,
    /// The ids of the cases marked to be skipped by one implementation, sorted.
    pub skip_ids: Vec<String>,
    /// The ids of the cases marked `rust`, the ones this implementation skips because they are marked, sorted.
    pub rust_skip_ids: Vec<String>,
}

pub fn validate_file(value: &Value) -> Check<FileFacts> {
    let top = exact_keys(value, "file", &["cases"], &[])?;
    let cases = array(&top["cases"], "file", "\"cases\"")?;
    if cases.is_empty() {
        return Err("file: \"cases\" must not be empty".to_owned());
    }
    let mut facts = FileFacts {
        ids: Vec::new(),
        skip_ids: Vec::new(),
        rust_skip_ids: Vec::new(),
    };
    let mut seen = BTreeSet::new();
    for (position, case) in cases.iter().enumerate() {
        let id = check_case(case, &format!("case {position}"))?;
        if !seen.insert(id.clone()) {
            return Err(format!("case id {id} is used twice in the file"));
        }
        if case.get("skip").is_some() {
            facts.skip_ids.push(id.clone());
        }
        if case.get("skip").and_then(Value::as_str) == Some("rust") {
            facts.rust_skip_ids.push(id.clone());
        }
        facts.ids.push(id);
    }
    facts.skip_ids.sort();
    facts.rust_skip_ids.sort();
    Ok(facts)
}

/// The manifest as a map from corpus file to its case count and the ids marked to be skipped by one side.
pub fn validate_manifest(value: &Value) -> Check<BTreeMap<String, (usize, Vec<String>)>> {
    let top = exact_keys(value, "manifest", &["files"], &[])?;
    let files = object(&top["files"], "manifest")?;
    if files.is_empty() {
        return Err("manifest: \"files\" must not be empty".to_owned());
    }
    let mut manifest = BTreeMap::new();
    for (name, entry) in files {
        let at = format!("manifest {name}");
        let parts: Vec<&str> = name.split('/').collect();
        if parts.len() != 3 || !parts.iter().all(|part| is_name(part)) || !name.ends_with(".json") {
            return Err(format!(
                "{at}: a corpus file is named <package>/<area>/<name>.json"
            ));
        }
        let map = exact_keys(entry, &at, &["cases", "skip"], &[])?;
        let count = integer_field(map, "cases", &at)?;
        if count == 0 {
            return Err(format!("{at}: \"cases\" must be at least 1"));
        }
        let mut skip = Vec::new();
        for id in array(&map["skip"], &at, "\"skip\"")? {
            skip.push(
                id.as_str()
                    .filter(|text| is_name(text))
                    .ok_or_else(|| format!("{at}: \"skip\" must hold case ids"))?
                    .to_owned(),
            );
        }
        if !skip.windows(2).all(|pair| pair[0] < pair[1]) {
            return Err(format!(
                "{at}: \"skip\" must list distinct ids in ascending order"
            ));
        }
        let count = usize::try_from(count).map_err(|error| format!("{at}: {error}"))?;
        manifest.insert(name.clone(), (count, skip));
    }
    Ok(manifest)
}

/// Checks the validator against documents written here rather than read from the corpus, for what a JSON file
/// cannot hold: the corpus is canonical JSON, which writes `97.0` as `97`.
pub fn self_check(failures: &mut Vec<String>) {
    let node = |text: &str| {
        serde_json::from_str::<Value>(text).map(|value| check_regex_node(&value, "self-check"))
    };
    match node(r#"{"kind":"literal","codeUnit":97.0}"#) {
        Ok(Ok(())) => {}
        other => failures.push(format!(
            "self-check: 97.0 must be accepted as an integer, got {other:?}"
        )),
    }
    match node(r#"{"kind":"literal","codeUnit":97.5}"#) {
        Ok(Err(_)) => {}
        other => failures.push(format!("self-check: 97.5 must be refused, got {other:?}")),
    }
}
