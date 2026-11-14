//! The derived validator and the emitted JSON Schema must accept and refuse the same documents. This runs a table
//! of documents (`conformance/fixtures/shape-agreement/documents.json`, one or more per construct and constraint)
//! through the validator, and checks that the schema committed beside it (`schema.json`) is what the types emit.
//! The TypeScript runner runs the same table through Ajv against that committed schema (`packages/trilean-regex`,
//! `conformance.unit.test.ts`), so both verdicts are pinned to the table's and so to each other.
//!
//! `UPDATE_SHAPE_FIXTURES=1` rewrites `schema.json` from the types.

#![expect(
    dead_code,
    reason = "the types exist to be described and validated against, and no code reads their fields"
)]

use std::fs;
use std::path::{Path, PathBuf};

use json_shape::{
    Draft, Map, OpenObject, Registry, SchemaOptions, Shape, Value, schema_definitions,
};

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Closed {
    name: String,
    note: Option<String>,
}

#[derive(Shape)]
struct Open {
    name: String,
}

#[derive(Shape)]
#[serde(rename_all = "lowercase")]
enum Colour {
    Red,
    Green,
}

#[derive(Shape)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Figure {
    Dot,
    Circle {
        #[shape(min = 0)]
        radius: f64,
    },
    Square {
        side: u8,
    },
    Group {
        members: Vec<Figure>,
    },
}

#[derive(Shape)]
#[serde(untagged, deny_unknown_fields)]
enum Either {
    Count(u8),
    Words(String),
    Pair { first: String, second: String },
    Nothing,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Bounds {
    small: Option<u8>,
    wide: Option<u64>,
    signed: Option<i64>,
    #[shape(min = 10, max = 20)]
    ranged: Option<u32>,
    #[shape(min = 0, max = 1)]
    ratio: Option<f64>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Lengths {
    #[shape(min_items = 1, max_items = 3)]
    items: Option<Vec<String>>,
    #[shape(unique_items)]
    distinct: Option<Vec<u8>>,
    #[shape(min_length = 2)]
    text: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Patterned {
    #[shape(pattern = "^[a-z0-9][a-z0-9._-]*$")]
    id: Option<String>,
    #[shape(pattern = r"^(recorded: .+|[a-z0-9._-]+\.test\.ts: .+)$")]
    from: Option<String>,
    #[shape(pattern = "[0-9]")]
    unanchored: Option<String>,
    #[shape(pattern = "^[^/]*/[^/]*$")]
    one_slash: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Files {
    #[shape(min_properties = 1, property_names = r"^[a-z]+\.json$")]
    files: Map<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
#[shape(together(only, reason))]
struct Together {
    only: Option<String>,
    reason: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Constants {
    #[shape(constant = true)]
    ok: bool,
    #[shape(constant = "x")]
    label: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Chain {
    value: u8,
    next: Option<Box<Chain>>,
}

#[derive(Shape)]
struct Common {
    id: String,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Flat {
    #[serde(flatten)]
    common: Common,
    extra: Option<u8>,
}

#[derive(Shape)]
struct Raw {
    any: Value,
    object: OpenObject,
    nested: Vec<Vec<Closed>>,
}

/// The types the table names, each with a document of every verdict.
const TYPES: [&str; 14] = [
    "Closed",
    "Open",
    "Colour",
    "Figure",
    "Either",
    "Bounds",
    "Lengths",
    "Patterned",
    "Files",
    "Together",
    "Constants",
    "Chain",
    "Flat",
    "Raw",
];

/// Whether the derived validator of the named type accepts the value.
fn derived_verdict(name: &str, value: &Value) -> bool {
    match name {
        "Closed" => Closed::accepts(value),
        "Open" => Open::accepts(value),
        "Colour" => Colour::accepts(value),
        "Figure" => Figure::accepts(value),
        "Either" => Either::accepts(value),
        "Bounds" => Bounds::accepts(value),
        "Lengths" => Lengths::accepts(value),
        "Patterned" => Patterned::accepts(value),
        "Files" => Files::accepts(value),
        "Together" => Together::accepts(value),
        "Constants" => Constants::accepts(value),
        "Chain" => Chain::accepts(value),
        "Flat" => Flat::accepts(value),
        "Raw" => Raw::accepts(value),
        other => panic!("the table names the unknown type {other}"),
    }
}

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/fixtures/shape-agreement")
}

fn emitted_schema() -> serde_json::Value {
    let mut registry = Registry::default();
    Closed::register(&mut registry);
    Open::register(&mut registry);
    Colour::register(&mut registry);
    Figure::register(&mut registry);
    Either::register(&mut registry);
    Bounds::register(&mut registry);
    Lengths::register(&mut registry);
    Patterned::register(&mut registry);
    Files::register(&mut registry);
    Together::register(&mut registry);
    Constants::register(&mut registry);
    Chain::register(&mut registry);
    Flat::register(&mut registry);
    Raw::register(&mut registry);
    let options = SchemaOptions {
        draft: Draft::Draft2020_12,
        ..SchemaOptions::default()
    };
    let definitions = Value::Object(schema_definitions(&registry.into_definitions(), &options));
    let document = Value::Object(vec![
        (
            "$schema".to_owned(),
            Value::String("https://json-schema.org/draft/2020-12/schema".to_owned()),
        ),
        ("$defs".to_owned(), definitions),
    ]);
    serde_json::to_value(&document).expect("a schema is JSON")
}

#[test]
fn the_committed_schema_is_what_the_types_emit() {
    let path = fixtures().join("schema.json");
    let emitted = emitted_schema();
    if std::env::var_os("UPDATE_SHAPE_FIXTURES").is_some() {
        let text = serde_json::to_string_pretty(&emitted).expect("JSON") + "\n";
        fs::write(&path, text).expect("the fixture is writable");
    }
    let committed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("the schema fixture exists"))
            .expect("JSON");
    assert!(
        committed == emitted,
        "schema.json differs from what the types emit; UPDATE_SHAPE_FIXTURES=1 rewrites it"
    );
}

#[test]
fn the_validator_agrees_with_every_document_in_the_table() {
    let table: Vec<serde_json::Value> = serde_json::from_str(
        &fs::read_to_string(fixtures().join("documents.json")).expect("the table exists"),
    )
    .expect("JSON");
    assert!(table.len() > 100, "the table must stay broad");
    let mut disagreements = Vec::new();
    for entry in &table {
        let name = entry["type"].as_str().expect("a type");
        let case = entry["case"].as_str().expect("a case");
        let expected = entry["valid"].as_bool().expect("a verdict");
        let text = match entry.get("text") {
            Some(text) => text.as_str().expect("text is a string").to_owned(),
            None => entry["document"].to_string(),
        };
        // A document that is not JSON is refused, which is how a loader meets `1e999`.
        let verdict = serde_json::from_str::<Value>(&text)
            .map(|value| derived_verdict(name, &value))
            .unwrap_or(false);
        if verdict != expected {
            disagreements.push(format!(
                "{name}: {case}: the validator says {verdict}, the table says {expected}"
            ));
        }
    }
    assert!(disagreements.is_empty(), "{}", disagreements.join("\n"));
}

#[test]
fn every_type_in_the_table_has_valid_and_invalid_documents() {
    let table: Vec<serde_json::Value> = serde_json::from_str(
        &fs::read_to_string(fixtures().join("documents.json")).expect("the table exists"),
    )
    .expect("JSON");
    let mut names: Vec<&str> = table
        .iter()
        .filter_map(|entry| entry["type"].as_str())
        .collect();
    names.sort_unstable();
    names.dedup();
    let mut expected = TYPES.to_vec();
    expected.sort_unstable();
    assert_eq!(names, expected);
    for name in names {
        for verdict in [true, false] {
            assert!(
                table
                    .iter()
                    .any(|entry| entry["type"] == name && entry["valid"] == verdict),
                "{name} needs a document with the verdict {verdict}"
            );
        }
    }
}
