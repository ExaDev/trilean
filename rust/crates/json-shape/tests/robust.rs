//! What the derive and the validator guarantee about hostile and ambiguous input: names, work, messages and limits.

#![expect(
    dead_code,
    reason = "the types exist to be described and validated against, and no code reads their fields"
)]

use json_shape::{
    Definitions, Draft, Issue, Map, SchemaOptions, Shape, Value, check_with_work,
    schema_definitions, schema_of,
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

/// Number literals and the bits `JSON.parse` reads them as (`Number(text)` in V8). `serde_json` without its
/// `float_roundtrip` feature reads several of them one unit in the last place away.
const JAVASCRIPT_READINGS: [(&str, u64); 14] = [
    ("1.0000000000000073", 0x3ff0_0000_0000_0021),
    ("5.978651090953677262", 0x4017_ea23_82f7_5cf2),
    ("566.955730063951723929144", 0x4081_b7a5_55cd_c3d0),
    ("22200644002808206446864", 0x4492_cdff_4e82_0105),
    ("12345678901234567890", 0x43e5_6a95_319d_63e1),
    ("123456789012345680000", 0x441a_c53a_7e04_bcda),
    ("9007199254740993", 0x4340_0000_0000_0000),
    ("2.2200644002808204e22", 0x4492_cdff_4e82_0105),
    ("1.7976931348623157e308", 0x7fef_ffff_ffff_ffff),
    ("4.9e-324", 0x1),
    ("0.1", 0x3fb9_9999_9999_999a),
    ("1e23", 0x44b5_2d02_c7e1_4af6),
    ("8.41e21", 0x447c_7e83_209e_90b2),
    ("3.0000000000000003", 0x4008_0000_0000_0001),
];

#[test]
fn number_literals_are_read_as_javascript_reads_them() {
    let mut differing = Vec::new();
    for (text, bits) in JAVASCRIPT_READINGS {
        let read = parse(text).as_f64().expect("a number").to_bits();
        if read != bits {
            differing.push(format!(
                "{text}: read as {read:#x}, JavaScript reads {bits:#x}"
            ));
        }
    }
    assert!(differing.is_empty(), "{}", differing.join("\n"));
}

#[derive(Shape)]
struct Bounded {
    #[shape(max = 2.2200644002808204e22)]
    big: f64,
}

#[test]
fn a_bound_is_met_by_the_literal_javascript_reads_as_the_bound() {
    assert!(Bounded::accepts(&parse(
        r#"{"big":22200644002808206446864}"#
    )));
    assert!(!Bounded::accepts(&parse(
        r#"{"big":22200644002808208000000}"#
    )));
}

#[test]
fn written_numbers_read_back_as_the_same_double() {
    for (text, bits) in JAVASCRIPT_READINGS {
        let value = parse(text);
        let displayed = parse(&value.to_string());
        assert_eq!(
            displayed.as_f64().map(f64::to_bits),
            Some(bits),
            "Display of {text}"
        );
        let serialised = serde_json::to_string(&value).expect("JSON");
        assert_eq!(
            parse(&serialised).as_f64().map(f64::to_bits),
            Some(bits),
            "Serialize of {text}"
        );
    }
}

#[derive(Shape)]
struct Unique {
    #[shape(unique_items)]
    items: Vec<f64>,
}

#[test]
fn two_literals_javascript_reads_as_one_number_are_one_item() {
    assert!(!Unique::accepts(&parse(
        r#"{"items":[22200644002808206446864,2.2200644002808204e22]}"#
    )));
}

#[test]
fn a_pattern_in_a_message_is_a_json_string() {
    #[derive(Shape, Debug)]
    struct Named {
        #[shape(pattern = r"^\.json$")]
        name: String,
    }
    let issues = Named::from_json(&parse(r#"{"name":"x"}"#)).expect_err("outside the pattern");
    assert_eq!(
        issues.0[0].message,
        r#"expected a string matching "^\\.json$""#
    );
}

#[derive(Shape)]
struct Counted {
    #[shape(pattern = "^unique-counted-[0-9]+$")]
    name: String,
}

#[derive(Shape)]
struct Keyed {
    #[shape(property_names = "^unique-keyed-[0-9]+$")]
    names: Map<u8>,
}

#[test]
fn a_pattern_is_compiled_once_however_many_values_are_checked() {
    let source = "^unique-counted-[0-9]+$";
    let document = Value::Object(vec![(
        "name".to_owned(),
        Value::String("unique-counted-1".to_owned()),
    )]);
    for _ in 0..1000 {
        assert!(Counted::accepts(&document));
    }
    assert_eq!(json_shape::private::compilations_of(source), 1);
    let keys: Vec<String> = (0..500)
        .map(|n| format!("\"unique-keyed-{n}\":1"))
        .collect();
    assert!(Keyed::accepts(&parse(&format!(
        r#"{{"names":{{{}}}}}"#,
        keys.join(",")
    ))));
    assert_eq!(
        json_shape::private::compilations_of("^unique-keyed-[0-9]+$"),
        1
    );
}

#[test]
fn a_path_cannot_carry_a_memory_from_one_document_to_the_next() {
    #[derive(Shape, Debug, PartialEq)]
    #[serde(untagged)]
    enum Either {
        Count(u8),
        Text(String),
    }
    for _ in 0..50 {
        assert_eq!(Either::from_json(&parse("1")), Ok(Either::Count(1)));
        assert_eq!(
            Either::from_json(&parse(r#""a""#)),
            Ok(Either::Text("a".to_owned()))
        );
    }
}
