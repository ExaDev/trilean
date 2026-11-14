//! What the derive and the validator guarantee about hostile and ambiguous input: names, work, messages and limits.

#![expect(
    dead_code,
    reason = "the types exist to be described and validated against, and no code reads their fields"
)]

use json_shape::{
    Definitions, Draft, Issue, SchemaOptions, Shape, Value, check_with_work, schema_definitions,
    schema_of,
};

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("valid JSON")
}

mod first {
    use json_shape::Shape;

    #[derive(Shape)]
    pub struct Item {
        pub left: String,
    }
}

mod second {
    use json_shape::Shape;

    #[derive(Shape)]
    pub struct Item {
        pub right: u8,
    }
}

#[derive(Shape)]
struct Holder {
    first: first::Item,
    second: second::Item,
}

#[derive(Shape)]
#[shape(name = "Renamed")]
struct Held {
    right: u8,
}

#[derive(Shape)]
struct Resolved {
    first: first::Item,
    second: Held,
}

#[test]
#[should_panic(expected = "used by two types")]
fn two_types_with_one_name_are_refused_loudly() {
    let _ = Definitions::of::<Holder>();
}

#[test]
fn the_message_names_both_types() {
    let result = std::panic::catch_unwind(Definitions::of::<Holder>);
    let message = match result {
        Ok(_) => panic!("two types with one name were accepted"),
        Err(payload) => payload
            .downcast_ref::<String>()
            .cloned()
            .expect("a formatted message"),
    };
    assert!(
        message.contains("first::Item") && message.contains("second::Item"),
        "{message}"
    );
    assert!(message.contains("\"Item\""), "{message}");
}

#[test]
fn a_name_attribute_resolves_the_clash() {
    let names: Vec<String> = Definitions::of::<Resolved>()
        .iter()
        .map(|(name, _)| name.to_owned())
        .collect();
    assert_eq!(names, ["Resolved", "Item", "Renamed"]);
    assert!(Resolved::accepts(&parse(
        r#"{"first":{"left":"a"},"second":{"right":1}}"#
    )));
    assert!(!Resolved::accepts(&parse(
        r#"{"first":{"right":1},"second":{"right":1}}"#
    )));
}

#[derive(Shape)]
#[shape(name = "a/b~c%d e")]
struct Awkward {
    value: u8,
}

#[derive(Shape)]
struct UsesAwkward {
    awkward: Awkward,
}

#[test]
fn references_are_escaped_as_pointer_tokens_and_uri_fragments() {
    let schema = schema_of::<UsesAwkward>("UsesAwkward", &SchemaOptions::default()).to_string();
    assert!(
        schema.contains(r##""$ref":"#/$defs/a~1b~0c%25d%20e""##),
        "{schema}"
    );
    assert!(schema.contains(r#""a/b~c%d e":{"#), "{schema}");
}

#[test]
fn definitions_alone_are_written_under_the_pointer_given() {
    let written = schema_definitions(
        &Definitions::of::<UsesAwkward>(),
        Draft::Draft07,
        "#/definitions/trilean",
    );
    let text = Value::Object(written).to_string();
    assert!(
        text.contains(r##""$ref":"#/definitions/trilean/a~1b~0c%25d%20e""##),
        "{text}"
    );
}

#[derive(Shape, Debug)]
#[serde(untagged)]
enum Tree {
    #[shape(min_items = 1)]
    Many(Vec<Tree>),
    #[shape(max_items = 0)]
    Empty(Vec<Tree>),
    Leaf(String),
}

fn nested(depth: usize) -> Value {
    let text = format!("{}\"x\"{}", "[".repeat(depth), "]".repeat(depth));
    parse(&text)
}

fn work_of(depth: usize) -> u64 {
    let document = nested(depth);
    let (issues, work) = check_with_work(&Tree::definitions(), &Tree::reference(), &document);
    assert!(issues.is_empty(), "{issues:?}");
    work
}

#[test]
fn a_union_whose_alternatives_descend_into_one_child_is_linear_in_depth() {
    let shallow = work_of(40);
    let deep = work_of(80);
    assert!(
        deep < 3 * shallow,
        "{deep} visits at depth 80 against {shallow} at depth 40"
    );
    assert!(deep <= 20 * 80, "{deep} visits at depth 80");
}

#[test]
fn converting_a_deep_union_is_linear_too() {
    assert!(Tree::from_json(&nested(100)).is_ok());
}

#[derive(Shape)]
struct Pinned {
    #[shape(pattern = "^[a-z]*$")]
    word: String,
}

#[test]
fn a_very_long_string_is_checked_without_overflowing_the_stack() {
    let document = Value::Object(vec![(
        "word".to_owned(),
        Value::String("a".repeat(200_000)),
    )]);
    assert!(Pinned::accepts(&document));
    let bad = Value::Object(vec![(
        "word".to_owned(),
        Value::String(format!("{}1", "a".repeat(200_000))),
    )]);
    assert!(!Pinned::accepts(&bad));
}

#[derive(Shape)]
#[serde(tag = "k")]
enum Asym {
    Unit,
    Named { a: u8 },
}

#[derive(Shape)]
#[serde(tag = "k", deny_unknown_fields)]
enum AsymStrict {
    Unit,
    Named { a: u8 },
}

#[test]
fn unit_variants_follow_the_containers_strictness() {
    assert!(Asym::accepts(&parse(r#"{"k":"Unit","z":1}"#)));
    assert!(Asym::accepts(&parse(r#"{"k":"Named","a":1,"z":1}"#)));
    assert!(!AsymStrict::accepts(&parse(r#"{"k":"Unit","z":1}"#)));
    assert!(!AsymStrict::accepts(&parse(r#"{"k":"Named","a":1,"z":1}"#)));
}

#[derive(Shape, Debug)]
#[serde(untagged)]
enum Sloppy {
    Text(String),
    Items(Vec<u8>),
}

#[test]
fn a_failing_union_reports_the_one_alternative_it_could_be_at_the_real_path() {
    #[derive(Shape, Debug)]
    struct Outer {
        inner: Sloppy,
    }
    let issues = Outer::from_json(&parse(r#"{"inner":[1,300]}"#)).expect_err("300 is not a byte");
    let described: Vec<String> = issues.0.iter().map(Issue::to_string).collect();
    assert_eq!(described, ["/inner/1: expected at most 255"]);
    let ambiguous = Outer::from_json(&parse(r#"{"inner":true}"#)).expect_err("no alternative fits");
    assert_eq!(ambiguous.0[0].message, "matches none of the alternatives");
}

#[test]
fn messages_write_strings_as_json() {
    #[derive(Shape, Debug)]
    struct Flavour {
        #[shape(constant = "caf\u{e9}\n")]
        name: String,
    }
    let issues = Flavour::from_json(&parse(r#"{"name":"x"}"#)).expect_err("a different constant");
    assert_eq!(issues.0[0].message, "expected \"caf\u{e9}\\n\"");
}

#[test]
fn numbers_are_written_as_json_stringify_writes_them() {
    let text = |number: f64| Value::Number(number).to_string();
    assert_eq!(text(1e21), "1e+21");
    assert_eq!(text(1e300), "1e+300");
    assert_eq!(text(-1e21), "-1e+21");
    assert_eq!(text(1e20), "100000000000000000000");
    assert_eq!(text(1.5e-7), "1.5e-7");
    assert_eq!(text(0.000_001), "0.000001");
    assert_eq!(text(-0.0), "0");
    assert_eq!(text(100.0), "100");
    assert_eq!(text(0.1 + 0.2), "0.30000000000000004");
    assert_eq!(text(9_007_199_254_740_993.0), "9007199254740992");
}

#[test]
fn equality_as_json_schema_defines_it() {
    let left = parse(r#"{"a":[1,{"c":1,"d":2}],"b":-0}"#);
    let right = parse(r#"{"b":0.0,"a":[1.0,{"d":2,"c":1}]}"#);
    assert!(left.json_equal(&right));
    assert_ne!(left, right);
    assert!(!left.json_equal(&parse(r#"{"a":[1,{"c":1,"d":3}],"b":0}"#)));
}

#[test]
fn unique_items_is_decided_by_canonical_text() {
    #[derive(Shape)]
    struct Set {
        #[shape(unique_items)]
        items: Vec<Value>,
    }
    assert!(Set::accepts(&parse(r#"{"items":[1,"1",[1],{"a":1}]}"#)));
    assert!(!Set::accepts(&parse(
        r#"{"items":[{"a":1,"b":2},{"b":2,"a":1}]}"#
    )));
    assert!(!Set::accepts(&parse(r#"{"items":[1,1.0]}"#)));
    let many: Vec<String> = (0..20_000).map(|n| n.to_string()).collect();
    assert!(Set::accepts(&parse(&format!(
        r#"{{"items":[{}]}}"#,
        many.join(",")
    ))));
}

#[test]
fn whole_numbers_serialise_without_a_fraction_up_to_what_i64_holds() {
    for (number, text) in [
        (9_007_199_254_740_992.0, "9007199254740992"),
        (-9_007_199_254_740_993.0, "-9007199254740992"),
        (100.0, "100"),
        (0.5, "0.5"),
    ] {
        assert_eq!(
            serde_json::to_string(&Value::Number(number)).expect("JSON"),
            text
        );
    }
}
