//! What reading a document as a schema does, beyond the cases the conformance corpus pins.

use json_shape::Value;
use trilean::schemas::{
    self, MAX_ARRAY_LENGTH, MAX_NESTING_DEPTH, MAX_STRING_UNITS, MAX_TEXT_UNITS, MAX_VALUES,
    SCHEMAS,
};

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("valid JSON")
}

#[test]
fn every_schema_name_reads_a_document() {
    for schema in SCHEMAS {
        assert!(
            schemas::read(schema.name, &Value::Null).is_some(),
            "{}",
            schema.name
        );
        assert!(
            schemas::json_schema_of(schema.name).is_some(),
            "{}",
            schema.name
        );
    }
    assert!(schemas::read("NoSuchSchema", &Value::Null).is_none());
}

#[test]
fn a_node_is_read_with_the_keys_it_names_in_the_order_it_names_them() {
    let read = schemas::read(
        "NumberLiteralNodeSchema",
        &parse(r#"{"unit": {"m": 1}, "extra": true, "value": 2, "kind": "numberLiteral"}"#),
    )
    .expect("a schema")
    .expect("valid");
    assert_eq!(
        read.to_string(),
        r#"{"kind":"numberLiteral","value":2,"unit":{"m":1}}"#
    );
}

#[test]
fn a_standalone_node_schema_refuses_another_kind() {
    let refused = schemas::read("NotNodeSchema", &parse(r#"{"kind": "and"}"#))
        .expect("a schema")
        .expect_err("another kind");
    assert!(!refused.is_empty());
}

#[test]
fn a_complex_literal_that_mixes_its_two_forms_or_has_an_unknown_key_is_refused() {
    for document in [
        r#"{"kind":"complexLiteral","re":1,"im":2,"magnitude":3,"phase":4}"#,
        r#"{"kind":"complexLiteral","re":1,"im":2,"extra":true}"#,
        r#"{"kind":"complexLiteral","re":1}"#,
    ] {
        assert!(
            schemas::read("ExpressionNodeSchema", &parse(document))
                .expect("a schema")
                .is_err(),
            "{document}"
        );
    }
    assert!(
        schemas::read(
            "ExpressionNodeSchema",
            &parse(r#"{"kind":"complexLiteral","magnitude":1,"phase":0.5}"#)
        )
        .expect("a schema")
        .is_ok()
    );
}

#[test]
fn a_prototype_key_is_dropped_wherever_a_map_or_an_opaque_value_holds_one() {
    let read = schemas::read(
        "ExpressionNodeSchema",
        &parse(r#"{"kind":"delegate","system":"s","payload":{"__proto__":{"x":1},"keep":[{"__proto__":2,"a":3}]}}"#),
    )
    .expect("a schema")
    .expect("valid");
    assert_eq!(
        read.to_string(),
        r#"{"kind":"delegate","system":"s","payload":{"keep":[{"a":3}]}}"#
    );
}

#[test]
fn the_enumerations_and_tags_are_listed_in_declaration_order() {
    assert_eq!(
        schemas::options_of("DurationUnitSchema").expect("an enumeration"),
        ["ms", "s", "min", "h", "d"]
    );
    assert_eq!(
        schemas::options_of("HitPolicySchema").expect("an enumeration"),
        ["first", "unique"]
    );
    assert_eq!(
        schemas::tags_of("PredicateNode")
            .expect("a union")
            .first()
            .map(String::as_str),
        Some("not")
    );
    assert!(schemas::options_of("PredicateNodeSchema").is_none());
}

#[test]
fn the_declarations_name_every_type_the_package_exports() {
    let declarations = schemas::typescript();
    for schema in SCHEMAS {
        assert!(
            declarations.contains(&format!("export type {} =", schema.type_name)),
            "{}",
            schema.type_name
        );
    }
}

/// The limits as the documentation of the package states them, written out here so that a change to either constant is a
/// change to this file too. The corpus cannot hold a value this deep (it refuses a file nested more than 64 levels), so
/// the depth is pinned here and, in each host, by the checks every host runs.
const STATED_NESTING_DEPTH: usize = 500;
const STATED_ARRAY_LENGTH: usize = 65_536;
const STATED_VALUES: usize = 1_000_000;
const STATED_STRING_UNITS: usize = 1_048_576;
const STATED_TEXT_UNITS: usize = 4_194_304;

#[test]
fn the_limits_are_the_ones_the_documentation_states() {
    assert_eq!(MAX_NESTING_DEPTH, STATED_NESTING_DEPTH);
    assert_eq!(MAX_ARRAY_LENGTH, STATED_ARRAY_LENGTH);
    assert_eq!(MAX_VALUES, STATED_VALUES);
    assert_eq!(MAX_STRING_UNITS, STATED_STRING_UNITS);
    assert_eq!(MAX_TEXT_UNITS, STATED_TEXT_UNITS);
}

/// Runs `test` on a thread with a stack of a size a native caller reading a value at the limit is expected to have: the
/// frames of a debug build are several times those of a release build, and a test thread has two megabytes. The limit is
/// derived for a host that has about one, in the release build the package ships, which the checks of the host's own
/// tests measure.
fn on_a_large_stack(test: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(test)
        .expect("a thread")
        .join()
        .expect("the test passed");
}

/// An array of `containers` arrays nested in one another, the innermost holding the number 1.
fn arrays(containers: usize) -> Value {
    let mut value = Value::Number(1.0);
    for _ in 0..containers {
        value = Value::Array(vec![value]);
    }
    value
}

/// A chain of `nodes` `negate` nodes over a number literal, which takes a nesting level for each node and one more
/// for the literal.
fn negations(nodes: usize) -> Value {
    let mut value = parse(r#"{"kind":"numberLiteral","value":1}"#);
    for _ in 0..nodes {
        value = Value::Object(vec![
            ("kind".to_owned(), Value::String("negate".to_owned())),
            ("operand".to_owned(), value),
        ]);
    }
    value
}

#[test]
fn a_value_nested_to_the_limit_is_read_and_one_level_more_is_refused_at_the_level_that_is_too_deep()
{
    on_a_large_stack(|| {
        let read =
            schemas::read("JsonValueSchema", &arrays(STATED_NESTING_DEPTH)).expect("a schema");
        assert!(read.is_ok());
        let issues = schemas::read("JsonValueSchema", &arrays(STATED_NESTING_DEPTH + 1))
            .expect("a schema")
            .expect_err("one level too many");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].path.len(), STATED_NESTING_DEPTH);
        assert!(issues[0].message.contains("nested more than"));
    });
}

#[test]
fn the_deepest_tree_the_limit_allows_is_read_by_the_costliest_shape_without_exhausting_the_stack() {
    on_a_large_stack(|| {
        // A node takes one level and the literal at the end one more.
        let nodes = STATED_NESTING_DEPTH - 1;
        assert!(
            schemas::read("ExpressionNodeSchema", &negations(nodes))
                .expect("a schema")
                .is_ok()
        );
        assert!(
            schemas::read("ExpressionNodeSchema", &negations(nodes + 1))
                .expect("a schema")
                .is_err()
        );
    });
}

#[test]
fn an_array_of_the_most_elements_is_read_and_one_element_more_is_refused_at_the_array() {
    let elements = |count: usize| Value::Array(vec![Value::Number(0.0); count]);
    assert!(
        schemas::read("JsonValueSchema", &elements(STATED_ARRAY_LENGTH))
            .expect("a schema")
            .is_ok()
    );
    let issues = schemas::read("JsonValueSchema", &elements(STATED_ARRAY_LENGTH + 1))
        .expect("a schema")
        .expect_err("one element too many");
    assert_eq!(issues.len(), 1);
    assert!(issues[0].path.is_empty());
    assert!(
        issues[0]
            .message
            .contains(&(STATED_ARRAY_LENGTH + 1).to_string())
    );
    let nested = Value::Object(vec![
        ("kind".to_owned(), Value::String("delegate".to_owned())),
        ("system".to_owned(), Value::String("s".to_owned())),
        (
            "payload".to_owned(),
            Value::Array(vec![elements(STATED_ARRAY_LENGTH + 1)]),
        ),
    ]);
    let issues = schemas::read("ExpressionNodeSchema", &nested)
        .expect("a schema")
        .expect_err("an array too long inside a node");
    assert_eq!(issues[0].pointer(), "/payload/0");
}

#[test]
fn a_document_of_more_values_than_the_limit_is_refused_once_it_has_been_read_that_far() {
    let list = Value::Array(vec![Value::Number(0.0); STATED_ARRAY_LENGTH]);
    let lists = |count: usize| Value::Array(vec![list.clone(); count]);
    let fits = STATED_VALUES / (STATED_ARRAY_LENGTH + 1) - 1;
    assert!(
        schemas::read("JsonValueSchema", &lists(fits))
            .expect("a schema")
            .is_ok()
    );
    let issues = schemas::read("JsonValueSchema", &lists(fits + 2))
        .expect("a schema")
        .expect_err("more values than the limit");
    assert_eq!(issues.len(), 1);
    assert!(issues[0].message.contains("more than 1000000 values"));
}

#[test]
fn a_string_of_the_most_units_is_read_and_one_unit_more_is_refused_at_the_string() {
    let string = |units: usize| Value::String("a".repeat(units));
    assert!(
        schemas::read("JsonValueSchema", &string(STATED_STRING_UNITS))
            .expect("a schema")
            .is_ok()
    );
    let issues = schemas::read("JsonValueSchema", &string(STATED_STRING_UNITS + 1))
        .expect("a schema")
        .expect_err("one unit too many");
    assert_eq!(issues.len(), 1);
    assert!(
        issues[0]
            .message
            .contains("a string may have at most 1048576")
    );
    let key = Value::Object(vec![("a".repeat(STATED_STRING_UNITS + 1), Value::Null)]);
    assert!(
        schemas::read("JsonValueSchema", &key)
            .expect("a schema")
            .is_err()
    );
}

#[test]
fn text_named_more_than_once_is_counted_at_each_place_and_refused_past_the_limit() {
    let list =
        |count: usize| Value::Array(vec![Value::String("a".repeat(STATED_STRING_UNITS)); count]);
    let fits = STATED_TEXT_UNITS / STATED_STRING_UNITS;
    assert!(
        schemas::read("JsonValueSchema", &list(fits))
            .expect("a schema")
            .is_ok()
    );
    let issues = schemas::read("JsonValueSchema", &list(fits + 1))
        .expect("a schema")
        .expect_err("more text than the limit");
    assert_eq!(issues.len(), 1);
    assert!(issues[0].message.contains("code units of text in all"));
    assert_eq!(issues[0].pointer(), format!("/{fits}"));
}
