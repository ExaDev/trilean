//! Validation of corpus files and the manifest. A corpus file is read through the types of `trilean_conformance`,
//! which derive their validation from the same declarations that the schema comparison in `schema.rs` checks
//! `conformance/case.schema.json` against, so a file is accepted exactly when the schema accepts it, for every case
//! kind. The checks beside the types are the rules `conformance/README.md` lists as ones a schema cannot express.
//!
//! Strings in the corpus are sequences of UTF-16 code units. A JSON string is read by `serde_json`, which refuses an
//! unpaired surrogate escape, so the file holding one does not load and is rejected; content that needs one is
//! written as `{ "codeUnits": [...] }`, which `decode_text` reads into the same `u16` sequence a JSON string gives.

use std::collections::{BTreeMap, BTreeSet};

use json_shape::{Shape, Value as Shaped};
use serde_json::{Map, Value};
use trilean_conformance::{Case, CorpusFile, RegexNode, RegexParseExpect, Skip, Text};

type Check<T> = Result<T, String>;

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

/// The document as the types read it: ordered, with numbers as doubles.
fn shaped(value: &Value) -> Check<Shaped> {
    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
}

/// A string as the UTF-16 code units it denotes: a JSON string, or `{ "codeUnits": [...] }` for content a JSON
/// string cannot carry. The second form is what lets a case hold an unpaired surrogate.
pub fn decode_text(value: &Value) -> Check<Vec<u16>> {
    Text::from_json(&shaped(value)?)
        .map(|text| text.code_units())
        .map_err(|issues| issues.to_string())
}

/// The rules a schema cannot express, for one regex node: a class range's `from` is not above its `to`, and a
/// repeat's `min` is not above its `max`.
fn node_problems(node: &RegexNode, problems: &mut Vec<String>) {
    match node {
        RegexNode::CharClass { ranges, .. } => {
            if ranges.iter().any(|range| range.from > range.to) {
                problems.push("a range's from is above its to".to_owned());
            }
        }
        RegexNode::Concat { operands, .. } => {
            for operand in operands {
                node_problems(operand, problems);
            }
        }
        RegexNode::Alternation { branches, .. } => {
            for branch in branches {
                node_problems(branch, problems);
            }
        }
        RegexNode::Postfix { operand, .. } => node_problems(operand, problems),
        RegexNode::Repeat {
            operand, min, max, ..
        } => {
            if max.is_some_and(|max| *min > max) {
                problems.push("a repeat's min is above its max".to_owned());
            }
            node_problems(operand, problems);
        }
        RegexNode::Literal { .. } | RegexNode::Simple { .. } => {}
    }
}

/// What a valid corpus file holds, for the checks that compare files with each other and with the manifest.
pub struct FileFacts {
    pub ids: Vec<String>,
    /// The ids of the cases marked `ts`, the ones the TypeScript runners skip, sorted.
    pub ts_skip_ids: Vec<String>,
    /// The ids of the cases marked `rust`, the ones this implementation skips because they are marked, sorted.
    pub rust_skip_ids: Vec<String>,
}

/// Checks a corpus file: the types, which hold for every case kind, then the rules beside them.
pub fn validate_file(value: &Value) -> Check<FileFacts> {
    let file = CorpusFile::from_json(&shaped(value)?).map_err(|issues| issues.to_string())?;
    let mut facts = FileFacts {
        ids: Vec::new(),
        ts_skip_ids: Vec::new(),
        rust_skip_ids: Vec::new(),
    };
    let mut seen = BTreeSet::new();
    for case in &file.cases {
        let common = case.header();
        let mut problems = Vec::new();
        if let Case::RegexParse(parse) = case
            && let RegexParseExpect::Ast { ast } = &parse.expect
        {
            node_problems(ast, &mut problems);
        }
        if let Some(problem) = problems.first() {
            return Err(format!("case {}: {problem}", common.id));
        }
        if !seen.insert(common.id.clone()) {
            return Err(format!("case id {} is used twice in the file", common.id));
        }
        match common.skip {
            Some(Skip::Rust) => facts.rust_skip_ids.push(common.id.clone()),
            Some(Skip::Ts) => facts.ts_skip_ids.push(common.id.clone()),
            None => {}
        }
        facts.ids.push(common.id.clone());
    }
    facts.ts_skip_ids.sort();
    facts.rust_skip_ids.sort();
    Ok(facts)
}

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

/// What the manifest records for one corpus file: its number of cases and, per implementation, the ids of the cases
/// marked to be skipped by it.
#[derive(Debug, PartialEq, Eq)]
pub struct ManifestEntry {
    pub cases: usize,
    pub ts: Vec<String>,
    pub rust: Vec<String>,
}

/// A manifest's list of ids: case ids, in ascending order, without repeats.
fn skip_list(value: &Value, at: &str, which: &str) -> Check<Vec<String>> {
    let mut ids = Vec::new();
    for id in array(value, at, which)? {
        ids.push(
            id.as_str()
                .filter(|text| is_name(text))
                .ok_or_else(|| format!("{at}: {which} must hold case ids"))?
                .to_owned(),
        );
    }
    if !ids.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err(format!(
            "{at}: {which} must list distinct ids in ascending order"
        ));
    }
    Ok(ids)
}

/// The manifest as a map from corpus file to what it records for the file.
pub fn validate_manifest(value: &Value) -> Check<BTreeMap<String, ManifestEntry>> {
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
        let map = exact_keys(entry, &at, &["cases", "skip"], &["generated"])?;
        if map
            .get("generated")
            .is_some_and(|flag| flag != &Value::Bool(true))
        {
            return Err(format!("{at}: \"generated\" is true when it is given"));
        }
        let count = map
            .get("cases")
            .and_then(as_integer)
            .ok_or_else(|| format!("{at}: \"cases\" must be a non-negative integer"))?;
        if count == 0 {
            return Err(format!("{at}: \"cases\" must be at least 1"));
        }
        let skip = exact_keys(&map["skip"], &at, &["rust", "ts"], &[])?;
        let ts = skip_list(&skip["ts"], &at, "\"skip.ts\"")?;
        let rust = skip_list(&skip["rust"], &at, "\"skip.rust\"")?;
        if let Some(id) = ts.iter().find(|id| rust.contains(id)) {
            return Err(format!(
                "{at}: {id} is listed in both \"skip.ts\" and \"skip.rust\""
            ));
        }
        let cases = usize::try_from(count).map_err(|error| format!("{at}: {error}"))?;
        manifest.insert(name.clone(), ManifestEntry { cases, ts, rust });
    }
    Ok(manifest)
}

/// Checks the validator against documents written here rather than read from the corpus, for what a JSON file cannot
/// hold: the corpus is canonical JSON, which writes `97.0` as `97`.
pub fn self_check(failures: &mut Vec<String>) {
    let node = |text: &str| {
        serde_json::from_str::<Shaped>(text).map(|value| RegexNode::from_json(&value).map(drop))
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
