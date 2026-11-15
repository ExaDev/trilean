//! What reading a document as a schema does, beyond the cases the conformance corpus pins.

use json_shape::Value;
use trilean::schemas::{self, SCHEMAS};

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

#[test]
fn a_deeply_nested_tree_is_read_in_work_that_grows_with_its_size() {
    let mut text = String::from(r#"{"kind":"numberLiteral","value":1}"#);
    for _ in 0..100 {
        text = format!(r#"{{"kind":"negate","operand":{text}}}"#);
    }
    assert!(
        schemas::read("ExpressionNodeSchema", &parse(&text))
            .expect("a schema")
            .is_ok()
    );
}
