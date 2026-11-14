//! The derive, the validator and the emitters, on types written for these tests.

use json_shape::{
    Definitions, Draft, Map, OpenObject, SchemaOptions, Shape, Value, schema_definitions,
    schema_of, typescript_declarations,
};

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("valid JSON")
}

/// A pair of a point and a label.
#[derive(Shape, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct Point {
    x: u8,
    /// Where the label goes.
    label: Option<String>,
    #[serde(default)]
    visible: bool,
}

#[derive(Shape, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Colour {
    Red,
    DarkGreen,
}

#[derive(Shape, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Node {
    Leaf,
    AnyOf { children: Vec<Node> },
    Wrapped(Point),
    Either { left: Box<Node>, right: Box<Node> },
}

#[derive(Shape, Debug, PartialEq)]
#[serde(untagged)]
enum Text {
    Plain(String),
    Units {
        #[serde(rename = "codeUnits")]
        code_units: Vec<u16>,
    },
    Nothing,
}

#[derive(Shape, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
#[shape(together(only, reason))]
struct Marked {
    only: Option<String>,
    reason: Option<String>,
    #[shape(min_items = 1, max_items = 2, unique_items)]
    ids: Vec<String>,
    #[shape(pattern = "^[a-z]+$", min_length = 2)]
    word: String,
    #[shape(min = 1, max = 5)]
    rank: u32,
    #[shape(constant = true)]
    ok: bool,
}

#[derive(Shape, Debug, PartialEq)]
struct Common {
    id: String,
}

#[derive(Shape, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct Flattened {
    #[serde(flatten)]
    common: Common,
    extra: u8,
}

#[derive(Shape, Debug, PartialEq)]
struct Payloads {
    any: Value,
    object: OpenObject,
    map: Map<u8>,
}

#[test]
fn a_struct_deserialises_and_refuses_what_its_shape_refuses() {
    let point: Point = serde_json::from_str(r#"{"x":3,"label":"a"}"#).expect("valid");
    assert_eq!(
        point,
        Point {
            x: 3,
            label: Some("a".to_owned()),
            visible: false
        }
    );
    let error = serde_json::from_str::<Point>(r#"{"x":256,"extra":1}"#).expect_err("invalid");
    let message = error.to_string();
    assert!(message.contains("/x: expected at most 255"), "{message}");
    assert!(message.contains("/extra: unexpected property"), "{message}");
}

#[test]
fn every_issue_is_collected_with_its_path() {
    let issues = Node::from_json(&parse(
        r#"{"kind":"anyOf","children":[{"kind":"leaf"},{"kind":"wrapped","x":-1},{"kind":"nope"}]}"#,
    ))
    .expect_err("invalid");
    let pointers: Vec<String> = issues.0.iter().map(json_shape::Issue::pointer).collect();
    assert_eq!(pointers, ["/children/1/x", "/children/2/kind"]);
}

#[test]
fn whole_numbers_written_with_a_fraction_are_integers() {
    assert!(Point::accepts(&parse(r#"{"x":97.0}"#)));
    assert!(!Point::accepts(&parse(r#"{"x":97.5}"#)));
    assert!(!Point::accepts(&parse(r#"{"x":-1}"#)));
}

#[test]
fn the_largest_safe_integer_is_the_bound() {
    #[derive(Shape)]
    struct Big {
        value: u64,
    }
    assert_eq!(
        Big::from_json(&parse(r#"{"value":9007199254740991}"#)).map(|big| big.value),
        Ok(9_007_199_254_740_991)
    );
    assert!(!Big::accepts(&parse(r#"{"value":9007199254740992}"#)));
    assert!(!Big::accepts(&parse(r#"{"value":9007199254740993}"#)));
    assert!(!Big::accepts(&parse(r#"{"value":1e20}"#)));
}

#[test]
fn enums_and_unions_convert() {
    assert_eq!(
        Colour::from_json(&parse(r#""dark-green""#)),
        Ok(Colour::DarkGreen)
    );
    assert!(Colour::from_json(&parse(r#""blue""#)).is_err());
    assert_eq!(
        Node::from_json(&parse(
            r#"{"kind":"either","left":{"kind":"leaf"},"right":{"kind":"leaf"}}"#
        )),
        Ok(Node::Either {
            left: Box::new(Node::Leaf),
            right: Box::new(Node::Leaf)
        })
    );
    assert_eq!(
        Node::from_json(&parse(r#"{"kind":"wrapped","x":1}"#)),
        Ok(Node::Wrapped(Point {
            x: 1,
            label: None,
            visible: false
        }))
    );
    assert_eq!(
        Text::from_json(&parse(r#""a""#)),
        Ok(Text::Plain("a".to_owned()))
    );
    assert_eq!(
        Text::from_json(&parse(r#"{"codeUnits":[1,2]}"#)),
        Ok(Text::Units {
            code_units: vec![1, 2]
        })
    );
    assert_eq!(Text::from_json(&parse("null")), Ok(Text::Nothing));
    assert!(Text::from_json(&parse("3")).is_err());
}

#[test]
fn constraints_apply() {
    let valid = r#"{"ids":["a"],"word":"ab","rank":5,"ok":true}"#;
    assert_eq!(
        Marked::from_json(&parse(valid)),
        Ok(Marked {
            only: None,
            reason: None,
            ids: vec!["a".to_owned()],
            word: "ab".to_owned(),
            rank: 5,
            ok: true
        })
    );
    for invalid in [
        r#"{"ids":[],"word":"ab","rank":5,"ok":true}"#,
        r#"{"ids":["a","b","c"],"word":"ab","rank":5,"ok":true}"#,
        r#"{"ids":["a","a"],"word":"ab","rank":5,"ok":true}"#,
        r#"{"ids":["a"],"word":"a","rank":5,"ok":true}"#,
        r#"{"ids":["a"],"word":"aB","rank":5,"ok":true}"#,
        r#"{"ids":["a"],"word":"ab","rank":6,"ok":true}"#,
        r#"{"ids":["a"],"word":"ab","rank":0,"ok":true}"#,
        r#"{"ids":["a"],"word":"ab","rank":5,"ok":false}"#,
        r#"{"only":"x","ids":["a"],"word":"ab","rank":5,"ok":true}"#,
        r#"{"reason":"x","ids":["a"],"word":"ab","rank":5,"ok":true}"#,
    ] {
        assert!(!Marked::accepts(&parse(invalid)), "{invalid}");
    }
    assert!(Marked::accepts(&parse(
        r#"{"only":"x","reason":"y","ids":["a"],"word":"ab","rank":5,"ok":true}"#
    )));
}

#[test]
fn a_flattened_field_merges_its_fields() {
    assert_eq!(
        Flattened::from_json(&parse(r#"{"id":"a","extra":1}"#)),
        Ok(Flattened {
            common: Common { id: "a".to_owned() },
            extra: 1
        })
    );
    assert!(!Flattened::accepts(&parse(
        r#"{"id":"a","extra":1,"more":2}"#
    )));
}

#[test]
fn key_order_and_duplicates_follow_json_parse() {
    let payloads = Payloads::from_json(&parse(
        r#"{"any":{"b":1,"a":2,"b":3},"object":{"z":1,"y":2},"map":{"q":1,"p":2}}"#,
    ))
    .expect("valid");
    assert_eq!(payloads.any.to_string(), r#"{"b":3,"a":2}"#);
    assert_eq!(
        payloads
            .object
            .0
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        ["z", "y"]
    );
    assert_eq!(
        payloads
            .map
            .0
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        ["q", "p"]
    );
}

#[test]
fn the_schema_is_written_in_both_drafts() {
    let defaults = SchemaOptions::default();
    let schema = schema_of::<Marked>("Marked", &defaults).to_string();
    assert!(
        schema.contains(r#""dependentRequired":{"only":["reason"],"reason":["only"]}"#),
        "{schema}"
    );
    assert!(schema.contains(r#""additionalProperties":false"#));
    assert!(schema.contains(r#""ok":{"const":true}"#));
    let draft07 = SchemaOptions {
        draft: Draft::Draft07,
        ..SchemaOptions::default()
    };
    let schema = schema_of::<Node>("Node", &draft07).to_string();
    assert!(
        schema.contains(r#""$ref":"#) && schema.contains("#/definitions/Node"),
        "{schema}"
    );
    assert!(!schema.contains("$defs"));
}

#[test]
fn definitions_alone_are_written_against_the_callers_pointer() {
    let options = SchemaOptions {
        draft: Draft::Draft07,
        definitions_pointer: Some("#/definitions/trilean"),
        ..SchemaOptions::default()
    };
    let written = schema_definitions(&Definitions::of::<Node>(), &options);
    let names: Vec<&str> = written.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["Node"]);
    let node = Value::Object(written).to_string();
    assert!(node.contains("#/definitions/trilean/Node"), "{node}");
    assert!(!node.contains("#/definitions/Node"));
}

#[test]
fn typescript_declarations_follow_the_shape() {
    let written = typescript_declarations(&Definitions::of::<Point>());
    assert!(written.contains("export type Point = {"), "{written}");
    assert!(written.contains("x: number;"));
    assert!(written.contains("label?: string;"));
    assert!(written.contains("/** Where the label goes. */"));
    let tagged = typescript_declarations(&Definitions::of::<Node>());
    assert!(tagged.contains(r#"kind: "leaf""#), "{tagged}");
    assert!(tagged.contains("children: Node[];"), "{tagged}");
}
