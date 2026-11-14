//! Checking a value against a shape. The rules here and the keywords the schema emitter writes are the two readings
//! of one descriptor, and the agreement tables in `tests/agreement.rs` keep them equal.
//!
//! The work of a check is linear in the size of the document, whatever the shape: a union decides among its
//! alternatives by first discarding those that cannot match the value's kind or lack a required key, and remembers
//! which alternative accepted which value, so two alternatives that descend into the same child check it once.

use std::collections::{HashMap, HashSet};

use crate::def::{Definitions, Kind, ObjectDef, ShapeDef};
use crate::path::{Issue, Path};
use crate::pattern::Pattern;
use crate::value::Value;

/// Every way `value` does not match `shape`, with the path of the value each is about. Empty when it matches.
pub fn check(definitions: &Definitions, shape: &ShapeDef, value: &Value) -> Vec<Issue> {
    check_with_work(definitions, shape, value).0
}

/// [`check`] and the number of shapes it visited, which is at most a constant times the size of the document times
/// the size of the shape.
pub fn check_with_work(
    definitions: &Definitions,
    shape: &ShapeDef,
    value: &Value,
) -> (Vec<Issue>, u64) {
    let mut checker = Checker::new(definitions, HashMap::new());
    checker.shape(shape, value);
    (checker.issues, checker.work)
}

/// Whether `value` matches `shape`.
pub fn accepts(definitions: &Definitions, shape: &ShapeDef, value: &Value) -> bool {
    check(definitions, shape, value).is_empty()
}

/// Whether `alternative` accepts `value`, remembering the answer in the memory `path` carries, so a conversion that
/// asks the same question at every node of a document asks each once.
pub(crate) fn decide(
    path: &mut Path,
    definitions: &Definitions,
    alternative: &ShapeDef,
    value: &Value,
) -> bool {
    let mut checker = Checker::new(definitions, std::mem::take(&mut path.memo));
    let accepted = checker.accepts_memo(alternative, value);
    path.memo = checker.memo;
    accepted
}

/// A JSON string literal, which is how every message writes a string, so no message depends on Rust's own escaping.
fn json_text(text: &str) -> String {
    crate::pattern::json_quote(text)
}

fn json_list(items: &[String]) -> String {
    Value::Array(
        items
            .iter()
            .map(|item| Value::String(item.clone()))
            .collect(),
    )
    .to_string()
}

/// How deep a union may nest before its kind pre-filter stops looking, so a recursive definition cannot loop.
const FILTER_DEPTH: usize = 16;

struct Checker<'a> {
    definitions: &'a Definitions,
    path: Path,
    issues: Vec<Issue>,
    memo: HashMap<(usize, usize), bool>,
    work: u64,
}

impl<'a> Checker<'a> {
    fn new(definitions: &'a Definitions, memo: HashMap<(usize, usize), bool>) -> Self {
        Checker {
            definitions,
            path: Path::new(),
            issues: Vec::new(),
            memo,
            work: 0,
        }
    }

    fn report(&mut self, message: impl Into<String>) {
        self.issues.push(Issue {
            path: self.path.segments().to_vec(),
            message: message.into(),
        });
    }

    fn expect_type(&mut self, expected: &str, value: &Value) {
        self.report(format!("expected {expected}, found {}", value.type_name()));
    }

    /// Whether `shape` accepts `value`, asked once per pair: the addresses name the pair, and both outlive the check.
    fn accepts_memo(&mut self, shape: &ShapeDef, value: &Value) -> bool {
        let key = (
            std::ptr::from_ref(shape) as usize,
            std::ptr::from_ref(value) as usize,
        );
        if let Some(known) = self.memo.get(&key) {
            return *known;
        }
        let before = self.issues.len();
        self.shape(shape, value);
        let accepted = self.issues.len() == before;
        self.issues.truncate(before);
        self.memo.insert(key, accepted);
        accepted
    }

    /// Whether `value` could match `shape`: false only when it certainly does not, from its kind and the keys a
    /// closed or required field demands. Cheap and never descends into children.
    fn may_match(&self, shape: &ShapeDef, value: &Value, depth: usize) -> bool {
        match &shape.kind {
            Kind::Any => true,
            Kind::Null => *value == Value::Null,
            Kind::Bool | Kind::ConstBool(_) => matches!(value, Value::Bool(_)),
            Kind::ConstString(_) | Kind::Enum(_) | Kind::String { .. } => {
                matches!(value, Value::String(_))
            }
            Kind::Integer { .. } | Kind::Number { .. } => matches!(value, Value::Number(_)),
            Kind::Array { .. } => matches!(value, Value::Array(_)),
            Kind::Map { .. } | Kind::Tagged { .. } => matches!(value, Value::Object(_)),
            Kind::Object(object) => {
                matches!(value, Value::Object(_))
                    && object
                        .fields
                        .iter()
                        .all(|field| !field.required || value.get(&field.name).is_some())
            }
            Kind::OneOf(alternatives) => {
                depth >= FILTER_DEPTH
                    || alternatives
                        .iter()
                        .any(|alternative| self.may_match(alternative, value, depth + 1))
            }
            Kind::Not(_) => true,
            Kind::AllOf(parts) => parts
                .iter()
                .all(|part| self.may_match(part, value, depth + 1)),
            Kind::Ref(name) => match self.definitions.get(name) {
                Some(target) if depth < FILTER_DEPTH => self.may_match(target, value, depth + 1),
                _ => true,
            },
        }
    }

    fn shape(&mut self, shape: &ShapeDef, value: &Value) {
        self.work += 1;
        match &shape.kind {
            Kind::Any => {}
            Kind::Null => {
                if *value != Value::Null {
                    self.expect_type("null", value);
                }
            }
            Kind::Bool => {
                if !matches!(value, Value::Bool(_)) {
                    self.expect_type("a boolean", value);
                }
            }
            Kind::ConstBool(expected) => {
                if *value != Value::Bool(*expected) {
                    self.report(format!("expected {expected}"));
                }
            }
            Kind::ConstString(expected) => {
                if value.as_str() != Some(expected) {
                    self.report(format!("expected {}", json_text(expected)));
                }
            }
            Kind::Enum(options) => {
                if !value
                    .as_str()
                    .is_some_and(|text| options.iter().any(|option| option == text))
                {
                    self.report(format!("expected one of {}", json_list(options)));
                }
            }
            Kind::String {
                min_length,
                pattern,
            } => self.string(*min_length, pattern.as_deref(), value),
            Kind::Integer {
                min,
                exclusive_min,
                max,
            } => self.number(true, [*min, *exclusive_min, *max], value),
            Kind::Number {
                min,
                exclusive_min,
                max,
            } => self.number(false, [*min, *exclusive_min, *max], value),
            Kind::Array {
                items,
                min_items,
                max_items,
                unique,
            } => self.array(items, *min_items, *max_items, *unique, value),
            Kind::Map {
                values,
                min_properties,
                key_pattern,
            } => self.map(values, *min_properties, key_pattern.as_deref(), value),
            Kind::Object(object) => self.object(object, value),
            Kind::OneOf(alternatives) => self.one_of(alternatives, value),
            Kind::Not(inner) => {
                if self.accepts_memo(inner, value) {
                    self.report("matches a shape it must not match");
                }
            }
            Kind::AllOf(parts) => {
                for part in parts {
                    self.shape(part, value);
                }
            }
            Kind::Tagged { tag, variants } => self.tagged(tag, variants, value),
            Kind::Ref(name) => match self.definitions.get(name) {
                Some(target) => self.shape(target, value),
                None => self.report(format!("the definition {} does not exist", json_text(name))),
            },
        }
    }

    fn string(&mut self, min_length: Option<usize>, pattern: Option<&str>, value: &Value) {
        let Some(text) = value.as_str() else {
            return self.expect_type("a string", value);
        };
        if let Some(least) = min_length
            && text.chars().count() < least
        {
            self.report(format!("expected at least {least} characters"));
        }
        if let Some(source) = pattern {
            match Pattern::shared(source) {
                Ok(compiled) if !compiled.is_match(text) => {
                    self.report(format!("expected a string matching {}", json_text(source)));
                }
                Ok(_) => {}
                Err(error) => self.report(error.to_string()),
            }
        }
    }

    fn number(&mut self, whole: bool, [min, exclusive_min, max]: [Option<f64>; 3], value: &Value) {
        let Some(number) = value.as_f64() else {
            return self.expect_type(if whole { "an integer" } else { "a number" }, value);
        };
        if whole && number.fract() != 0.0 {
            return self.report("expected an integer, found a fraction");
        }
        if let Some(least) = min
            && number < least
        {
            self.report(format!("expected at least {least}"));
        }
        if let Some(above) = exclusive_min
            && number <= above
        {
            self.report(format!("expected more than {above}"));
        }
        if let Some(most) = max
            && number > most
        {
            self.report(format!("expected at most {most}"));
        }
    }

    fn array(
        &mut self,
        items: &ShapeDef,
        min_items: Option<usize>,
        max_items: Option<usize>,
        unique: bool,
        value: &Value,
    ) {
        let Some(elements) = value.as_array() else {
            return self.expect_type("an array", value);
        };
        if let Some(least) = min_items
            && elements.len() < least
        {
            self.report(format!("expected at least {least} items"));
        }
        if let Some(most) = max_items
            && elements.len() > most
        {
            self.report(format!("expected at most {most} items"));
        }
        if unique {
            let mut seen = HashSet::new();
            if elements
                .iter()
                .any(|element| !seen.insert(element.canonical()))
            {
                self.report("expected every item to be different");
            }
        }
        for (position, element) in elements.iter().enumerate() {
            self.path.push_index(position);
            self.shape(items, element);
            self.path.pop();
        }
    }

    fn map(
        &mut self,
        values: &ShapeDef,
        min_properties: Option<usize>,
        key_pattern: Option<&str>,
        value: &Value,
    ) {
        let Some(pairs) = value.as_object() else {
            return self.expect_type("an object", value);
        };
        if let Some(least) = min_properties
            && pairs.len() < least
        {
            self.report(format!("expected at least {least} properties"));
        }
        let key_check = key_pattern.map(|source| (source, Pattern::shared(source)));
        for (key, entry) in pairs {
            self.path.push_key(key);
            match &key_check {
                Some((source, Ok(compiled))) if !compiled.is_match(key) => {
                    self.report(format!("the key must match {}", json_text(source)));
                }
                Some((_, Err(error))) => self.report(error.to_string()),
                _ => {}
            }
            self.shape(values, entry);
            self.path.pop();
        }
    }

    fn object(&mut self, object: &ObjectDef, value: &Value) {
        let Some(pairs) = value.as_object() else {
            return self.expect_type("an object", value);
        };
        if let Some(least) = object.min_properties
            && pairs.len() < least
        {
            self.report(format!("expected at least {least} properties"));
        }
        for field in &object.fields {
            match value.get(&field.name) {
                Some(entry) => {
                    self.path.push_key(&field.name);
                    self.shape(&field.shape, entry);
                    self.path.pop();
                }
                None if field.required => {
                    self.report(format!(
                        "missing the required property {}",
                        json_text(&field.name)
                    ));
                }
                None => {}
            }
        }
        if object.closed || object.additional.is_some() {
            for (key, entry) in pairs {
                if object.fields.iter().any(|field| field.name == *key) {
                    continue;
                }
                self.path.push_key(key);
                match &object.additional {
                    Some(shape) => self.shape(shape, entry),
                    None => self.report("unexpected property"),
                }
                self.path.pop();
            }
        }
        if !object.any_of_keys.is_empty() || !object.one_of_keys.is_empty() {
            let present =
                |keys: &[String]| keys.iter().filter(|key| value.get(key).is_some()).count();
            if !object.any_of_keys.is_empty() && present(&object.any_of_keys) == 0 {
                self.report(format!(
                    "expected at least one of {}",
                    json_list(&object.any_of_keys)
                ));
            }
            if !object.one_of_keys.is_empty() && present(&object.one_of_keys) != 1 {
                self.report(format!(
                    "expected exactly one of {}",
                    json_list(&object.one_of_keys)
                ));
            }
        }
        for (key, required) in &object.dependent_required {
            if value.get(key).is_none() {
                continue;
            }
            for other in required {
                if value.get(other).is_none() {
                    self.report(format!("{} requires {}", json_text(key), json_text(other)));
                }
            }
        }
    }

    fn one_of(&mut self, alternatives: &[ShapeDef], value: &Value) {
        let candidates: Vec<&ShapeDef> = alternatives
            .iter()
            .filter(|alternative| self.may_match(alternative, value, 0))
            .collect();
        let mut matching = 0;
        for candidate in &candidates {
            if self.accepts_memo(candidate, value) {
                matching += 1;
            }
        }
        match (matching, candidates.as_slice()) {
            (1, _) => {}
            // The one alternative the value could be is the one it fails, so its issues, at their own paths, say why.
            (0, [only]) => self.shape(only, value),
            (0, _) => self.report("matches none of the alternatives"),
            _ => self.report("matches more than one alternative"),
        }
    }

    fn tagged(&mut self, tag: &str, variants: &[(String, ShapeDef)], value: &Value) {
        if value.as_object().is_none() {
            return self.expect_type("an object", value);
        }
        let Some(chosen) = value.get(tag).and_then(Value::as_str) else {
            self.path.push_key(tag);
            self.report("expected a string naming the kind");
            self.path.pop();
            return;
        };
        match variants.iter().find(|(name, _)| name == chosen) {
            Some((_, variant)) => self.shape(variant, value),
            None => {
                self.path.push_key(tag);
                let names: Vec<String> = variants.iter().map(|(name, _)| name.clone()).collect();
                self.report(format!("expected one of {}", json_list(&names)));
                self.path.pop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{Definitions, Kind, ShapeDef, Value, check};

    #[test]
    fn a_pattern_is_compiled_once_however_many_values_are_checked() {
        let source = "^unique-counted-[0-9]+$";
        let shape = ShapeDef::new(Kind::Array {
            items: Box::new(ShapeDef::new(Kind::String {
                min_length: None,
                pattern: Some(source.to_owned()),
            })),
            min_items: None,
            max_items: None,
            unique: false,
        });
        let strings = (0..1000)
            .map(|n| Value::String(format!("unique-counted-{n}")))
            .collect();
        assert!(check(&Definitions::default(), &shape, &Value::Array(strings)).is_empty());
        assert_eq!(crate::pattern::compilations_of(source), 1);

        let key_source = "^unique-keyed-[0-9]+$";
        let keyed = ShapeDef::new(Kind::Map {
            values: Box::new(ShapeDef::new(Kind::Any)),
            min_properties: None,
            key_pattern: Some(key_source.to_owned()),
        });
        let members = (0..500)
            .map(|n| (format!("unique-keyed-{n}"), Value::Null))
            .collect();
        assert!(check(&Definitions::default(), &keyed, &Value::Object(members)).is_empty());
        assert_eq!(crate::pattern::compilations_of(key_source), 1);
    }
}
