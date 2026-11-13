//! Loads every file of the conformance corpus (`conformance/` at the repository root) and checks it against the
//! format in `conformance/README.md` and `conformance/case.schema.json`. A file that does not match is a failure,
//! never a skip.
//!
//! Executing the cases against the native crates is added with each crate; until then this proves that the Rust
//! side reads the same files the TypeScript runner does, and that they stay well formed.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde_json::{Map, Value};

type Check<T> = Result<T, String>;

/// Directories under a package that hold data cases refer to, not cases.
const NON_CASE_DIRECTORIES: [&str; 2] = ["fixtures", "schema"];

const CASE_KINDS: [&str; 13] = [
    "regex-parse",
    "regex-match",
    "validate",
    "build",
    "call",
    "evaluate",
    "inputs",
    "document",
    "cli",
    "sql-compile",
    "sql-guard",
    "sql-pattern",
    "sql-execute",
];

const COMMON_KEYS: [&str; 3] = ["id", "from", "kind"];
const OPTIONAL_COMMON_KEYS: [&str; 2] = ["only", "tolerance"];

fn corpus_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance")
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

fn integer_field(map: &Map<String, Value>, key: &str, at: &str) -> Check<u64> {
    map.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{at}: \"{key}\" must be a non-negative integer"))
}

fn check_regex_node(value: &Value, at: &str) -> Check<()> {
    let map = object(value, at)?;
    match string_field(map, "kind", at)? {
        "literal" => {
            exact_keys(value, at, &["kind", "codeUnit"], &[])?;
            integer_field(map, "codeUnit", at).map(drop)
        }
        "anyChar" | "anchorStart" | "anchorEnd" => exact_keys(value, at, &["kind"], &[]).map(drop),
        "charClass" => {
            exact_keys(value, at, &["kind", "negated", "ranges"], &[])?;
            if !map.get("negated").is_some_and(Value::is_boolean) {
                return Err(format!("{at}: \"negated\" must be a boolean"));
            }
            for range in array(&map["ranges"], at, "\"ranges\"")? {
                let range_map = exact_keys(range, at, &["from", "to"], &[])?;
                integer_field(range_map, "from", at)?;
                integer_field(range_map, "to", at)?;
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
            integer_field(map, "min", at)?;
            if map.contains_key("max") {
                integer_field(map, "max", at)?;
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
    } else if map.contains_key("astSubset") {
        exact_keys(value, at, &["astSubset"], &[]).map(drop)
    } else {
        let outer = exact_keys(value, at, &["error"], &[])?;
        let error = exact_keys(&outer["error"], at, &[], &["index", "message"])?;
        if error.contains_key("index") {
            integer_field(error, "index", at)?;
        }
        if error.contains_key("message") {
            non_empty_string_field(error, "message", at)?;
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
        string_field(map, "input", at)?;
        if !map.get("matches").is_some_and(Value::is_boolean) {
            return Err(format!("{at}: \"matches\" must be a boolean"));
        }
    }
    Ok(())
}

/// Checks one case and returns its id. Only the kinds a package's corpus holds today are checked beyond the
/// common fields; each further package adds the check for its kinds when it adds its corpus.
fn check_case(value: &Value, at: &str) -> Check<String> {
    let map = object(value, at)?;
    for key in COMMON_KEYS {
        if !map.contains_key(key) {
            return Err(format!("{at}: missing \"{key}\""));
        }
    }
    let id = non_empty_string_field(map, "id", at)?;
    non_empty_string_field(map, "from", at)?;
    let kind = string_field(map, "kind", at)?;
    if !CASE_KINDS.contains(&kind) {
        return Err(format!("{at}: unknown case kind \"{kind}\""));
    }
    if let Some(only) = map.get("only") {
        if !matches!(only.as_str(), Some("js" | "native")) {
            return Err(format!("{at}: \"only\" must be \"js\" or \"native\""));
        }
    }
    match kind {
        "regex-parse" => {
            let allowed = ["pattern", "expect"];
            exact_keys(
                value,
                at,
                &[COMMON_KEYS.as_slice(), &allowed].concat(),
                &OPTIONAL_COMMON_KEYS,
            )?;
            string_field(map, "pattern", at)?;
            check_regex_parse_expectation(&map["expect"], at)?;
        }
        "regex-match" => {
            let allowed = ["pattern", "inputs"];
            exact_keys(
                value,
                at,
                &[COMMON_KEYS.as_slice(), &allowed].concat(),
                &OPTIONAL_COMMON_KEYS,
            )?;
            string_field(map, "pattern", at)?;
            check_regex_match_inputs(&map["inputs"], at)?;
        }
        _ => {}
    }
    Ok(id.to_owned())
}

struct LoadedFile {
    name: String,
    case_count: usize,
    js_only: usize,
    native_only: usize,
}

fn check_file(path: &Path, name: &str, ids: &mut BTreeSet<String>) -> Check<LoadedFile> {
    let text = fs::read_to_string(path).map_err(|error| format!("{name}: {error}"))?;
    let parsed: Value = serde_json::from_str(&text).map_err(|error| format!("{name}: {error}"))?;
    let top = exact_keys(&parsed, name, &["cases"], &[])?;
    let mut file = LoadedFile {
        name: name.to_owned(),
        case_count: 0,
        js_only: 0,
        native_only: 0,
    };
    for (position, case) in array(&top["cases"], name, "\"cases\"")?.iter().enumerate() {
        let id = check_case(case, &format!("{name} case {position}"))?;
        if !ids.insert(id.clone()) {
            return Err(format!("{name}: duplicate case id {id}"));
        }
        file.case_count += 1;
        match case.get("only").and_then(Value::as_str) {
            Some("js") => file.js_only += 1,
            Some("native") => file.native_only += 1,
            _ => {}
        }
    }
    Ok(file)
}

fn sorted_entries(directory: &Path) -> Check<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("{}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("{}: {error}", directory.display()))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn load_corpus() -> (Vec<LoadedFile>, Vec<String>) {
    let root = corpus_root();
    let mut files = Vec::new();
    let mut failures = Vec::new();
    let mut ids = BTreeSet::new();
    let packages = match sorted_entries(&root) {
        Ok(entries) => entries,
        Err(error) => return (files, vec![error]),
    };
    for package in packages.iter().filter(|entry| entry.path().is_dir()) {
        let areas = match sorted_entries(&package.path()) {
            Ok(entries) => entries,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        for area in areas.iter().filter(|entry| entry.path().is_dir()) {
            let area_name = area.file_name().to_string_lossy().into_owned();
            if NON_CASE_DIRECTORIES.contains(&area_name.as_str()) {
                continue;
            }
            match sorted_entries(&area.path()) {
                Ok(entries) => {
                    for entry in entries {
                        let name = format!(
                            "{}/{}/{}",
                            package.file_name().to_string_lossy(),
                            area_name,
                            entry.file_name().to_string_lossy()
                        );
                        match check_file(&entry.path(), &name, &mut ids) {
                            Ok(file) => files.push(file),
                            Err(error) => failures.push(error),
                        }
                    }
                }
                Err(error) => failures.push(error),
            }
        }
    }
    (files, failures)
}

fn main() -> ExitCode {
    let (files, mut failures) = load_corpus();
    if files.is_empty() && failures.is_empty() {
        failures.push("the corpus holds no files".to_owned());
    }
    for file in &files {
        println!(
            "{}: {} cases ({} js only, {} native only)",
            file.name, file.case_count, file.js_only, file.native_only
        );
    }
    for failure in &failures {
        eprintln!("FAIL {failure}");
    }
    if failures.is_empty() {
        println!(
            "checked {} files; no case executes natively yet",
            files.len()
        );
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
