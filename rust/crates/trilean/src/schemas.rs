//! The schemas the npm package exports, by the name each is exported under.
//!
//! One list names them: [`SCHEMAS`]. A document is read as one of them with [`read`], which validates it with the path
//! of every problem and returns it as the schema reads it (the keys it names, in its order, and nothing else). The
//! JSON Schema of each, the TypeScript declarations of all of them and the document the package publishes are written
//! from the same definitions, so what is read, what the schema says and what the declarations say cannot differ.

use std::sync::OnceLock;

use json_shape::{
    Definitions, Draft, Issue, Kind, PathSegment, SchemaOptions, Shape, ShapeDef, Value, check,
    json_schema, normalise, schema_definitions, typescript_declarations,
};

use crate::{
    ArithmeticOperator, ComparisonOperator, ComplexLiteralNode, ComplexPolarLiteralNode,
    ComplexRectangularLiteralNode, ComputedValue, ConditionalCase, DurationUnit, ExpressionNode,
    FoldCombiner, HitPolicy, IndeterminateReason, JsonValue, MembershipOperator, PredicateNode,
    TextComparisonOperator, Unit,
};

/// The deepest nesting of arrays and objects a value may have to be read, which a document deeper than this is refused
/// at, with an issue, before anything recurses to it.
///
/// It is derived from where a stack gives out, which `packages/trilean/test/depth-limit.e2e.test.ts` measures on every
/// run and does not take from this comment: the test builds the module with the limit lifted (`sh scripts/rust.sh xtask npm trilean --measure`), finds by bisection the deepest value of each of several shapes of tree that a Node with its default
/// stack reads without a trap, and finds the same for the module's own 1 MiB stack, and it fails unless this limit is at
/// most half of the smallest of them. Half is the margin: a caller that has already used up to half of its host's stack
/// before it reads a value still reads one at the limit. A host whose stack is smaller than Node's default, or a
/// caller deeper in its own stack than that, can run out first, and V8 then throws a `RangeError` at the entry of the
/// module, which no code in the module can turn into an issue; the documentation of the package says so.
pub const MAX_NESTING_DEPTH: usize = 500;

/// The depth a read is held to: `MAX_NESTING_DEPTH`, except in a build made to measure where the stack gives out, which
/// has none. That build is made by `sh scripts/rust.sh xtask npm trilean --measure`, which sets `--cfg trilean_measure` for it alone,
/// into a target directory of its own, and writes where the package does not ship; no other build has the cfg.
#[cfg(not(trilean_measure))]
pub const fn nesting_limit() -> usize {
    MAX_NESTING_DEPTH
}

/// The depth a read is held to in a build made to measure where the stack gives out: none.
#[cfg(trilean_measure)]
pub const fn nesting_limit() -> usize {
    usize::MAX
}

/// The most elements an array of a document may have, which a longer one is refused at, with an issue, before one is
/// read. Reading an element is a crossing from the host to the module, and each is held as a value of sixteen bytes
/// on the module's 32-bit memory, so the limit is a megabyte of values and some sixty-five thousand crossings, which
/// is far more than a candidate list or a collection of keys holds and far less than a length a host can claim for an
/// array that holds nothing.
pub const MAX_ARRAY_LENGTH: usize = 65_536;

/// The most values (every array, object, string, number, boolean and null) a document may hold in all, which a larger
/// one is refused at, with an issue, once it has been read this far. Reading a value is a few crossings from the host
/// to the module, each about a microsecond, so the limit keeps one read to a few seconds at most; and a value that
/// shares its parts (a JavaScript value can name one array twice) is read once for each place it is named, so without
/// a count a value of forty levels could be read two to the fortieth times. A document of JSON text cannot share
/// parts, and a million values is more than any tree or list the evaluator accepts holds.
pub const MAX_VALUES: usize = 1_000_000;

/// The most code units one string, or one object key, may have, which a longer one is refused at, with an issue, from its
/// length, before a unit of it is copied. It is the length of the longest text a portable pattern is tested against
/// (`trilean_regex::MAX_INPUT_UNITS`, a million) rounded up to a power of two, so a text that the matcher accepts can be
/// read.
pub const MAX_STRING_UNITS: usize = 1_048_576;

/// The most code units of text, in all the strings and object keys of one document, which a read may copy. A string that
/// a value names more than once is copied once for each place it is named, so a count of values does not bound it: a
/// string of a hundred million units named forty times is forty values. A unit is up to three bytes once copied into the
/// module, and the text is held about four times at its largest, as it is read, as it is read again to be returned
/// without the keys a map drops, as the copy that is checked, and as the string written back to the host, so the limit is
/// four million units, which is four strings of the longest length: three bytes a unit and four copies make 48 megabytes
/// of the module's memory at the most, under what a Workers isolate has to give.
pub const MAX_TEXT_UNITS: usize = 4_194_304;

/// The issue message for a string of `units` code units, which is more than `MAX_STRING_UNITS`.
pub fn string_too_long(units: usize) -> String {
    format!("the string has {units} code units, and a string may have at most {MAX_STRING_UNITS}")
}

/// The issue message for a document with more than `MAX_TEXT_UNITS` code units of text.
pub fn too_much_text() -> String {
    format!(
        "the value holds more than {MAX_TEXT_UNITS} code units of text in all, which is more than can be read"
    )
}

/// The issue message for a document with more than `MAX_VALUES` values.
pub fn too_many_values() -> String {
    format!("the value holds more than {MAX_VALUES} values, which is more than can be read")
}

/// The issue message for an array of `length` elements, which is more than `MAX_ARRAY_LENGTH`.
pub fn array_too_long(length: usize) -> String {
    format!("the array has {length} elements, and an array may have at most {MAX_ARRAY_LENGTH}")
}

/// The issues of the limits of this module on `value`, at the paths they are about: an array of more than
/// `MAX_ARRAY_LENGTH` elements, and a value nested more than `MAX_NESTING_DEPTH` levels. A value nested beyond the
/// limit is reported once, at the first value that is too deep, and not descended into.
fn limit_issues(value: &Value) -> Vec<Issue> {
    /// Adds `units` to the text counted so far, and reports the document once, at the string that passed the limit.
    fn note_text(units: usize, path: &[PathSegment], issues: &mut Vec<Issue>, text: &mut usize) {
        let before = *text;
        *text = before.saturating_add(units);
        if before <= MAX_TEXT_UNITS && *text > MAX_TEXT_UNITS {
            issues.push(Issue {
                path: path.to_vec(),
                message: too_much_text(),
            });
        }
    }

    fn visit(
        value: &Value,
        depth: usize,
        path: &mut Vec<PathSegment>,
        issues: &mut Vec<Issue>,
        values: &mut usize,
        text: &mut usize,
    ) {
        *values += 1;
        if *values == MAX_VALUES + 1 {
            issues.push(Issue {
                path: path.clone(),
                message: too_many_values(),
            });
        }
        if *values > MAX_VALUES {
            return;
        }
        if let Value::String(string) = value {
            let units = string.encode_utf16().count();
            if units > MAX_STRING_UNITS {
                issues.push(Issue {
                    path: path.clone(),
                    message: string_too_long(units),
                });
            }
            note_text(units, path, issues, text);
        }
        let (Value::Array(_) | Value::Object(_)) = value else {
            return;
        };
        if depth >= nesting_limit() {
            issues.push(Issue {
                path: path.clone(),
                message: format!(
                    "the value is nested more than {MAX_NESTING_DEPTH} levels deep, which is more than can be read"
                ),
            });
            return;
        }
        match value {
            Value::Array(elements) => {
                if elements.len() > MAX_ARRAY_LENGTH {
                    issues.push(Issue {
                        path: path.clone(),
                        message: array_too_long(elements.len()),
                    });
                    return;
                }
                for (index, element) in elements.iter().enumerate() {
                    path.push(PathSegment::Index(index));
                    visit(element, depth + 1, path, issues, values, text);
                    path.pop();
                }
            }
            Value::Object(members) => {
                for (key, member) in members {
                    path.push(PathSegment::Key(key.clone()));
                    let units = key.encode_utf16().count();
                    if units > MAX_STRING_UNITS {
                        issues.push(Issue {
                            path: path.clone(),
                            message: string_too_long(units),
                        });
                    }
                    note_text(units, path, issues, text);
                    visit(member, depth + 1, path, issues, values, text);
                    path.pop();
                }
            }
            _ => {}
        }
    }
    let mut issues = Vec::new();
    visit(value, 0, &mut Vec::new(), &mut issues, &mut 0, &mut 0);
    issues
}

/// Where the shape of a schema comes from.
#[derive(Clone, Copy, Debug)]
enum Source {
    /// A named definition.
    Definition(&'static str),
    /// The variant of a tagged union that a tag value selects, so its shape holds the tag as a constant.
    Variant {
        /// The tagged union's definition.
        union: &'static str,
        /// The tag value.
        tag: &'static str,
    },
    /// A map of numbers, which is the one type that has no definition of its own.
    Unit,
}

/// One schema the package exports.
#[derive(Clone, Copy, Debug)]
pub struct Schema {
    /// The name it is exported under, for example `NotNodeSchema`.
    pub name: &'static str,
    /// The name of the TypeScript type of what it reads, for example `NotNode`.
    pub type_name: &'static str,
    source: Source,
}

const fn definition(name: &'static str, type_name: &'static str) -> Schema {
    Schema {
        name,
        type_name,
        source: Source::Definition(type_name),
    }
}

const fn predicate(name: &'static str, type_name: &'static str, tag: &'static str) -> Schema {
    Schema {
        name,
        type_name,
        source: Source::Variant {
            union: "PredicateNode",
            tag,
        },
    }
}

const fn expression(name: &'static str, type_name: &'static str, tag: &'static str) -> Schema {
    Schema {
        name,
        type_name,
        source: Source::Variant {
            union: "CoreExpressionNode",
            tag,
        },
    }
}

/// Every schema the package exports, in the order of their names.
pub const SCHEMAS: &[Schema] = &[
    expression("AccumulatorNodeSchema", "AccumulatorNode", "accumulator"),
    predicate("AllOfNodeSchema", "AllOfNode", "allOf"),
    predicate("AndNodeSchema", "AndNode", "and"),
    predicate("AnyOfNodeSchema", "AnyOfNode", "anyOf"),
    expression("ArithmeticNodeSchema", "ArithmeticNode", "arithmetic"),
    definition("ArithmeticOperatorSchema", "ArithmeticOperator"),
    expression(
        "BooleanLiteralNodeSchema",
        "BooleanLiteralNode",
        "booleanLiteral",
    ),
    expression("CallNodeSchema", "CallNode", "call"),
    predicate("CompareNodeSchema", "CompareNode", "compare"),
    definition("ComparisonOperatorSchema", "ComparisonOperator"),
    definition("ComplexLiteralNodeSchema", "ComplexLiteralNode"),
    definition("ComplexPolarLiteralNodeSchema", "ComplexPolarLiteralNode"),
    definition(
        "ComplexRectangularLiteralNodeSchema",
        "ComplexRectangularLiteralNode",
    ),
    definition("ComputedValueSchema", "ComputedValue"),
    definition("ConditionalCaseSchema", "ConditionalCase"),
    expression("ConditionalNodeSchema", "ConditionalNode", "conditional"),
    expression("DelegateNodeSchema", "DelegateNode", "delegate"),
    expression(
        "DurationLiteralNodeSchema",
        "DurationLiteralNode",
        "durationLiteral",
    ),
    definition("DurationUnitSchema", "DurationUnit"),
    predicate("EveryNodeSchema", "EveryNode", "every"),
    predicate("ExistsNodeSchema", "ExistsNode", "exists"),
    definition("ExpressionNodeSchema", "ExpressionNode"),
    definition("FoldCombinerSchema", "FoldCombiner"),
    expression("FoldNodeSchema", "FoldNode", "fold"),
    definition("HitPolicySchema", "HitPolicy"),
    definition("IndeterminateReasonSchema", "IndeterminateReason"),
    expression(
        "InstantLiteralNodeSchema",
        "InstantLiteralNode",
        "instantLiteral",
    ),
    definition("JsonValueSchema", "JsonValue"),
    expression("LookupNodeSchema", "LookupNode", "lookup"),
    predicate("MemberOfNodeSchema", "MemberOfNode", "memberOf"),
    definition("MembershipOperatorSchema", "MembershipOperator"),
    expression("NegateNodeSchema", "NegateNode", "negate"),
    predicate("NotNodeSchema", "NotNode", "not"),
    expression(
        "NumberLiteralNodeSchema",
        "NumberLiteralNode",
        "numberLiteral",
    ),
    predicate("OrNodeSchema", "OrNode", "or"),
    definition("PredicateNodeSchema", "PredicateNode"),
    expression("ReferenceNodeSchema", "ReferenceNode", "reference"),
    predicate("SomeNodeSchema", "SomeNode", "some"),
    predicate("TextCompareNodeSchema", "TextCompareNode", "textCompare"),
    definition("TextComparisonOperatorSchema", "TextComparisonOperator"),
    expression("TextLiteralNodeSchema", "TextLiteralNode", "textLiteral"),
    predicate(
        "TreeReferenceNodeSchema",
        "TreeReferenceNode",
        "treeReference",
    ),
    Schema {
        name: "UnitSchema",
        type_name: "Unit",
        source: Source::Unit,
    },
];

/// The schemas with the definitions they refer to, built once.
struct Registry {
    definitions: Definitions,
    shapes: Vec<ShapeDef>,
}

/// A type that holds every type a schema is exported for, so one registration reaches all their definitions.
#[derive(Shape)]
#[allow(
    dead_code,
    reason = "the type is only described, and no code reads its fields"
)]
struct Everything {
    predicate: PredicateNode,
    expression: ExpressionNode,
    complex: ComplexLiteralNode,
    rectangular: ComplexRectangularLiteralNode,
    polar: ComplexPolarLiteralNode,
    computed: ComputedValue,
    reason: IndeterminateReason,
    case: ConditionalCase,
    combiner: FoldCombiner,
    json: JsonValue,
    duration: DurationUnit,
    comparison: ComparisonOperator,
    text_comparison: TextComparisonOperator,
    membership: MembershipOperator,
    arithmetic: ArithmeticOperator,
    hit_policy: HitPolicy,
    unit: Unit,
}

/// Whether an object is the one form that is refused when it holds a key it does not name. Every other object drops
/// such a key, as the package has always read a document: a complex literal is read strictly, so that a document
/// that mixes its two forms is refused and not silently reduced to one.
fn strict_object(object: &json_shape::ObjectDef) -> bool {
    object.fields.iter().any(|field| {
        field.name == "kind" && field.shape.kind == Kind::ConstString("complexLiteral".to_owned())
    })
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let definitions = Definitions::of::<Everything>()
            .without("Everything")
            .stripping(|object| !strict_object(object));
        let shapes = SCHEMAS
            .iter()
            .map(|schema| match schema.source {
                Source::Definition(name) => ShapeDef::new(Kind::Ref(name.to_owned())),
                Source::Unit => Unit::reference(),
                Source::Variant { union, tag } => {
                    match definitions.get(union).map(|shape| &shape.kind) {
                        Some(Kind::Tagged { variants, .. }) => variants
                            .iter()
                            .find(|(variant, _)| variant == tag)
                            .map(|(_, shape)| shape.clone())
                            .unwrap_or_else(|| panic!("{union} has no variant {tag}")),
                        _ => panic!("{union} is not a tagged union"),
                    }
                }
            })
            .collect();
        Registry {
            definitions,
            shapes,
        }
    })
}

fn find(name: &str) -> Option<(usize, &'static Schema)> {
    SCHEMAS
        .iter()
        .enumerate()
        .find(|(_, schema)| schema.name == name)
}

/// Reads `value` as the schema called `name`: the issues with their paths when it does not match, otherwise the value
/// as the schema reads it. `None` when no schema is called `name`.
pub fn read(name: &str, value: &Value) -> Option<Result<Value, Vec<Issue>>> {
    let (index, _) = find(name)?;
    let registry = registry();
    let shape = &registry.shapes[index];
    let issues = limit_issues(value);
    if !issues.is_empty() {
        return Some(Err(issues));
    }
    let issues = check(&registry.definitions, shape, value);
    Some(if issues.is_empty() {
        Ok(normalise(&registry.definitions, shape, value))
    } else {
        Err(issues)
    })
}

/// The JSON Schema of the schema called `name`, which refers to the definitions of [`definitions_schema`] as
/// `#/$defs/<name>`, so a document that embeds it holds those definitions under its own `$defs`. `None` when no schema
/// is called `name`.
pub fn json_schema_of(name: &str) -> Option<Value> {
    let (index, schema) = find(name)?;
    let registry = registry();
    let document = json_schema(
        &registry.shapes[index],
        schema.type_name,
        &registry.definitions,
        &SchemaOptions {
            draft: Draft::Draft2020_12,
            id: None,
            title: None,
        },
    );
    Some(match document {
        Value::Object(pairs) => Value::Object(
            pairs
                .into_iter()
                .filter(|(key, _)| key != "$schema" && key != "$defs")
                .collect(),
        ),
        other => other,
    })
}

/// Every definition, as the JSON Schema the schemas of [`json_schema_of`] refer to: the object a document that embeds a
/// schema holds under `$defs`.
pub fn definitions_schema() -> Value {
    let registry = registry();
    Value::Object(schema_definitions(
        &registry.definitions,
        Draft::Draft2020_12,
        "#/$defs",
    ))
}

/// The plain arrays the package exports beside the schemas, by the name each is exported under: the members of each
/// enumeration, and the node kinds of the two trees.
pub fn enumerations() -> Vec<(&'static str, &'static str, Vec<String>)> {
    let options = |name: &str| options_of(name).expect("a schema of an enumeration");
    let tags = |name: &str| tags_of(name).expect("a tagged union");
    let mut expression = tags("CoreExpressionNode");
    expression.push("complexLiteral".to_owned());
    vec![
        (
            "comparisonOperators",
            "ComparisonOperator",
            options("ComparisonOperatorSchema"),
        ),
        (
            "textComparisonOperators",
            "TextComparisonOperator",
            options("TextComparisonOperatorSchema"),
        ),
        (
            "membershipOperators",
            "MembershipOperator",
            options("MembershipOperatorSchema"),
        ),
        (
            "arithmeticOperators",
            "ArithmeticOperator",
            options("ArithmeticOperatorSchema"),
        ),
        ("hitPolicies", "HitPolicy", options("HitPolicySchema")),
        (
            "durationUnits",
            "DurationUnit",
            options("DurationUnitSchema"),
        ),
        (
            "predicateKinds",
            "PredicateNode[\"kind\"]",
            tags("PredicateNode"),
        ),
        ("expressionKinds", "ExpressionNode[\"kind\"]", expression),
    ]
}

/// The members of the enumeration called `name`, when it is one.
pub fn options_of(name: &str) -> Option<Vec<String>> {
    let (_, schema) = find(name)?;
    let definition = registry().definitions.get(schema.type_name)?;
    match &definition.kind {
        Kind::Enum(options) => Some(options.clone()),
        _ => None,
    }
}

/// The tags of the tagged union called `name` (`PredicateNode` or `CoreExpressionNode`), in declaration order.
pub fn tags_of(name: &str) -> Option<Vec<String>> {
    match &registry().definitions.get(name)?.kind {
        Kind::Tagged { variants, .. } => {
            Some(variants.iter().map(|(tag, _)| tag.clone()).collect())
        }
        _ => None,
    }
}

/// The document the package publishes as `schemas/trilean.schema.json`: a draft 2020-12 schema whose root is a
/// predicate or an expression node, with `PredicateNode` and `ExpressionNode` and everything they refer to under `$defs`.
pub fn published_document(id: &str) -> Value {
    let registry = registry();
    let root = ShapeDef::new(Kind::OneOf(vec![
        ShapeDef::new(Kind::Ref("PredicateNode".to_owned())),
        ShapeDef::new(Kind::Ref("ExpressionNode".to_owned())),
    ]));
    json_schema(
        &root,
        "",
        &registry.definitions,
        &SchemaOptions {
            draft: Draft::Draft2020_12,
            id: Some(id),
            title: None,
        },
    )
}

/// The TypeScript declarations of every type, then the named types of each tree node and of the unit.
pub fn typescript() -> String {
    let registry = registry();
    let mut text = typescript_declarations(&registry.definitions);
    text.push_str(
        "/** Dimension symbol to exponent, for example `{ m: 1, s: -1 }` for metres per second. */\nexport type Unit = { [key: string]: number };\n",
    );
    for schema in SCHEMAS {
        if let Source::Variant { union, tag } = schema.source {
            let parent = if union == "PredicateNode" {
                "PredicateNode"
            } else {
                "ExpressionNode"
            };
            text.push_str(&format!(
                "export type {} = Extract<{parent}, {{ kind: \"{tag}\" }}>;\n",
                schema.type_name
            ));
        }
    }
    text
}
