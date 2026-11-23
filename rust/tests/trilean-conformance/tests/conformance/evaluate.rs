//! Runs the `evaluate` cases against the native evaluator, with resolvers and functions built from each case's data
//! by the rules `conformance/README.md` gives and the TypeScript runner (`run-evaluate.ts`, `resolver-data.ts`)
//! applies: the first entry whose key (and context) equals the call answers it, a call nothing matches gets
//! `default`, a collection nothing matches is empty, and the delegate and tree resolvers exist only when the data
//! lists any.
//!
//! The native evaluator is synchronous, so a case runs in the `sync` mode, which is also what the `compiled` mode
//! computes. A case whose `modes` name neither is the asynchronous evaluator's alone and has no native executor.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use trilean_eval::evaluate::{
    Evaluation, EvaluationError, Evaluator, FunctionFailure, Functions, Resolution, SyncResolvers,
    TreeResolution,
};
use trilean_eval::{ComputedValue, DurationUnit, IndeterminateCode, JsonValue, Unit};
use trilean_json_shape::Value as Json;

type Check<T> = Result<T, String>;

/// Whether the native evaluator executes the case: every case except one meant for the asynchronous evaluator alone.
pub fn executes(case: &Value) -> bool {
    case.get("modes")
        .and_then(Value::as_array)
        .is_none_or(|modes| {
            modes
                .iter()
                .any(|mode| matches!(mode.as_str(), Some("sync" | "compiled")))
        })
}

/// A corpus value with every `{ "$number": ... }` replaced by the number it names, NaN and the infinities included,
/// since a native evaluator can be handed any double.
pub fn decode_numbers(value: &Value) -> Check<Json> {
    Ok(match value {
        Value::Null => Json::Null,
        Value::Bool(flag) => Json::Bool(*flag),
        Value::Number(number) => Json::Number(
            number
                .as_f64()
                .ok_or_else(|| format!("the number {number} is not a double"))?,
        ),
        Value::String(text) => Json::String(text.clone()),
        Value::Array(items) => Json::Array(items.iter().map(decode_numbers).collect::<Check<_>>()?),
        Value::Object(members) => {
            if members.len() == 1
                && let Some(Value::String(name)) = members.get("$number")
            {
                return Ok(Json::Number(match name.as_str() {
                    "-0" => -0.0,
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    "NaN" => f64::NAN,
                    other => {
                        return Err(format!(
                            "$number names {other}, which is not a number a corpus file names"
                        ));
                    }
                }));
            }
            Json::Object(
                members
                    .iter()
                    .map(|(key, item)| Ok((key.clone(), decode_numbers(item)?)))
                    .collect::<Check<_>>()?,
            )
        }
    })
}

/// How far a number may be from the expected one.
#[derive(Clone, Copy, Default)]
struct Tolerance {
    ulps: Option<f64>,
    absolute: Option<f64>,
}

/// The position of a finite double among all finite doubles, both zeros being one point.
fn ordered_bits(value: f64) -> i128 {
    let bits = value.to_bits();
    let magnitude = i128::from(bits & !(1_u64 << 63));
    if bits >> 63 == 1 {
        -magnitude
    } else {
        magnitude
    }
}

fn same_double(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

fn within_tolerance(actual: f64, expected: f64, tolerance: Tolerance) -> bool {
    if same_double(actual, expected) {
        return true;
    }
    if tolerance.ulps.is_none() && tolerance.absolute.is_none() {
        return false;
    }
    if !expected.is_finite() || !actual.is_finite() {
        return false;
    }
    if actual == expected {
        return true;
    }
    if let Some(absolute) = tolerance.absolute {
        return (actual - expected).abs() < absolute;
    }
    let distance = (ordered_bits(actual) - ordered_bits(expected)).unsigned_abs();
    #[allow(
        clippy::cast_precision_loss,
        reason = "a distance is compared with a small count"
    )]
    let distance = distance as f64;
    distance <= tolerance.ulps.unwrap_or(0.0)
}

/// `jsonEquals`: numbers are the same double (or within the tolerance), objects equal regardless of key order.
fn json_equals(actual: &Json, expected: &Json, tolerance: Tolerance) -> bool {
    match (actual, expected) {
        (Json::Number(a), Json::Number(b)) => within_tolerance(*a, *b, tolerance),
        (Json::Array(a), Json::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| json_equals(x, y, tolerance))
        }
        (Json::Object(a), Json::Object(b)) => {
            a.len() == b.len()
                && b.iter().all(|(key, y)| {
                    a.iter()
                        .find(|(name, _)| name == key)
                        .is_some_and(|(_, x)| json_equals(x, y, tolerance))
                })
        }
        (Json::Null, Json::Null) => true,
        (Json::Bool(a), Json::Bool(b)) => a == b,
        (Json::String(a), Json::String(b)) => a == b,
        _ => false,
    }
}

fn exact(actual: &Json, expected: &Json) -> bool {
    json_equals(actual, expected, Tolerance::default())
}

fn unit_json(unit: &Unit) -> Json {
    Json::Object(
        unit.0
            .iter()
            .map(|(dimension, exponent)| (dimension.clone(), Json::Number(*exponent)))
            .collect(),
    )
}

fn duration_unit_name(unit: DurationUnit) -> &'static str {
    match unit {
        DurationUnit::Ms => "ms",
        DurationUnit::S => "s",
        DurationUnit::Min => "min",
        DurationUnit::H => "h",
        DurationUnit::D => "d",
    }
}

/// A computed value as the corpus writes one, an absent unit left out.
fn computed_json(value: &ComputedValue) -> Json {
    let mut members = Vec::new();
    let unit = |members: &mut Vec<(String, Json)>, unit: &Option<Unit>| {
        if let Some(unit) = unit {
            members.push(("unit".to_owned(), unit_json(unit)));
        }
    };
    let text = |value: &str| Json::String(value.to_owned());
    match value {
        ComputedValue::Number { value, unit: u } => {
            members.push(("kind".to_owned(), text("number")));
            members.push(("value".to_owned(), Json::Number(*value)));
            unit(&mut members, u);
        }
        ComputedValue::Text { value } => {
            members.push(("kind".to_owned(), text("text")));
            members.push(("value".to_owned(), text(value)));
        }
        ComputedValue::Boolean { value } => {
            members.push(("kind".to_owned(), text("boolean")));
            members.push(("value".to_owned(), Json::Bool(*value)));
        }
        ComputedValue::Instant { value } => {
            members.push(("kind".to_owned(), text("instant")));
            members.push(("value".to_owned(), text(value)));
        }
        ComputedValue::Duration { value, unit } => {
            members.push(("kind".to_owned(), text("duration")));
            members.push(("value".to_owned(), Json::Number(*value)));
            members.push(("unit".to_owned(), text(duration_unit_name(*unit))));
        }
        ComputedValue::Complex { re, im, unit: u } => {
            members.push(("kind".to_owned(), text("complex")));
            members.push(("re".to_owned(), Json::Number(*re)));
            members.push(("im".to_owned(), Json::Number(*im)));
            unit(&mut members, u);
        }
        ComputedValue::List { items } => {
            members.push(("kind".to_owned(), text("list")));
            members.push((
                "items".to_owned(),
                Json::Array(items.iter().map(computed_json).collect()),
            ));
        }
        ComputedValue::Matrix {
            rows,
            imaginary,
            unit: u,
        } => {
            let grid = |grid: &Vec<Vec<f64>>| {
                Json::Array(
                    grid.iter()
                        .map(|row| Json::Array(row.iter().copied().map(Json::Number).collect()))
                        .collect(),
                )
            };
            members.push(("kind".to_owned(), text("matrix")));
            members.push(("rows".to_owned(), grid(rows)));
            if let Some(imaginary) = imaginary {
                members.push(("imaginary".to_owned(), grid(imaginary)));
            }
            unit(&mut members, u);
        }
    }
    Json::Object(members)
}

fn number_at(value: &Json, key: &str) -> Check<f64> {
    value
        .get(key)
        .and_then(Json::as_f64)
        .ok_or_else(|| format!("{value} has no number {key}"))
}

/// A grid of numbers: an array of rows, each an array of numbers.
fn grid_at(value: &Json, key: &str) -> Check<Vec<Vec<f64>>> {
    value
        .get(key)
        .and_then(Json::as_array)
        .ok_or_else(|| format!("{value} has no grid {key}"))?
        .iter()
        .map(|row| {
            row.as_array()
                .ok_or_else(|| format!("the row {row} of {key} is not an array"))?
                .iter()
                .map(|cell| {
                    cell.as_f64()
                        .ok_or_else(|| format!("the cell {cell} of {key} is not a number"))
                })
                .collect::<Check<Vec<f64>>>()
        })
        .collect()
}

fn text_at(value: &Json, key: &str) -> Check<String> {
    value
        .get(key)
        .and_then(Json::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{value} has no text {key}"))
}

fn unit_at(value: &Json) -> Check<Option<Unit>> {
    let Some(unit) = value.get("unit") else {
        return Ok(None);
    };
    let pairs = unit
        .as_object()
        .ok_or_else(|| format!("the unit {unit} is not an object"))?;
    Ok(Some(trilean_json_shape::Map(
        pairs
            .iter()
            .map(|(dimension, exponent)| {
                exponent
                    .as_f64()
                    .map(|exponent| (dimension.clone(), exponent))
                    .ok_or_else(|| format!("the exponent {exponent} is not a number"))
            })
            .collect::<Check<_>>()?,
    )))
}

/// The computed value a corpus value denotes, not run through the schema: a resolver's answer is read unvalidated, so
/// a case may hand the evaluator a value the schema refuses, such as a non-finite number.
fn to_computed(value: &Json) -> Check<ComputedValue> {
    Ok(match text_at(value, "kind")?.as_str() {
        "number" => ComputedValue::Number {
            value: number_at(value, "value")?,
            unit: unit_at(value)?,
        },
        "text" => ComputedValue::Text {
            value: text_at(value, "value")?,
        },
        "boolean" => ComputedValue::Boolean {
            value: value
                .get("value")
                .and_then(Json::as_bool)
                .ok_or_else(|| format!("{value} has no boolean value"))?,
        },
        "instant" => ComputedValue::Instant {
            value: text_at(value, "value")?,
        },
        "duration" => ComputedValue::Duration {
            value: number_at(value, "value")?,
            unit: match text_at(value, "unit")?.as_str() {
                "ms" => DurationUnit::Ms,
                "s" => DurationUnit::S,
                "min" => DurationUnit::Min,
                "h" => DurationUnit::H,
                "d" => DurationUnit::D,
                other => return Err(format!("{other} is not a duration unit")),
            },
        },
        "complex" => ComputedValue::Complex {
            re: number_at(value, "re")?,
            im: number_at(value, "im")?,
            unit: unit_at(value)?,
        },
        "matrix" => ComputedValue::Matrix {
            rows: grid_at(value, "rows")?,
            imaginary: if value.get("imaginary").is_some() {
                Some(grid_at(value, "imaginary")?)
            } else {
                None
            },
            unit: unit_at(value)?,
        },
        "list" => ComputedValue::List {
            items: value
                .get("items")
                .and_then(Json::as_array)
                .ok_or_else(|| format!("{value} has no list items"))?
                .iter()
                .map(to_computed)
                .collect::<Check<_>>()?,
        },
        other => return Err(format!("{other} is not a computed value kind")),
    })
}

/// One resolver call as the evaluator made it.
struct Call {
    resolver: &'static str,
    field: Option<(&'static str, Json)>,
}

/// The resolvers a case's `resolvers` data describes, with the log of the calls made.
struct CaseResolvers {
    data: Json,
    calls: RefCell<Vec<Call>>,
}

fn entries<'a>(data: &'a Json, list: &str) -> &'a [Json] {
    data.get(list).and_then(Json::as_array).unwrap_or(&[])
}

/// Whether an entry's `context` matches the context of the call. A case without a `context` evaluates with none,
/// which only an entry without one or with `*` matches: an absent context is not a null one.
fn matches_context(wanted: Option<&Json>, actual: Option<&Json>) -> bool {
    match wanted {
        None => true,
        Some(Json::String(star)) if star == "*" => true,
        Some(wanted) => actual.is_some_and(|actual| exact(actual, wanted)),
    }
}

impl CaseResolvers {
    fn record(&self, resolver: &'static str, field: &'static str, value: Json) {
        self.calls.borrow_mut().push(Call {
            resolver,
            field: Some((field, value)),
        });
    }

    /// A resolution as the data writes it, or the failure the data says the resolver throws.
    fn settle(result: &Json) -> Result<Resolution, String> {
        if let Some(message) = result.get("throws").and_then(Json::as_str) {
            return Err(message.to_owned());
        }
        if result.get("found").and_then(Json::as_bool) == Some(true) {
            let value = result.get("value").ok_or("a found result has no value")?;
            return to_computed(value).map(Resolution::Found);
        }
        Ok(Resolution::Absent {
            not_yet_known: result.get("notYetKnown").and_then(Json::as_bool) == Some(true),
        })
    }

    fn fallback(&self) -> Result<Resolution, String> {
        match self.data.get("default") {
            Some(result) => Self::settle(result),
            None => Ok(Resolution::Absent {
                not_yet_known: false,
            }),
        }
    }

    /// The value `fromContext` reads: the context's own member named by a text key, as a boolean, number or text.
    fn from_context(key: &Json, context: Option<&Json>) -> Option<Resolution> {
        let value = context?.get(key.as_str()?)?;
        Some(Resolution::Found(match value {
            Json::Bool(value) => ComputedValue::Boolean { value: *value },
            Json::Number(value) => ComputedValue::Number {
                value: *value,
                unit: None,
            },
            Json::String(value) => ComputedValue::Text {
                value: value.clone(),
            },
            _ => return None,
        }))
    }
}

impl SyncResolvers<Option<Json>> for CaseResolvers {
    type Error = String;

    fn resolve_value(&self, key: &JsonValue, context: &Option<Json>) -> Result<Resolution, String> {
        self.record("value", "key", key.0.clone());
        let entry = entries(&self.data, "values").iter().find(|item| {
            item.get("key").is_some_and(|wanted| exact(&key.0, wanted))
                && matches_context(item.get("context"), context.as_ref())
        });
        match entry {
            Some(entry) => Self::settle(entry.get("result").ok_or("an entry has no result")?),
            None => {
                if self.data.get("fromContext").and_then(Json::as_bool) == Some(true)
                    && let Some(read) = Self::from_context(&key.0, context.as_ref())
                {
                    return Ok(read);
                }
                self.fallback()
            }
        }
    }

    fn resolve_lookup(
        &self,
        table: &JsonValue,
        keys: &[ComputedValue],
        context: &Option<Json>,
    ) -> Result<Resolution, String> {
        self.record("lookup", "table", table.0.clone());
        let keys = Json::Array(keys.iter().map(computed_json).collect());
        let entry = entries(&self.data, "lookups").iter().find(|item| {
            item.get("table")
                .is_some_and(|wanted| exact(&table.0, wanted))
                && item.get("keys").is_some_and(|wanted| exact(&keys, wanted))
                && matches_context(item.get("context"), context.as_ref())
        });
        match entry {
            Some(entry) => Self::settle(entry.get("result").ok_or("an entry has no result")?),
            None => self.fallback(),
        }
    }

    fn resolve_collection(
        &self,
        collection: &JsonValue,
        context: &Option<Json>,
    ) -> Result<Vec<Option<Json>>, String> {
        self.record("collection", "collection", collection.0.clone());
        let entry = entries(&self.data, "collections").iter().find(|item| {
            item.get("collection")
                .is_some_and(|wanted| exact(&collection.0, wanted))
                && matches_context(item.get("context"), context.as_ref())
        });
        Ok(entry
            .and_then(|entry| entry.get("items"))
            .and_then(Json::as_array)
            .map(|items| items.iter().cloned().map(Some).collect())
            .unwrap_or_default())
    }

    fn resolve_delegate(
        &self,
        system: &str,
        payload: &JsonValue,
        context: &Option<Json>,
    ) -> Option<Result<Resolution, String>> {
        self.data.get("delegates")?;
        self.record("delegate", "system", Json::String(system.to_owned()));
        let entry = entries(&self.data, "delegates").iter().find(|item| {
            item.get("system").and_then(Json::as_str) == Some(system)
                && item
                    .get("payload")
                    .is_some_and(|wanted| exact(&payload.0, wanted))
                && matches_context(item.get("context"), context.as_ref())
        });
        Some(match entry {
            Some(entry) => entry
                .get("result")
                .ok_or_else(|| "an entry has no result".to_owned())
                .and_then(Self::settle),
            None => self.fallback(),
        })
    }

    fn resolves_trees(&self) -> bool {
        self.data.get("trees").is_some()
    }

    fn resolve_tree(&self, key: &JsonValue, _: &Option<Json>) -> Result<TreeResolution, String> {
        self.record("tree", "key", key.0.clone());
        let entry = entries(&self.data, "trees")
            .iter()
            .find(|item| item.get("key").is_some_and(|wanted| exact(&key.0, wanted)));
        let Some(result) = entry.and_then(|entry| entry.get("result")) else {
            return Ok(TreeResolution::Absent {
                not_yet_known: false,
            });
        };
        if result.get("found").and_then(Json::as_bool) == Some(true) {
            return Ok(TreeResolution::Found(
                result
                    .get("node")
                    .cloned()
                    .ok_or("a found tree has no node")?,
            ));
        }
        Ok(TreeResolution::Absent {
            not_yet_known: result.get("notYetKnown").and_then(Json::as_bool) == Some(true),
        })
    }
}

/// The functions a case's `evaluator.functions.table` lists: each answers a call whose arguments equal an entry's,
/// and a call no entry answers is a failure of the case.
struct TableFunctions {
    table: BTreeMap<String, Vec<(Json, Json)>>,
}

impl Functions for TableFunctions {
    type Error = String;

    fn call(
        &self,
        name: &str,
        args: &[ComputedValue],
    ) -> Option<Result<Result<ComputedValue, FunctionFailure>, String>> {
        let entries = self.table.get(name)?;
        let args = Json::Array(args.iter().map(computed_json).collect());
        let Some((_, result)) = entries.iter().find(|(wanted, _)| exact(&args, wanted)) else {
            return Some(Err(format!(
                "function table for {name} has no entry for {args}"
            )));
        };
        if let Some(message) = result.get("domainError").and_then(Json::as_str) {
            return Some(Ok(Err(FunctionFailure::DomainError(message.to_owned()))));
        }
        if let Some(message) = result.get("wrongType").and_then(Json::as_str) {
            return Some(Ok(Err(FunctionFailure::WrongType(message.to_owned()))));
        }
        // An answer that is a value is read through the schema, as the TypeScript runner reads it.
        Some(
            match trilean_eval::schemas::read("ComputedValueSchema", result) {
                Some(Ok(value)) => to_computed(&value).map(Ok),
                _ => Err(format!(
                    "the function table's answer {result} is not a computed value"
                )),
            },
        )
    }
}

fn table_of(case: &Value) -> Check<TableFunctions> {
    let mut table = BTreeMap::new();
    if let Some(functions) = case
        .pointer("/evaluator/functions/table")
        .and_then(Value::as_object)
    {
        for (name, list) in functions {
            let mut entries = Vec::new();
            for entry in list.as_array().map_or(&[][..], Vec::as_slice) {
                entries.push((
                    decode_numbers(&entry["args"])?,
                    decode_numbers(&entry["result"])?,
                ));
            }
            table.insert(name.clone(), entries);
        }
    }
    Ok(TableFunctions { table })
}

fn limit(case: &Value, name: &str, default: usize) -> Check<usize> {
    match case.pointer(&format!("/evaluator/{name}")) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| format!("{name} {value} is not a count")),
    }
}

fn code_name(code: IndeterminateCode) -> &'static str {
    match code {
        IndeterminateCode::NotFound => "not-found",
        IndeterminateCode::NotYetKnown => "not-yet-known",
        IndeterminateCode::WrongType => "wrong-type",
        IndeterminateCode::DomainError => "domain-error",
    }
}

/// Whether every fragment occurs in `text`, each after the end of the one before.
fn includes_in_order(text: &str, fragments: &[String]) -> bool {
    let mut from = 0;
    for fragment in fragments {
        match text[from..].find(fragment.as_str()) {
            Some(at) => from += at + fragment.len(),
            None => return false,
        }
    }
    true
}

fn check_expectation(case: &Value, outcome: &Evaluation<Json>) -> Check<()> {
    let wanted = &case["expect"];
    let tolerance = Tolerance {
        ulps: case.pointer("/tolerance/ulps").and_then(Value::as_f64),
        absolute: case.pointer("/tolerance/absolute").and_then(Value::as_f64),
    };
    match (wanted["status"].as_str(), outcome) {
        (Some("definite"), Evaluation::Definite(value)) => match wanted.get("value") {
            Some(expected) if !json_equals(value, &decode_numbers(expected)?, tolerance) => {
                Err(format!("{value} is not {expected}"))
            }
            _ => Ok(()),
        },
        (Some("indeterminate"), Evaluation::Indeterminate(reason)) => {
            if let Some(code) = wanted.get("code").and_then(Value::as_str)
                && code != code_name(reason.code)
            {
                return Err(format!(
                    "the code is {}, expected {code}: {}",
                    code_name(reason.code),
                    reason.message
                ));
            }
            let fold = |text: &str| {
                if wanted.get("ignoreCase").and_then(Value::as_bool) == Some(true) {
                    text.to_ascii_lowercase()
                } else {
                    text.to_owned()
                }
            };
            if let Some(message) = wanted.get("message").and_then(Value::as_str)
                && fold(&reason.message) != fold(message)
            {
                return Err(format!(
                    "the message is {:?}, expected {message:?}",
                    reason.message
                ));
            }
            if let Some(fragments) = wanted.get("messageIncludes").and_then(Value::as_array) {
                let fragments: Vec<String> = fragments
                    .iter()
                    .filter_map(Value::as_str)
                    .map(&fold)
                    .collect();
                if !includes_in_order(&fold(&reason.message), &fragments) {
                    return Err(format!(
                        "the message {:?} lacks, in order, {fragments:?}",
                        reason.message
                    ));
                }
            }
            Ok(())
        }
        (status, Evaluation::Definite(value)) => {
            Err(format!("definite {value}, expected {status:?}"))
        }
        (status, Evaluation::Indeterminate(reason)) => Err(format!(
            "indeterminate {} ({}), expected {status:?}",
            code_name(reason.code),
            reason.message
        )),
    }
}

fn check_calls(case: &Value, calls: &[Call]) -> Check<()> {
    let Some(wanted) = case.get("expectCalls").and_then(Value::as_array) else {
        return Ok(());
    };
    let made: Vec<String> = calls
        .iter()
        .map(|call| match &call.field {
            Some((field, value)) => format!("{} {field} {value}", call.resolver),
            None => call.resolver.to_owned(),
        })
        .collect();
    if calls.len() != wanted.len() {
        return Err(format!(
            "{} resolver calls, expected {}: {made:?}",
            calls.len(),
            wanted.len()
        ));
    }
    for (position, (call, expected)) in calls.iter().zip(wanted).enumerate() {
        if expected["resolver"].as_str() != Some(call.resolver) {
            return Err(format!("call {position} is not {expected}: {made:?}"));
        }
        for field in ["key", "table", "collection", "system"] {
            if let Some(value) = expected.get(field) {
                let matches = call.field.as_ref().is_some_and(|(name, made)| {
                    *name == field && decode_numbers(value).is_ok_and(|value| exact(made, &value))
                });
                if !matches {
                    return Err(format!("call {position} {field} is not {value}: {made:?}"));
                }
            }
        }
    }
    Ok(())
}

/// The strings a tree holds under `kind`, `op` and `hitPolicy`, and under `unit` where it is a text, which is how
/// the corpus is checked to exercise every node kind and operator the schema defines.
pub fn collect_tags(value: &Value, tags: &mut BTreeSet<(String, String)>) {
    match value {
        Value::Object(members) => {
            for (key, item) in members {
                if matches!(key.as_str(), "kind" | "op" | "hitPolicy" | "unit")
                    && let Some(text) = item.as_str()
                {
                    tags.insert((key.clone(), text.to_owned()));
                }
                collect_tags(item, tags);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_tags(item, tags);
            }
        }
        _ => {}
    }
}

/// Runs one `evaluate` case.
pub fn run_case(case: &Value) -> Check<()> {
    let tree = decode_numbers(&case["tree"])?;
    let context = case.get("context").map(decode_numbers).transpose()?;
    let resolvers = CaseResolvers {
        data: decode_numbers(&case["resolvers"])?,
        calls: RefCell::new(Vec::new()),
    };
    let evaluator = Evaluator::new()
        .with_functions(table_of(case)?)
        .with_limits(
            limit(
                case,
                "maxNodes",
                trilean_eval::evaluate::DEFAULT_MAX_EVALUATION_NODES,
            )?,
            limit(
                case,
                "maxNestingDepth",
                trilean_eval::evaluate::DEFAULT_MAX_NESTING_DEPTH,
            )?,
        )
        .map_err(|error| error.to_string())?;
    let evaluator = evaluator
        .with_max_value_entries(limit(
            case,
            "maxValueEntries",
            trilean_eval::evaluate::DEFAULT_MAX_VALUE_ENTRIES,
        )?)
        .map_err(|error| error.to_string())?;
    let outcome = if case["as"].as_str() == Some("predicate") {
        let tree = trilean_eval::schemas::read_predicate(&tree)
            .map_err(|issues| format!("the tree is not a predicate: {issues:?}"))?;
        evaluator
            .evaluate_predicate(&tree, &context, &resolvers)
            .map(|evaluation| match evaluation {
                Evaluation::Definite(value) => Evaluation::Definite(Json::Bool(value)),
                Evaluation::Indeterminate(reason) => Evaluation::Indeterminate(reason),
            })
    } else {
        let tree = trilean_eval::schemas::read_expression(&tree)
            .map_err(|issues| format!("the tree is not an expression: {issues:?}"))?;
        evaluator
            .evaluate_value(&tree, &context, &resolvers)
            .map(|evaluation| match evaluation {
                Evaluation::Definite(value) => Evaluation::Definite(computed_json(&value)),
                Evaluation::Indeterminate(reason) => Evaluation::Indeterminate(reason),
            })
    };
    match (
        outcome,
        case.pointer("/expect/throws/message")
            .and_then(Value::as_str),
    ) {
        (
            Err(EvaluationError::Resolver(message) | EvaluationError::Function(message)),
            Some(wanted),
        ) => {
            if !message.contains(wanted) {
                return Err(format!("threw {message:?}, expected {wanted:?}"));
            }
        }
        (Err(EvaluationError::Resolver(message) | EvaluationError::Function(message)), None) => {
            return Err(format!("the evaluation failed: {message}"));
        }
        (Ok(evaluation), Some(wanted)) => {
            return Err(format!(
                "{evaluation:?}, expected a failure with {wanted:?}"
            ));
        }
        (Ok(evaluation), None) => {
            if case.get("expect").is_some() {
                check_expectation(case, &evaluation)?;
            }
        }
    }
    check_calls(case, &resolvers.calls.borrow())
}
