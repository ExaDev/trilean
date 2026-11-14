//! The shapes a corpus format needs beyond plain structs: a catch-all, key groups, an exclusive bound and
//! negation, each checked by the validator and written to the schema.

#![expect(
    dead_code,
    reason = "the types exist to be described and validated against, and no code reads their fields"
)]

use json_shape::{
    Definitions, Draft, Kind, Map, Registry, Shape, ShapeDef, Value, schema_definitions,
};

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("valid JSON")
}

#[derive(Shape, Debug)]
struct Tagged {
    kind: String,
    #[serde(flatten)]
    rest: Map<u8>,
}

#[derive(Shape, Debug)]
#[shape(any_of(first, second))]
struct AtLeastOne {
    first: Option<u8>,
    second: Option<u8>,
}

#[derive(Shape, Debug)]
#[shape(one_of(first, second))]
struct ExactlyOne {
    first: Option<u8>,
    second: Option<u8>,
}

#[derive(Shape, Debug)]
struct Bound {
    #[shape(exclusive_min = 0)]
    above: f64,
}

#[test]
fn a_flattened_map_types_the_members_no_field_names() {
    let built = Tagged::from_json(&parse(r#"{"kind":"k","a":1,"b":2}"#)).expect("valid");
    assert_eq!(built.kind, "k");
    assert_eq!(
        built
            .rest
            .0
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    let refused =
        Tagged::from_json(&parse(r#"{"kind":"k","a":300}"#)).expect_err("300 is not a byte");
    assert_eq!(refused.0[0].pointer(), "/a");
    assert!(!Tagged::accepts(&parse(r#"{"a":1}"#)));
    let Kind::Object(object) = Tagged::definition().kind else {
        panic!("not an object")
    };
    assert!(object.additional.is_some());
    assert!(!object.closed);
}

#[test]
fn key_groups_count_present_keys() {
    assert!(AtLeastOne::accepts(&parse(r#"{"first":1}"#)));
    assert!(AtLeastOne::accepts(&parse(r#"{"first":1,"second":2}"#)));
    assert!(!AtLeastOne::accepts(&parse("{}")));
    assert!(ExactlyOne::accepts(&parse(r#"{"second":2}"#)));
    assert!(!ExactlyOne::accepts(&parse(r#"{"first":1,"second":2}"#)));
    assert!(!ExactlyOne::accepts(&parse("{}")));
    let written = Value::Object(schema_definitions(
        &Definitions::of::<ExactlyOne>(),
        Draft::Draft2020_12,
        "#/$defs",
    ))
    .to_string();
    assert!(
        written.contains(
            r#""oneOf":[{"properties":{"first":{}},"required":["first"],"type":"object"}"#
        ),
        "{written}"
    );
}

#[test]
fn an_exclusive_bound_refuses_the_bound_itself() {
    assert!(Bound::accepts(&parse(r#"{"above":0.0001}"#)));
    assert!(!Bound::accepts(&parse(r#"{"above":0}"#)));
    assert!(!Bound::accepts(&parse(r#"{"above":-1}"#)));
    let written = Value::Object(schema_definitions(
        &Definitions::of::<Bound>(),
        Draft::Draft2020_12,
        "#/$defs",
    ))
    .to_string();
    assert!(written.contains(r#""exclusiveMinimum":0"#), "{written}");
}

#[test]
fn negation_and_conjunction_are_checked_and_written() {
    let mut registry = Registry::default();
    Bound::register(&mut registry);
    let definitions = registry.into_definitions();
    let object = ShapeDef::new(Kind::AllOf(vec![
        ShapeDef::new(Kind::Object(json_shape::ObjectDef::default())),
        ShapeDef::new(Kind::Not(Box::new(ShapeDef::new(Kind::Ref(
            "Bound".to_owned(),
        ))))),
    ]));
    assert!(json_shape::accepts(
        &definitions,
        &object,
        &parse(r#"{"above":0}"#)
    ));
    assert!(!json_shape::accepts(
        &definitions,
        &object,
        &parse(r#"{"above":1}"#)
    ));
    assert!(!json_shape::accepts(&definitions, &object, &parse("[]")));
    let written = Value::Object(schema_definitions(
        &definitions,
        Draft::Draft2020_12,
        "#/$defs",
    ))
    .to_string();
    assert!(written.contains("Bound"), "{written}");
    let merged = json_shape::json_schema(
        &object,
        "Root",
        &definitions,
        &json_shape::SchemaOptions::default(),
    )
    .to_string();
    assert!(
        merged.contains(r#""not":{"$ref":"#) && merged.contains(r#""type":"object""#),
        "{merged}"
    );
    assert!(!merged.contains("allOf"), "{merged}");
}

#[test]
fn parts_that_share_a_keyword_are_written_as_all_of() {
    let definitions = Definitions::default();
    let both = ShapeDef::new(Kind::AllOf(vec![
        ShapeDef::new(Kind::Integer {
            min: Some(1.0),
            exclusive_min: None,
            max: None,
        }),
        ShapeDef::new(Kind::Integer {
            min: Some(5.0),
            exclusive_min: None,
            max: None,
        }),
    ]));
    let written = json_shape::json_schema(
        &both,
        "Root",
        &definitions,
        &json_shape::SchemaOptions::default(),
    )
    .to_string();
    assert!(written.contains("allOf"), "{written}");
    assert!(json_shape::accepts(&definitions, &both, &parse("6")));
    assert!(!json_shape::accepts(&definitions, &both, &parse("3")));
}
