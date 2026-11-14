//! The JSON Schema a shape writes.

use crate::def::{Definitions, Kind, ObjectDef, ShapeDef};
use crate::shape::Shape;
use crate::value::Value;

/// The JSON Schema draft to write.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Draft {
    /// Writes `definitions` and references under `#/definitions/`, and `dependencies` for required-together keys.
    Draft07,
    /// Writes `$defs` and references under `#/$defs/`, and `dependentRequired`.
    #[default]
    Draft2020_12,
}

/// How a standalone schema document is written.
#[derive(Clone, Copy, Debug, Default)]
pub struct SchemaOptions<'a> {
    pub draft: Draft,
    /// The `$id` of the document.
    pub id: Option<&'a str>,
    /// The `title` of the document.
    pub title: Option<&'a str>,
}

/// Where references point and how the dependent keys are written.
#[derive(Clone, Copy)]
struct Writer<'a> {
    draft: Draft,
    pointer: &'a str,
}

/// A definition name as the last step of a `$ref`: a JSON Pointer token (`~` as `~0`, `/` as `~1`), then written as a
/// URI fragment, where every byte outside the characters a fragment allows is percent-encoded.
fn reference_token(name: &str) -> String {
    let token = name.replace('~', "~0").replace('/', "~1");
    let mut written = String::new();
    for byte in token.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&byte) {
            written.push(char::from(byte));
        } else {
            written.push_str(&format!("%{byte:02X}"));
        }
    }
    written
}

fn number(value: f64) -> Value {
    Value::Number(value)
}

fn count(value: usize) -> Value {
    // A count is far below 2^53, so it is exact as a JSON number.
    Value::Number(value as f64)
}

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn push(pairs: &mut Vec<(String, Value)>, key: &str, value: Value) {
    pairs.push((key.to_owned(), value));
}

fn object(pairs: Vec<(String, Value)>) -> Value {
    Value::Object(pairs)
}

fn typed(name: &str) -> Vec<(String, Value)> {
    vec![("type".to_owned(), text(name))]
}

/// The schema of one shape, with references written as `options` say.
fn shape_schema(shape: &ShapeDef, options: Writer<'_>) -> Value {
    let mut pairs = match &shape.kind {
        Kind::Any => Vec::new(),
        Kind::Null => typed("null"),
        Kind::Bool => typed("boolean"),
        Kind::ConstBool(flag) => vec![("const".to_owned(), Value::Bool(*flag))],
        Kind::ConstString(value) => vec![("const".to_owned(), text(value))],
        Kind::Enum(options) => vec![(
            "enum".to_owned(),
            Value::Array(options.iter().map(|option| text(option)).collect()),
        )],
        Kind::String {
            min_length,
            pattern,
        } => {
            let mut pairs = typed("string");
            if let Some(least) = min_length {
                push(&mut pairs, "minLength", count(*least));
            }
            if let Some(source) = pattern {
                push(&mut pairs, "pattern", text(source));
            }
            pairs
        }
        Kind::Integer { min, max } => bounded("integer", *min, *max),
        Kind::Number { min, max } => bounded("number", *min, *max),
        Kind::Array {
            items,
            min_items,
            max_items,
            unique,
        } => {
            let mut pairs = typed("array");
            if items.kind != Kind::Any || items.description.is_some() {
                push(&mut pairs, "items", shape_schema(items, options));
            }
            if let Some(least) = min_items {
                push(&mut pairs, "minItems", count(*least));
            }
            if let Some(most) = max_items {
                push(&mut pairs, "maxItems", count(*most));
            }
            if *unique {
                push(&mut pairs, "uniqueItems", Value::Bool(true));
            }
            pairs
        }
        Kind::Map {
            values,
            min_properties,
            key_pattern,
        } => {
            let mut pairs = typed("object");
            push(
                &mut pairs,
                "additionalProperties",
                shape_schema(values, options),
            );
            if let Some(least) = min_properties {
                push(&mut pairs, "minProperties", count(*least));
            }
            if let Some(source) = key_pattern {
                push(
                    &mut pairs,
                    "propertyNames",
                    object(vec![("pattern".to_owned(), text(source))]),
                );
            }
            pairs
        }
        Kind::Object(definition) => object_pairs(definition, options),
        Kind::OneOf(alternatives) => vec![(
            "oneOf".to_owned(),
            Value::Array(
                alternatives
                    .iter()
                    .map(|alternative| shape_schema(alternative, options))
                    .collect(),
            ),
        )],
        Kind::Tagged { variants, .. } => vec![(
            "oneOf".to_owned(),
            Value::Array(
                variants
                    .iter()
                    .map(|(_, variant)| shape_schema(variant, options))
                    .collect(),
            ),
        )],
        Kind::Ref(name) => vec![(
            "$ref".to_owned(),
            text(&format!("{}/{}", options.pointer, reference_token(name))),
        )],
    };
    if let Some(description) = &shape.description {
        push(&mut pairs, "description", text(description));
    }
    object(pairs)
}

fn bounded(name: &str, min: Option<f64>, max: Option<f64>) -> Vec<(String, Value)> {
    let mut pairs = typed(name);
    if let Some(least) = min {
        push(&mut pairs, "minimum", number(least));
    }
    if let Some(most) = max {
        push(&mut pairs, "maximum", number(most));
    }
    pairs
}

fn object_pairs(definition: &ObjectDef, options: Writer<'_>) -> Vec<(String, Value)> {
    let mut pairs = typed("object");
    if !definition.fields.is_empty() {
        push(
            &mut pairs,
            "properties",
            object(
                definition
                    .fields
                    .iter()
                    .map(|field| (field.name.clone(), shape_schema(&field.shape, options)))
                    .collect(),
            ),
        );
    }
    let required: Vec<Value> = definition
        .fields
        .iter()
        .filter(|field| field.required)
        .map(|field| text(&field.name))
        .collect();
    if !required.is_empty() {
        push(&mut pairs, "required", Value::Array(required));
    }
    if definition.closed {
        push(&mut pairs, "additionalProperties", Value::Bool(false));
    }
    if let Some(least) = definition.min_properties {
        push(&mut pairs, "minProperties", count(least));
    }
    if !definition.dependent_required.is_empty() {
        let keyword = match options.draft {
            Draft::Draft07 => "dependencies",
            Draft::Draft2020_12 => "dependentRequired",
        };
        push(
            &mut pairs,
            keyword,
            object(
                definition
                    .dependent_required
                    .iter()
                    .map(|(key, others)| {
                        (
                            key.clone(),
                            Value::Array(others.iter().map(|other| text(other)).collect()),
                        )
                    })
                    .collect(),
            ),
        );
    }
    pairs
}

fn definitions_keyword(draft: Draft) -> &'static str {
    match draft {
        Draft::Draft07 => "definitions",
        Draft::Draft2020_12 => "$defs",
    }
}

/// Just the definitions, each as a schema whose references are written under `pointer`, a JSON Pointer fragment
/// such as `#/definitions/trilean`, which is where the document that embeds them holds them.
pub fn schema_definitions(
    definitions: &Definitions,
    draft: Draft,
    pointer: &str,
) -> Vec<(String, Value)> {
    let writer = Writer { draft, pointer };
    definitions
        .iter()
        .map(|(name, shape)| (name.to_owned(), shape_schema(shape, writer)))
        .collect()
}

/// A standalone document for `root`, written inline at the top with every other definition under `$defs` (or
/// `definitions`). `root_name` is the root's own definition, dropped from the block unless another definition
/// refers to it.
pub fn json_schema(
    root: &ShapeDef,
    root_name: &str,
    definitions: &Definitions,
    options: &SchemaOptions<'_>,
) -> Value {
    let mut pairs = Vec::new();
    push(
        &mut pairs,
        "$schema",
        text(match options.draft {
            Draft::Draft07 => "http://json-schema.org/draft-07/schema#",
            Draft::Draft2020_12 => "https://json-schema.org/draft/2020-12/schema",
        }),
    );
    if let Some(id) = options.id {
        push(&mut pairs, "$id", text(id));
    }
    if let Some(title) = options.title {
        push(&mut pairs, "title", text(title));
    }
    let pointer = match options.draft {
        Draft::Draft07 => "#/definitions",
        Draft::Draft2020_12 => "#/$defs",
    };
    let writer = Writer {
        draft: options.draft,
        pointer,
    };
    let Value::Object(body) = shape_schema(root, writer) else {
        unreachable!("a shape's schema is an object")
    };
    pairs.extend(body);
    let kept = if refers_to(definitions, root_name) || mentions(root, root_name) {
        definitions.clone()
    } else {
        definitions.clone().without(root_name)
    };
    if !kept.is_empty() {
        push(
            &mut pairs,
            definitions_keyword(options.draft),
            object(schema_definitions(&kept, options.draft, pointer)),
        );
    }
    object(pairs)
}

/// Whether any definition other than `name` refers to it.
fn refers_to(definitions: &Definitions, name: &str) -> bool {
    definitions
        .iter()
        .filter(|(entry, _)| *entry != name)
        .any(|(_, shape)| mentions(shape, name))
}

fn mentions(shape: &ShapeDef, name: &str) -> bool {
    match &shape.kind {
        Kind::Ref(target) => target == name,
        Kind::Array { items, .. } => mentions(items, name),
        Kind::Map { values, .. } => mentions(values, name),
        Kind::Object(definition) => definition
            .fields
            .iter()
            .any(|field| mentions(&field.shape, name)),
        Kind::OneOf(alternatives) => alternatives
            .iter()
            .any(|alternative| mentions(alternative, name)),
        Kind::Tagged { variants, .. } => {
            variants.iter().any(|(_, variant)| mentions(variant, name))
        }
        _ => false,
    }
}

/// The standalone document for the type `T`, named by `root_name`, with the definitions it needs.
pub fn schema_of<T: Shape>(root_name: &str, options: &SchemaOptions<'_>) -> Value {
    json_schema(&T::definition(), root_name, &T::definitions(), options)
}
