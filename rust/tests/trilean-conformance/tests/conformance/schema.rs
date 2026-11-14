//! `conformance/case.schema.json` is the format the JavaScript runners validate against, and the types of
//! `trilean_conformance` are what this loader validates with, so the two must mean the same. The committed file is
//! kept by hand where that reads better, so it is compared with the schema the types emit by meaning, not by text:
//! references are followed (a reference back into a definition being followed is marked, not followed again), and
//! key order, the names of definitions, descriptions, titles and the `$id` are ignored, with `required`, `enum`,
//! `oneOf` and the lists under `dependentRequired` compared as sets, a `type` beside a `const`, or beside an `enum` of strings, dropped (they decide the type) and the schema `true` read as `{}` (both accept anything). Every other difference fails with its JSON
//! Pointer, into the normalised documents.

use std::fs;
use std::path::Path;

use json_shape::{Draft, SchemaOptions, schema_of};
use serde_json::{Map, Value};
use trilean_conformance::CorpusFile;

/// Keys that say something about a schema for a reader, not what it accepts.
const NOTES: [&str; 5] = ["description", "title", "$id", "$schema", "$comment"];

/// Keys whose arrays are sets: their order says nothing.
const SETS: [&str; 4] = ["required", "enum", "oneOf", "anyOf"];

fn is_set_key(key: &str) -> bool {
    SETS.contains(&key)
}

fn definition_name(reference: &str) -> &str {
    reference.rsplit('/').next().unwrap_or(reference)
}

/// The schema at a schema position with every reference followed. `following` holds the definitions being
/// followed, outermost first, so a cycle is written as the depth of the definition it returns to.
fn resolve(node: &Value, definitions: &Map<String, Value>, following: &mut Vec<String>) -> Value {
    match node {
        Value::Bool(true) => Value::Object(Map::new()),
        Value::Object(map) => {
            let mut resolved = Map::new();
            for (key, value) in map {
                if NOTES.contains(&key.as_str())
                    || key == "$defs"
                    || key == "definitions"
                    || key == "$ref"
                {
                    continue;
                }
                resolved.insert(
                    key.clone(),
                    resolve_keyword(key, value, definitions, following),
                );
            }
            let Some(Value::String(reference)) = map.get("$ref") else {
                return decided(resolved);
            };
            let name = definition_name(reference).to_owned();
            let target = if let Some(depth) = following.iter().position(|entry| *entry == name) {
                let mut cycle = Map::new();
                cycle.insert("$cycle".to_owned(), Value::from(depth));
                Value::Object(cycle)
            } else if let Some(definition) = definitions.get(&name) {
                following.push(name);
                let target = resolve(definition, definitions, following);
                following.pop();
                target
            } else {
                let mut missing = Map::new();
                missing.insert("$unresolved".to_owned(), Value::String(reference.clone()));
                Value::Object(missing)
            };
            match target {
                Value::Object(mut merged) => {
                    merged.extend(resolved);
                    decided(merged)
                }
                other => other,
            }
        }
        other => other.clone(),
    }
}

/// The node without a `type` that a `const` already decides.
fn decided(mut node: Map<String, Value>) -> Value {
    let strings_only = node
        .get("enum")
        .and_then(Value::as_array)
        .is_some_and(|options| options.iter().all(Value::is_string));
    if node.contains_key("const")
        || (strings_only && node.get("type") == Some(&Value::String("string".to_owned())))
    {
        node.remove("type");
    }
    Value::Object(node)
}

/// A keyword's value: a map of schemas for `properties`, a list for the set keywords, a schema otherwise.
fn resolve_keyword(
    key: &str,
    value: &Value,
    definitions: &Map<String, Value>,
    following: &mut Vec<String>,
) -> Value {
    match (key, value) {
        ("properties", Value::Object(properties)) => Value::Object(
            properties
                .iter()
                .map(|(name, property)| (name.clone(), resolve(property, definitions, following)))
                .collect(),
        ),
        ("dependentRequired" | "dependencies", Value::Object(groups)) => Value::Object(
            groups
                .iter()
                .map(|(name, group)| (name.clone(), sorted(group)))
                .collect(),
        ),
        (key, Value::Array(items)) if is_set_key(key) => {
            let mut members: Vec<Value> = items
                .iter()
                .map(|member| resolve(member, definitions, following))
                .collect();
            members.sort_by_key(Value::to_string);
            Value::Array(members)
        }
        (_, Value::Array(items)) => Value::Array(
            items
                .iter()
                .map(|member| resolve(member, definitions, following))
                .collect(),
        ),
        (_, Value::Object(_)) => resolve(value, definitions, following),
        _ => value.clone(),
    }
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Array(items) => {
            let mut items = items.clone();
            items.sort_by_key(Value::to_string);
            Value::Array(items)
        }
        other => other.clone(),
    }
}

/// The schema document with its references followed and its notes removed.
pub fn normalise(document: &Value) -> Value {
    let definitions = ["$defs", "definitions"]
        .iter()
        .find_map(|key| document.get(key).and_then(Value::as_object).cloned())
        .unwrap_or_default();
    resolve(document, &definitions, &mut Vec::new())
}

/// The JSON Pointer of every place two normalised documents differ, with what each holds there.
pub fn differences(left: &Value, right: &Value) -> Vec<String> {
    fn walk(left: &Value, right: &Value, pointer: &str, found: &mut Vec<String>) {
        match (left, right) {
            (Value::Object(left_map), Value::Object(right_map)) => {
                let keys: std::collections::BTreeSet<&String> =
                    left_map.keys().chain(right_map.keys()).collect();
                for key in keys {
                    let at = format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
                    match (left_map.get(key), right_map.get(key)) {
                        (Some(left), Some(right)) => walk(left, right, &at, found),
                        (left, right) => found.push(format!(
                            "{at}: committed has {left:?}, emitted has {right:?}"
                        )),
                    }
                }
            }
            (Value::Array(left_items), Value::Array(right_items))
                if left_items.len() == right_items.len() =>
            {
                for (position, (left, right)) in left_items.iter().zip(right_items).enumerate() {
                    walk(left, right, &format!("{pointer}/{position}"), found);
                }
            }
            (left, right) if left == right => {}
            (left, right) => found.push(format!(
                "{pointer}: committed has {left}, emitted has {right}"
            )),
        }
    }
    let mut found = Vec::new();
    walk(left, right, "", &mut found);
    found
}

/// The schema the corpus file type emits, as a JSON document.
pub fn emitted() -> Value {
    let options = SchemaOptions {
        draft: Draft::Draft2020_12,
        id: Some("https://github.com/ExaDev/trilean/tree/main/conformance/case.schema.json"),
        title: Some("trilean conformance corpus file"),
    };
    serde_json::to_value(schema_of::<CorpusFile>("CorpusFile", &options)).expect("a schema is JSON")
}

/// The emitted schema as the repository's formatter writes a corpus JSON file (`json-stringify`: sorted keys, one
/// element per line), so the root lint leaves the committed copy alone.
fn emitted_text() -> String {
    serde_json::to_string_pretty(&emitted()).expect("a schema is JSON") + "\n"
}

/// The committed copy of the emitted schema, which the root test `shape-agreement.integration.test.ts` gives every
/// file of the corpus and of the fixtures to Ajv beside the hand-kept schema, so the two must give every file the
/// same verdict. `UPDATE_CORPUS_FIXTURES=1` rewrites it from the types.
fn check_emitted_copy(failures: &mut Vec<String>) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../conformance/fixtures/case-schema/emitted.json");
    let text = emitted_text();
    if std::env::var_os("UPDATE_CORPUS_FIXTURES").is_some()
        && let Err(error) = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| fs::write(&path, &text))
    {
        failures.push(format!("{}: {error}", path.display()));
        return;
    }
    match fs::read_to_string(&path) {
        Ok(committed) if committed == text => {}
        Ok(_) => failures.push(format!(
            "{} differs from the schema the types emit; UPDATE_CORPUS_FIXTURES=1 rewrites it",
            path.display()
        )),
        Err(error) => failures.push(format!("{}: {error}", path.display())),
    }
}

/// Fails when the committed schema and the emitted one differ in meaning, or the committed copy of the emitted one is
/// not what the types emit.
pub fn check(failures: &mut Vec<String>) {
    check_emitted_copy(failures);
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/case.schema.json");
    let committed = fs::read_to_string(&path)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|error| error.to_string()));
    let committed = match committed {
        Ok(committed) => committed,
        Err(error) => {
            failures.push(format!("{}: {error}", path.display()));
            return;
        }
    };
    for difference in differences(&normalise(&committed), &normalise(&emitted())) {
        failures.push(format!(
            "case.schema.json differs in meaning from the schema the types emit: {difference}"
        ));
    }
}
