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

/// Doubles and the text `JSON.stringify` writes for them in V8, around the points where the text changes form: 2^53,
/// 2^63, 2^64, 9e18, 1e20 and 1e21 (whole numbers written as digits and zeros, then an exponent), 1e-6 and 1e-7
/// (a fraction, then an exponent), the smallest double and a large one.
const JAVASCRIPT_WRITINGS: [(&str, u64); 60] = [
    ("9007199254740991", 0x433fffffffffffff),
    ("9007199254740992", 0x4340000000000000),
    ("9007199254740994", 0x4340000000000001),
    ("9223372036854775000", 0x43dfffffffffffff),
    ("9223372036854776000", 0x43e0000000000000),
    ("9223372036854778000", 0x43e0000000000001),
    ("8999999999999999000", 0x43df399b1438a0ff),
    ("9000000000000000000", 0x43df399b1438a100),
    ("9000000000000001000", 0x43df399b1438a101),
    ("99999999999999980000", 0x4415af1d78b58c3f),
    ("100000000000000000000", 0x4415af1d78b58c40),
    ("100000000000000020000", 0x4415af1d78b58c41),
    ("999999999999999900000", 0x444b1ae4d6e2ef4f),
    ("1e+21", 0x444b1ae4d6e2ef50),
    ("1.0000000000000001e+21", 0x444b1ae4d6e2ef51),
    ("18446744073709550000", 0x43efffffffffffff),
    ("18446744073709552000", 0x43f0000000000000),
    ("18446744073709556000", 0x43f0000000000001),
    ("9.999999999999997e-7", 0x3eb0c6f7a0b5ed8c),
    ("0.000001", 0x3eb0c6f7a0b5ed8d),
    ("0.0000010000000000000002", 0x3eb0c6f7a0b5ed8e),
    ("9.999999999999998e-8", 0x3e7ad7f29abcaf47),
    ("1e-7", 0x3e7ad7f29abcaf48),
    ("1.0000000000000001e-7", 0x3e7ad7f29abcaf49),
    ("123456789012345670000", 0x441ac53a7e04bcd9),
    ("123456789012345680000", 0x441ac53a7e04bcda),
    ("123456789012345700000", 0x441ac53a7e04bcdb),
    ("0", 0x0),
    ("5e-324", 0x1),
    ("1e-323", 0x2),
    ("0.09999999999999999", 0x3fb9999999999999),
    ("0.1", 0x3fb999999999999a),
    ("0.10000000000000002", 0x3fb999999999999b),
    ("99.99999999999999", 0x4058ffffffffffff),
    ("100", 0x4059000000000000),
    ("100.00000000000001", 0x4059000000000001),
    ("9999999999999998", 0x4341c37937e07fff),
    ("10000000000000000", 0x4341c37937e08000),
    ("10000000000000002", 0x4341c37937e08001),
    ("1.4999999999999998e+300", 0x7e41eb2d66005834),
    ("1.5e+300", 0x7e41eb2d66005835),
    ("1.5000000000000004e+300", 0x7e41eb2d66005836),
    ("-1123862794281901.2", 0xc30f_f12d_9509_1d6a),
    ("939351761501218.2", 0x430a_b2af_0081_e112),
    ("91398882099531.62", 0x42d4_c81d_79a0_52e8),
    ("1125899906842624.2", 0x4310_0000_0000_0001),
    ("1125899906842624.8", 0x4310_0000_0000_0003),
    ("1125899906842625.2", 0x4310_0000_0000_0005),
    ("2251799813685248.5", 0x4320_0000_0000_0001),
    ("562949953421312.1", 0x4300_0000_0000_0001),
    ("562949953421312.4", 0x4300_0000_0000_0003),
    ("281474976710656.06", 0x42f0_0000_0000_0001),
    ("0.5", 0x3fe0_0000_0000_0000),
    ("1.5", 0x3ff8_0000_0000_0000),
    ("2.5", 0x4004_0000_0000_0000),
    ("1e+22", 0x4480_f0cf_064d_d592),
    ("1.5e-323", 0x3),
    ("4.35", 0x4011_6666_6666_6666),
    ("1125899906842626.2", 0x4310_0000_0000_0009),
    ("1125899906842627.2", 0x4310_0000_0000_000d),
];

#[test]
fn serialize_writes_the_text_json_stringify_writes() {
    let mut differing = Vec::new();
    for (text, bits) in JAVASCRIPT_WRITINGS {
        let number = Value::Number(f64::from_bits(bits));
        let serialised = serde_json::to_string(&number).expect("JSON");
        if serialised != text {
            differing.push(format!(
                "{bits:#x}: Serialize writes {serialised}, JSON.stringify writes {text}"
            ));
        }
        if number.to_string() != text {
            differing.push(format!(
                "{bits:#x}: Display writes {number}, JSON.stringify writes {text}"
            ));
        }
        let converted = serde_json::to_value(&number).expect("a number converts");
        assert_eq!(
            converted.as_f64().map(f64::to_bits),
            Some(bits),
            "to_value of {text}"
        );
    }
    assert!(differing.is_empty(), "{}", differing.join("\n"));
}
