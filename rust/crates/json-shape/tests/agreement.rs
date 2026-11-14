//! The derived validator and the emitted JSON Schema must accept and refuse the same documents, in both drafts.
//!
//! Two tables of documents hold the verdicts: `documents.json` is written by hand, for the edge cases a person can
//! name, and `generated.json` is built here from the descriptors (a minimal accepting document, the other accepting
//! forms and one mutation per constraint, for every kind in every position the derive supports), with each verdict
//! known from how the document was built. The validator is checked against both tables, and the schemas committed
//! beside them (`schema.json` and `schema-draft-07.json`) and both tables are checked to be what is regenerated
//! here. The root test `shape-agreement.integration.test.ts` runs both tables through Ajv in strict mode against both
//! committed schemas, so the validator and the emitted schema are held to the same verdicts.
//!
//! `UPDATE_SHAPE_FIXTURES=1` rewrites the committed schemas and `generated.json` from the types.

#![expect(
    dead_code,
    reason = "the types exist to be described and validated against, and no code reads their fields"
)]

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use json_shape::{
    Definitions, Draft, Kind, Map, ObjectDef, OpenObject, Pattern, Registry, Shape, ShapeDef,
    Value, accepts, schema_definitions,
};

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Closed {
    name: String,
    note: Option<String>,
}

#[derive(Shape)]
struct Open {
    name: String,
}

#[derive(Shape)]
#[serde(rename_all = "lowercase")]
enum Colour {
    Red,
    Green,
}

#[derive(Shape)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Figure {
    Dot,
    Circle {
        #[shape(min = 0)]
        radius: f64,
    },
    Square {
        side: u8,
    },
    Group {
        members: Vec<Figure>,
    },
}

#[derive(Shape)]
#[serde(untagged, deny_unknown_fields)]
enum Either {
    Count(u8),
    Words(String),
    Pair { first: String, second: String },
    Nothing,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Bounds {
    small: Option<u8>,
    wide: Option<u64>,
    signed: Option<i64>,
    #[shape(min = 10, max = 20)]
    ranged: Option<u32>,
    #[shape(min = 0, max = 1)]
    ratio: Option<f64>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Lengths {
    #[shape(min_items = 1, max_items = 3)]
    items: Option<Vec<String>>,
    #[shape(unique_items)]
    distinct: Option<Vec<u8>>,
    #[shape(min_length = 2)]
    text: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Patterned {
    #[shape(pattern = "^[a-z0-9][a-z0-9._-]*$")]
    id: Option<String>,
    #[shape(pattern = r"^(recorded: .+|[a-z0-9._-]+\.test\.ts: .+)$")]
    from: Option<String>,
    #[shape(pattern = "[0-9]")]
    unanchored: Option<String>,
    #[shape(pattern = "^[^/]*/[^/]*$")]
    one_slash: Option<String>,
    #[shape(pattern = "^.$")]
    single: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Files {
    #[shape(min_properties = 1, property_names = r"^[a-z]+\.json$")]
    files: Map<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
#[shape(together(only, reason))]
struct Together {
    only: Option<String>,
    reason: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Constants {
    #[shape(constant = true)]
    ok: bool,
    #[shape(constant = "x")]
    label: Option<String>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Chain {
    value: u8,
    next: Option<Box<Chain>>,
}

#[derive(Shape)]
struct Common {
    id: String,
}

#[derive(Shape)]
#[serde(deny_unknown_fields)]
struct Flat {
    #[serde(flatten)]
    common: Common,
    extra: Option<u8>,
}

#[derive(Shape)]
struct Raw {
    any: Value,
    object: OpenObject,
    nested: Vec<Vec<Closed>>,
}

#[derive(Shape)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Renamed {
    first_name: String,
    #[serde(rename = "other-key")]
    other: Option<u8>,
    #[serde(default)]
    flag: bool,
}

#[derive(Shape)]
#[serde(tag = "kind")]
enum Wrapper {
    Plain(Closed),
    Other(Open),
}

#[derive(Shape)]
#[serde(untagged)]
enum Overlap {
    Number(f64),
    Text(String),
    Starts(#[shape(pattern = "^a")] String),
}

#[derive(Shape)]
#[shape(min_properties = 2)]
struct Sparse {
    a: Option<u8>,
    b: Option<u8>,
    c: Option<u8>,
}

#[derive(Shape)]
#[serde(untagged)]
enum Shaped {
    #[shape(min_length = 2)]
    Word(String),
    Counted(#[shape(min = 1, max = 3)] u8),
    Nothing,
}

#[derive(Shape)]
struct CatchAll {
    kind: String,
    #[serde(flatten)]
    rest: Map<u8>,
}

#[derive(Shape)]
#[shape(any_of(first, second))]
struct AnyOfKeys {
    first: Option<u8>,
    second: Option<String>,
}

#[derive(Shape)]
#[shape(one_of(first, second))]
struct OneOfKeys {
    first: Option<u8>,
    second: Option<String>,
}

#[derive(Shape)]
struct Exclusive {
    #[shape(exclusive_min = 0)]
    above: f64,
    #[shape(exclusive_min = 1, max = 3)]
    count: Option<u8>,
}

macro_rules! roots {
    ($($root:ident),* $(,)?) => {
        /// The types the tables name, each with a document of every verdict.
        const TYPES: &[&str] = &[$(stringify!($root)),*];

        /// Whether the derived validator of the named type accepts the value.
        fn derived_verdict(name: &str, value: &Value) -> bool {
            match name {
                $(stringify!($root) => $root::accepts(value),)*
                other => panic!("the table names the unknown type {other}"),
            }
        }

        fn register_all(registry: &mut Registry) {
            $($root::register(registry);)*
        }
    };
}

roots!(
    Closed, Open, Colour, Figure, Either, Bounds, Lengths, Patterned, Files, Together, Constants,
    Chain, Flat, Raw, Renamed, Wrapper, Overlap, Sparse, Shaped, CatchAll, AnyOfKeys, OneOfKeys,
    Exclusive,
);

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/fixtures/shape-agreement")
}

fn definitions() -> Definitions {
    let mut registry = Registry::default();
    register_all(&mut registry);
    registry.into_definitions()
}

/// The committed schema of a draft: every definition, written as the draft writes them.
fn emitted_schema(draft: Draft) -> serde_json::Value {
    let (uri, keyword, pointer) = match draft {
        Draft::Draft2020_12 => (
            "https://json-schema.org/draft/2020-12/schema",
            "$defs",
            "#/$defs",
        ),
        Draft::Draft07 => (
            "http://json-schema.org/draft-07/schema#",
            "definitions",
            "#/definitions",
        ),
    };
    let document = Value::Object(vec![
        ("$schema".to_owned(), Value::String(uri.to_owned())),
        (
            keyword.to_owned(),
            Value::Object(schema_definitions(&definitions(), draft, pointer)),
        ),
    ]);
    serde_json::to_value(&document).expect("a schema is JSON")
}

/// A document the tables hold, with the verdict it must get.
struct Row {
    root: String,
    case: String,
    valid: bool,
    document: Value,
}

struct Generator<'a> {
    definitions: &'a Definitions,
}

type Documents = Vec<(String, Value)>;

const GOOD_STRINGS: &[&str] = &[
    "a",
    "b",
    "ab",
    "a0",
    "a.b",
    "0",
    "aa",
    "a/b",
    "a.json",
    "b.json",
    "recorded: x",
    "x.test.ts: y",
    "zz",
];
const BAD_STRINGS: &[&str] = &["", "A", "-a", "!", "\n", "9", "a", "/", "Z.json", "zz.txt"];

fn object(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn set(document: &Value, key: &str, value: Value) -> Value {
    let mut pairs = document.as_object().expect("an object").to_vec();
    match pairs.iter_mut().find(|(name, _)| name == key) {
        Some(pair) => pair.1 = value,
        None => pairs.push((key.to_owned(), value)),
    }
    Value::Object(pairs)
}

fn without(document: &Value, key: &str) -> Value {
    Value::Object(
        document
            .as_object()
            .expect("an object")
            .iter()
            .filter(|(name, _)| name != key)
            .cloned()
            .collect(),
    )
}

impl Generator<'_> {
    fn resolve<'b>(&'b self, shape: &'b ShapeDef) -> &'b ShapeDef {
        match &shape.kind {
            Kind::Ref(name) => self.resolve(self.definitions.get(name).expect("a defined name")),
            _ => shape,
        }
    }

    /// Strings of the pool that do (or, for `want` false, do not) match `pattern` and have `min_length` characters.
    fn strings(&self, min_length: usize, pattern: Option<&str>, want: bool) -> Vec<String> {
        let pool = if want { GOOD_STRINGS } else { BAD_STRINGS };
        let compiled = pattern.map(|source| Pattern::new(source).expect("a supported pattern"));
        pool.iter()
            .filter(|text| !want || text.chars().count() >= min_length)
            .filter(|text| {
                compiled
                    .as_ref()
                    .is_none_or(|pattern| pattern.is_match(text) == want)
            })
            .map(|text| (*text).to_owned())
            .collect()
    }

    /// The smallest document the shape accepts, taking the first of each choice.
    fn sample(&self, shape: &ShapeDef, depth: usize) -> Value {
        assert!(depth < 10, "a shape with no base case cannot be sampled");
        match &shape.kind {
            Kind::Any | Kind::Null => Value::Null,
            Kind::Bool => Value::Bool(true),
            Kind::ConstBool(flag) => Value::Bool(*flag),
            Kind::ConstString(text) => Value::String(text.clone()),
            Kind::Enum(options) => Value::String(options[0].clone()),
            Kind::String {
                min_length,
                pattern,
            } => Value::String(
                self.strings(min_length.unwrap_or(0), pattern.as_deref(), true)
                    .into_iter()
                    .next()
                    .expect("the pool holds a matching string"),
            ),
            Kind::Integer {
                min,
                exclusive_min,
                max,
            }
            | Kind::Number {
                min,
                exclusive_min,
                max,
            } => {
                let low = exclusive_min.map_or(min.unwrap_or(0.0), |above| {
                    min.unwrap_or(0.0).max(above + 1.0)
                });
                Value::Number(max.map_or(low, |most| low.min(most)))
            }
            Kind::Array {
                items, min_items, ..
            } => Value::Array(self.distinct(items, min_items.unwrap_or(0), depth)),
            Kind::Map {
                values,
                min_properties,
                key_pattern,
            } => {
                let keys = self.strings(1, key_pattern.as_deref(), true);
                Value::Object(
                    keys.into_iter()
                        .take(min_properties.unwrap_or(0))
                        .map(|key| (key, self.sample(values, depth)))
                        .collect(),
                )
            }
            Kind::Object(definition) => self.sample_object(definition, depth),
            Kind::OneOf(alternatives) => {
                let candidates: Vec<Value> = alternatives
                    .iter()
                    .map(|alternative| self.sample(alternative, depth))
                    .collect();
                candidates
                    .iter()
                    .find(|document| {
                        alternatives
                            .iter()
                            .filter(|alternative| accepts(self.definitions, alternative, document))
                            .count()
                            == 1
                    })
                    .unwrap_or(&candidates[0])
                    .clone()
            }
            Kind::Tagged { variants, .. } => self.sample(&variants[0].1, depth),
            Kind::Not(_) => Value::Null,
            Kind::AllOf(parts) => parts
                .iter()
                .map(|part| self.sample(part, depth))
                .reduce(|merged, next| match (merged, next) {
                    (Value::Object(mut left), Value::Object(right)) => {
                        left.extend(right);
                        Value::Object(left)
                    }
                    (merged, _) => merged,
                })
                .unwrap_or(Value::Null),
            Kind::Ref(name) => self.sample(
                self.definitions.get(name).expect("a defined name"),
                depth + 1,
            ),
        }
    }

    fn required_only(&self, definition: &ObjectDef, depth: usize) -> Value {
        Value::Object(
            definition
                .fields
                .iter()
                .filter(|field| field.required)
                .map(|field| (field.name.clone(), self.sample(&field.shape, depth)))
                .collect(),
        )
    }

    fn sample_object(&self, definition: &ObjectDef, depth: usize) -> Value {
        let mut document = self.required_only(definition, depth);
        for field in definition.fields.iter().filter(|field| !field.required) {
            if document.as_object().expect("an object").len()
                >= definition.min_properties.unwrap_or(0)
            {
                break;
            }
            document = set(&document, &field.name, self.sample(&field.shape, depth));
        }
        for keys in [&definition.any_of_keys, &definition.one_of_keys] {
            if !keys.is_empty() && keys.iter().all(|key| document.get(key).is_none()) {
                let field = definition
                    .fields
                    .iter()
                    .find(|field| field.name == keys[0])
                    .expect("a field");
                document = set(&document, &keys[0], self.sample(&field.shape, depth));
            }
        }
        document
    }

    /// `base` with `name` set to `value` and every field that setting it requires present too.
    fn place(
        &self,
        definition: &ObjectDef,
        base: &Value,
        name: &str,
        value: Value,
        depth: usize,
    ) -> Value {
        let mut document = set(base, name, value);
        if definition.one_of_keys.iter().any(|key| key == name) {
            for other in definition.one_of_keys.iter().filter(|key| *key != name) {
                document = without(&document, other);
            }
        }
        let mut pending = vec![name.to_owned()];
        while let Some(key) = pending.pop() {
            for (_, others) in definition
                .dependent_required
                .iter()
                .filter(|(entry, _)| *entry == key)
            {
                for other in others {
                    if document.get(other).is_none() {
                        let field = definition
                            .fields
                            .iter()
                            .find(|field| field.name == *other)
                            .expect("a field");
                        document = set(&document, other, self.sample(&field.shape, depth));
                        pending.push(other.clone());
                    }
                }
            }
        }
        document
    }

    /// `count` different documents the shape accepts, for a list that must not repeat.
    fn distinct(&self, shape: &ShapeDef, count: usize, depth: usize) -> Vec<Value> {
        if count == 0 {
            return Vec::new();
        }
        let resolved = self.resolve(shape);
        match &resolved.kind {
            Kind::Integer { min, .. } | Kind::Number { min, .. } => (0..count)
                .map(|offset| Value::Number(min.unwrap_or(0.0) + offset as f64))
                .collect(),
            Kind::Enum(options) => {
                assert!(
                    count <= options.len(),
                    "too few options for {count} distinct values"
                );
                options[..count]
                    .iter()
                    .map(|option| Value::String(option.clone()))
                    .collect()
            }
            Kind::String {
                min_length,
                pattern,
            } => {
                let strings = self.strings(min_length.unwrap_or(0), pattern.as_deref(), true);
                assert!(
                    count <= strings.len(),
                    "too few strings for {count} distinct values"
                );
                strings.into_iter().take(count).map(Value::String).collect()
            }
            _ => {
                assert!(
                    count == 1,
                    "no way to make {count} distinct documents of {resolved:?}"
                );
                vec![self.sample(shape, depth)]
            }
        }
    }

    /// Other documents the shape accepts: boundaries, every option, every optional field present.
    fn variants(&self, shape: &ShapeDef, depth: usize) -> Documents {
        let mut rows: Documents = Vec::new();
        match &shape.kind {
            Kind::Enum(options) => {
                for option in options {
                    rows.push((
                        format!("the option {option}"),
                        Value::String(option.clone()),
                    ));
                }
            }
            Kind::Integer {
                min,
                exclusive_min,
                max,
            }
            | Kind::Number {
                min,
                exclusive_min,
                max,
            } => {
                // A candidate is a variant only if every bound the shape holds allows it, worked out here from the bounds
                // and not asked of the validator.
                let whole = matches!(shape.kind, Kind::Integer { .. });
                let allowed = |candidate: f64| {
                    min.is_none_or(|low| candidate >= low)
                        && exclusive_min.is_none_or(|above| candidate > above)
                        && max.is_none_or(|high| candidate <= high)
                        && (!whole || candidate.fract() == 0.0)
                };
                let mut candidates: Vec<(&str, f64)> = Vec::new();
                if let Some(low) = min {
                    candidates.push(("at the minimum", *low));
                }
                if let Some(above) = exclusive_min {
                    candidates.push((
                        "just above the exclusive minimum",
                        above + if whole { 1.0 } else { 0.5 },
                    ));
                }
                if let Some(high) = max {
                    candidates.push(("at the maximum", *high));
                }
                for (label, candidate) in candidates {
                    if allowed(candidate) {
                        rows.push((label.to_owned(), Value::Number(candidate)));
                    }
                }
            }
            Kind::String {
                min_length: Some(length),
                pattern: None,
            } => {
                rows.push((
                    "at the minimum length".to_owned(),
                    Value::String("a".repeat(*length)),
                ));
            }
            Kind::Array {
                items,
                max_items,
                unique,
                ..
            } => {
                if let Some(most) = max_items {
                    let list = if *unique {
                        self.distinct(items, *most, depth)
                    } else {
                        vec![self.sample(items, depth); *most]
                    };
                    rows.push(("at the maximum item count".to_owned(), Value::Array(list)));
                }
                for (label, item) in self.variants(items, depth) {
                    rows.push((format!("item, {label}"), Value::Array(vec![item])));
                }
            }
            Kind::Map { values, .. } => {
                for (label, value) in self.variants(values, depth) {
                    rows.push((format!("value, {label}"), object(vec![("a.json", value)])));
                }
            }
            Kind::Object(definition) => {
                let base = self.sample_object(definition, depth);
                for field in &definition.fields {
                    rows.push((
                        format!("{} present", field.name),
                        self.place(
                            definition,
                            &base,
                            &field.name,
                            self.sample(&field.shape, depth),
                            depth,
                        ),
                    ));
                    for (label, value) in self.variants(&field.shape, depth) {
                        rows.push((
                            format!("{}, {label}", field.name),
                            self.place(definition, &base, &field.name, value, depth),
                        ));
                    }
                }
                for (key, others) in &definition.dependent_required {
                    let mut document = base.clone();
                    for name in std::iter::once(key).chain(others) {
                        let field = definition
                            .fields
                            .iter()
                            .find(|field| field.name == *name)
                            .expect("a field");
                        document = set(&document, name, self.sample(&field.shape, depth));
                    }
                    rows.push((format!("{key} with what it requires"), document));
                }
                if let Some(additional) = &definition.additional {
                    rows.push((
                        "an extra member".to_owned(),
                        set(&base, "zz_extra", self.sample(additional, depth)),
                    ));
                }
            }
            Kind::OneOf(alternatives) => {
                for (position, alternative) in alternatives.iter().enumerate() {
                    let document = self.sample(alternative, depth);
                    let matching = alternatives
                        .iter()
                        .filter(|other| accepts(self.definitions, other, &document))
                        .count();
                    if matching == 1 {
                        rows.push((format!("alternative {position}"), document));
                    }
                }
            }
            Kind::Tagged { variants, .. } => {
                for (name, variant) in variants {
                    rows.push((format!("variant {name}"), self.sample(variant, depth)));
                    for (label, document) in self.variants(variant, depth) {
                        rows.push((format!("{name}, {label}"), document));
                    }
                }
            }
            Kind::Ref(name) if depth < 2 => {
                rows = self.variants(
                    self.definitions.get(name).expect("a defined name"),
                    depth + 1,
                );
            }
            _ => {}
        }
        rows
    }

    /// Documents the shape refuses, one per constraint it holds.
    fn mutations(&self, shape: &ShapeDef, depth: usize) -> Documents {
        let mut rows: Documents = Vec::new();
        macro_rules! add {
            ($label:expr, $document:expr) => {
                rows.push((String::from($label), $document))
            };
        }
        let wrong_type = |text: &str| Value::String(text.to_owned());
        match &shape.kind {
            Kind::Any => {}
            Kind::Null => add!("not null", Value::Bool(true)),
            Kind::Bool => add!("not a boolean", wrong_type("x")),
            Kind::ConstBool(flag) => add!("the other boolean", Value::Bool(!flag)),
            Kind::ConstString(text) => {
                add!("a different string", Value::String(format!("{text}~")));
                add!("not a string", Value::Number(1.0));
            }
            Kind::Enum(_) => {
                add!("an unlisted value", wrong_type("~"));
                add!("not a string", Value::Number(1.0));
            }
            Kind::String {
                min_length,
                pattern,
            } => {
                add!("not a string", Value::Number(1.0));
                if let Some(length) = min_length.filter(|length| *length > 0) {
                    add!(
                        "below the minimum length",
                        Value::String("a".repeat(length - 1))
                    );
                }
                if let Some(source) = pattern {
                    let bad = self
                        .strings(0, Some(source), false)
                        .into_iter()
                        .next()
                        .expect("a refused string");
                    add!("outside the pattern", Value::String(bad));
                }
            }
            Kind::Integer {
                min,
                exclusive_min,
                max,
            }
            | Kind::Number {
                min,
                exclusive_min,
                max,
            } => {
                add!("not a number", wrong_type("x"));
                if matches!(shape.kind, Kind::Integer { .. }) {
                    add!("a fraction", Value::Number(0.5));
                }
                if let Some(low) = min {
                    add!("below the minimum", Value::Number(low - 1.0));
                }
                if let Some(above) = exclusive_min {
                    add!("at the exclusive minimum", Value::Number(*above));
                    add!("below the exclusive minimum", Value::Number(above - 1.0));
                }
                if let Some(high) = max {
                    add!("above the maximum", Value::Number(high + 1.0));
                }
            }
            Kind::Array {
                items,
                min_items,
                max_items,
                unique,
            } => {
                add!("not an array", wrong_type("x"));
                if let Some(least) = min_items.filter(|least| *least > 0) {
                    add!(
                        "below the minimum item count",
                        Value::Array(self.distinct(items, least - 1, depth))
                    );
                }
                if let Some(most) = max_items {
                    let list = if *unique {
                        self.distinct(items, most + 1, depth)
                    } else {
                        vec![self.sample(items, depth); most + 1]
                    };
                    add!("above the maximum item count", Value::Array(list));
                }
                if *unique {
                    let item = self.sample(items, depth);
                    add!("a repeated item", Value::Array(vec![item.clone(), item]));
                }
                let mut base = self.distinct(items, min_items.unwrap_or(0).max(1), depth);
                for (label, mutated) in self.mutations(items, depth) {
                    base[0] = mutated;
                    rows.push((format!("item, {label}"), Value::Array(base.clone())));
                }
            }
            Kind::Map {
                values,
                min_properties,
                key_pattern,
            } => {
                add!("not an object", Value::Number(1.0));
                let sample = self.sample(values, depth);
                if let Some(least) = min_properties.filter(|least| *least > 0) {
                    let keys = self.strings(1, key_pattern.as_deref(), true);
                    let pairs = keys
                        .into_iter()
                        .take(least - 1)
                        .map(|key| (key, sample.clone()))
                        .collect();
                    add!("below the minimum property count", Value::Object(pairs));
                }
                if let Some(source) = key_pattern {
                    let bad = self
                        .strings(0, Some(source), false)
                        .into_iter()
                        .next()
                        .expect("a refused key");
                    add!(
                        "a key outside the pattern",
                        Value::Object(vec![(bad, sample.clone())])
                    );
                }
                let good = self
                    .strings(1, key_pattern.as_deref(), true)
                    .into_iter()
                    .next()
                    .expect("a key");
                for (label, mutated) in self.mutations(values, depth) {
                    rows.push((
                        format!("value, {label}"),
                        Value::Object(vec![(good.clone(), mutated)]),
                    ));
                }
            }
            Kind::Object(definition) => {
                add!("not an object", Value::Number(1.0));
                add!("an array", Value::Array(Vec::new()));
                let base = self.sample_object(definition, depth);
                for field in definition.fields.iter().filter(|field| field.required) {
                    add!(
                        &format!("{} missing", field.name),
                        without(&base, &field.name)
                    );
                }
                for field in &definition.fields {
                    for (label, mutated) in self.mutations(&field.shape, depth) {
                        rows.push((
                            format!("{}, {label}", field.name),
                            self.place(definition, &base, &field.name, mutated, depth),
                        ));
                    }
                }
                if definition.closed {
                    add!(
                        "an unknown property",
                        set(&base, "zz_unknown", Value::Number(0.0))
                    );
                }
                if let Some(additional) = &definition.additional {
                    for (label, mutated) in self.mutations(additional, depth) {
                        rows.push((
                            format!("an extra member, {label}"),
                            set(&base, "zz_extra", mutated),
                        ));
                    }
                }
                for keys in [&definition.any_of_keys, &definition.one_of_keys] {
                    if !keys.is_empty() {
                        let mut bare = base.clone();
                        for key in keys {
                            bare = without(&bare, key);
                        }
                        add!("none of the grouped keys", bare);
                    }
                }
                if definition.one_of_keys.len() > 1 {
                    let mut both = base.clone();
                    for key in &definition.one_of_keys {
                        let field = definition
                            .fields
                            .iter()
                            .find(|field| field.name == *key)
                            .expect("a field");
                        both = set(&both, key, self.sample(&field.shape, depth));
                    }
                    add!("more than one of the exclusive keys", both);
                }
                for (key, others) in &definition.dependent_required {
                    let field = definition
                        .fields
                        .iter()
                        .find(|field| field.name == *key)
                        .expect("a field");
                    let with_key = set(&base, key, self.sample(&field.shape, depth));
                    for other in others {
                        add!(&format!("{key} without {other}"), without(&with_key, other));
                    }
                }
                if let Some(least) = definition.min_properties {
                    let sparse = self.required_only(definition, depth);
                    if sparse.as_object().expect("an object").len() < least {
                        add!("below the minimum property count", sparse);
                    }
                }
            }
            Kind::OneOf(alternatives) => {
                let foreign = [
                    Value::Bool(true),
                    Value::Array(Vec::new()),
                    object(vec![("zz", Value::Number(0.0))]),
                    Value::Number(-1.5),
                    Value::String("zz~".to_owned()),
                    Value::Null,
                ];
                if let Some(document) = foreign.into_iter().find(|document| {
                    !alternatives
                        .iter()
                        .any(|alternative| accepts(self.definitions, alternative, document))
                }) {
                    add!("a value no alternative accepts", document);
                }
            }
            Kind::Tagged { tag, variants } => {
                add!("not an object", Value::Number(1.0));
                add!("an unknown kind", object(vec![(tag, wrong_type("~"))]));
                add!(
                    "a kind that is not a string",
                    object(vec![(tag, Value::Number(1.0))])
                );
                add!("no kind", object(Vec::new()));
                for (name, variant) in variants {
                    for (label, document) in self.mutations(variant, depth) {
                        rows.push((format!("{name}, {label}"), document));
                    }
                }
            }
            Kind::Ref(name) if depth < 2 => {
                rows = self.mutations(
                    self.definitions.get(name).expect("a defined name"),
                    depth + 1,
                );
            }
            Kind::Not(_) | Kind::AllOf(_) | Kind::Ref(_) => {}
        }
        rows
    }

    fn rows_for(&self, root: &str) -> Vec<Row> {
        let shape = ShapeDef::new(Kind::Ref(root.to_owned()));
        let mut rows = vec![("minimal".to_owned(), self.sample(&shape, 0), true)];
        rows.extend(
            self.variants(&shape, 0)
                .into_iter()
                .map(|(label, document)| (label, document, true)),
        );
        rows.extend(
            self.mutations(&shape, 0)
                .into_iter()
                .map(|(label, document)| (label, document, false)),
        );
        let mut seen = BTreeSet::new();
        rows.into_iter()
            .filter(|(_, document, valid)| seen.insert((document.canonical(), *valid)))
            .map(|(case, document, valid)| Row {
                root: root.to_owned(),
                case,
                valid,
                document,
            })
            .collect()
    }
}

fn generated_rows() -> Vec<Row> {
    let definitions = definitions();
    let generator = Generator {
        definitions: &definitions,
    };
    TYPES
        .iter()
        .flat_map(|root| generator.rows_for(root))
        .collect()
}

/// The table as the repository's formatter writes a corpus JSON file (`json-stringify`: sorted keys, one element per
/// line), so the root lint's `--fix` leaves the committed file as it is and the comparison below does not depend on
/// whether lint ran first.
fn generated_text(rows: &[Row]) -> String {
    let entries: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            serde_json::json!({
                "type": row.root,
                "case": row.case,
                "valid": row.valid,
                "document": serde_json::to_value(&row.document).expect("JSON"),
            })
        })
        .collect();
    serde_json::to_string_pretty(&entries).expect("JSON") + "\n"
}

fn read_json(name: &str) -> serde_json::Value {
    serde_json::from_str(
        &fs::read_to_string(fixtures().join(name))
            .unwrap_or_else(|error| panic!("{name}: {error}")),
    )
    .unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn update_requested() -> bool {
    std::env::var_os("UPDATE_SHAPE_FIXTURES").is_some()
}

#[test]
fn the_committed_schemas_are_what_the_types_emit() {
    for (name, draft) in [
        ("schema.json", Draft::Draft2020_12),
        ("schema-draft-07.json", Draft::Draft07),
    ] {
        let emitted = emitted_schema(draft);
        if update_requested() {
            let text = serde_json::to_string_pretty(&emitted).expect("JSON") + "\n";
            fs::write(fixtures().join(name), text).expect("the fixture is writable");
        }
        assert!(
            read_json(name) == emitted,
            "{name} differs from what the types emit; UPDATE_SHAPE_FIXTURES=1 rewrites it"
        );
    }
}

#[test]
fn the_generated_table_is_what_the_descriptors_produce() {
    let rows = generated_rows();
    let text = generated_text(&rows);
    if update_requested() {
        fs::write(fixtures().join("generated.json"), &text).expect("the fixture is writable");
    }
    let committed =
        fs::read_to_string(fixtures().join("generated.json")).expect("the generated table exists");
    assert!(
        committed == text,
        "generated.json differs from what the descriptors produce; UPDATE_SHAPE_FIXTURES=1 rewrites it"
    );
}

#[test]
fn the_validator_agrees_with_every_generated_document() {
    let mut disagreements = Vec::new();
    for row in generated_rows() {
        let verdict = derived_verdict(&row.root, &row.document);
        if verdict != row.valid {
            disagreements.push(format!(
                "{}: {}: built to be {}, the validator says {verdict}: {}",
                row.root, row.case, row.valid, row.document
            ));
        }
    }
    assert!(disagreements.is_empty(), "{}", disagreements.join("\n"));
}

#[test]
fn every_kind_and_constraint_has_generated_rows() {
    let rows = generated_rows();
    for root in TYPES {
        for verdict in [true, false] {
            assert!(
                rows.iter()
                    .any(|row| row.root == *root && row.valid == verdict),
                "{root} needs a generated document with the verdict {verdict}"
            );
        }
    }
    let cases: String = rows.iter().map(|row| format!("{}\n", row.case)).collect();
    for needed in [
        "below the minimum length",
        "outside the pattern",
        "above the maximum",
        "below the minimum item count",
        "above the maximum item count",
        "a repeated item",
        "an unknown property",
        "without",
        "an unknown kind",
        "a key outside the pattern",
        "below the minimum property count",
        "a value no alternative accepts",
        "an unlisted value",
    ] {
        assert!(
            cases.contains(needed),
            "no generated row is named {needed:?}"
        );
    }
}

#[test]
fn the_validator_agrees_with_every_document_in_the_hand_table() {
    let table = read_json("documents.json");
    let table = table.as_array().expect("a list");
    assert!(table.len() > 100, "the hand table must stay broad");
    let mut disagreements = Vec::new();
    for entry in table {
        let name = entry["type"].as_str().expect("a type");
        let case = entry["case"].as_str().expect("a case");
        let expected = entry["valid"].as_bool().expect("a verdict");
        let text = match entry.get("text") {
            Some(text) => text.as_str().expect("text is a string").to_owned(),
            None => entry["document"].to_string(),
        };
        // A document that is not JSON is refused, which is how a loader meets `1e999`.
        let verdict = serde_json::from_str::<Value>(&text)
            .map(|value| derived_verdict(name, &value))
            .unwrap_or(false);
        if verdict != expected {
            disagreements.push(format!(
                "{name}: {case}: the validator says {verdict}, the table says {expected}"
            ));
        }
    }
    assert!(disagreements.is_empty(), "{}", disagreements.join("\n"));
}

#[test]
fn every_type_in_the_hand_table_has_valid_and_invalid_documents() {
    let table = read_json("documents.json");
    let table = table.as_array().expect("a list");
    let mut names: Vec<&str> = table
        .iter()
        .filter_map(|entry| entry["type"].as_str())
        .collect();
    names.sort_unstable();
    names.dedup();
    let mut expected = TYPES.to_vec();
    expected.sort_unstable();
    assert_eq!(names, expected);
    for name in names {
        for verdict in [true, false] {
            assert!(
                table
                    .iter()
                    .any(|entry| entry["type"] == name && entry["valid"] == verdict),
                "{name} needs a document with the verdict {verdict}"
            );
        }
    }
}
