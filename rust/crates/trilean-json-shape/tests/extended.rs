//! The shapes a corpus format needs beyond plain structs: a catch-all, key groups, an exclusive bound and
//! negation, each checked by the validator and written to the schema.

#![expect(
    dead_code,
    reason = "the types exist to be described and validated against, and no code reads their fields"
)]

use trilean_json_shape::{
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
        ShapeDef::new(Kind::Object(trilean_json_shape::ObjectDef::default())),
        ShapeDef::new(Kind::Not(Box::new(ShapeDef::new(Kind::Ref(
            "Bound".to_owned(),
        ))))),
    ]));
    assert!(trilean_json_shape::accepts(
        &definitions,
        &object,
        &parse(r#"{"above":0}"#)
    ));
    assert!(!trilean_json_shape::accepts(
        &definitions,
        &object,
        &parse(r#"{"above":1}"#)
    ));
    assert!(!trilean_json_shape::accepts(
        &definitions,
        &object,
        &parse("[]")
    ));
    let written = Value::Object(schema_definitions(
        &definitions,
        Draft::Draft2020_12,
        "#/$defs",
    ))
    .to_string();
    assert!(written.contains("Bound"), "{written}");
    let merged = trilean_json_shape::json_schema(
        &object,
        "Root",
        &definitions,
        &trilean_json_shape::SchemaOptions::default(),
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
    let written = trilean_json_shape::json_schema(
        &both,
        "Root",
        &definitions,
        &trilean_json_shape::SchemaOptions::default(),
    )
    .to_string();
    assert!(written.contains("allOf"), "{written}");
    assert!(trilean_json_shape::accepts(
        &definitions,
        &both,
        &parse("6")
    ));
    assert!(!trilean_json_shape::accepts(
        &definitions,
        &both,
        &parse("3")
    ));
}

#[derive(Shape, Debug)]
#[serde(deny_unknown_fields)]
struct Closed {
    known: u8,
}

#[test]
fn a_stripping_object_is_written_closed_and_lets_an_unknown_key_pass() {
    let document = parse(r#"{"known": 1, "other": true}"#);
    let refusing = Closed::definitions();
    assert!(
        !trilean_json_shape::check(&refusing, &Closed::reference(), &document).is_empty(),
        "a closed object refuses an unknown key"
    );
    let stripping = Definitions::of::<Closed>().stripping(|_| true);
    assert!(trilean_json_shape::check(&stripping, &Closed::reference(), &document).is_empty());
    // The schema and the declarations are the closed ones, and the value built drops the key.
    assert_eq!(
        schema_definitions(&stripping, Draft::Draft2020_12, "#/$defs"),
        schema_definitions(&refusing, Draft::Draft2020_12, "#/$defs")
    );
    assert_eq!(
        trilean_json_shape::typescript_declarations(&stripping),
        trilean_json_shape::typescript_declarations(&refusing)
    );
    let built = Closed::from_json(&parse(r#"{"known": 1}"#)).expect("valid");
    assert_eq!(built.known, 1);
    let kept = Definitions::of::<Closed>().stripping(|_| false);
    assert!(!trilean_json_shape::check(&kept, &Closed::reference(), &document).is_empty());
}
