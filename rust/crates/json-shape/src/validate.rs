//! Checking a value against a shape. The rules here and the keywords the schema emitter writes are the two readings
//! of one descriptor, and the agreement table in `tests/agreement.rs` keeps them equal.

use crate::def::{Definitions, Kind, ObjectDef, ShapeDef};
use crate::path::{Issue, Path};
use crate::pattern::Pattern;
use crate::value::Value;

/// Every way `value` does not match `shape`, with the path of the value each is about. Empty when it matches.
pub fn check(definitions: &Definitions, shape: &ShapeDef, value: &Value) -> Vec<Issue> {
    let mut checker = Checker {
        definitions,
        path: Path::new(),
        issues: Vec::new(),
    };
    checker.shape(shape, value);
    checker.issues
}

/// Whether `value` matches `shape`.
pub fn accepts(definitions: &Definitions, shape: &ShapeDef, value: &Value) -> bool {
    check(definitions, shape, value).is_empty()
}

struct Checker<'a> {
    definitions: &'a Definitions,
    path: Path,
    issues: Vec<Issue>,
}

impl Checker<'_> {
    fn report(&mut self, message: impl Into<String>) {
        self.issues.push(Issue {
            path: self.path.segments().to_vec(),
            message: message.into(),
        });
    }

    fn expect_type(&mut self, expected: &str, value: &Value) {
        self.report(format!("expected {expected}, found {}", value.type_name()));
    }

    fn shape(&mut self, shape: &ShapeDef, value: &Value) {
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
                    self.report(format!("expected {expected:?}"));
                }
            }
            Kind::Enum(options) => {
                if !value
                    .as_str()
                    .is_some_and(|text| options.iter().any(|option| option == text))
                {
                    self.report(format!("expected one of {options:?}"));
                }
            }
            Kind::String {
                min_length,
                pattern,
            } => self.string(*min_length, pattern.as_deref(), value),
            Kind::Integer { min, max } => self.number(true, *min, *max, value),
            Kind::Number { min, max } => self.number(false, *min, *max, value),
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
            Kind::Tagged { tag, variants } => self.tagged(tag, variants, value),
            Kind::Ref(name) => match self.definitions.get(name) {
                Some(target) => self.shape(target, value),
                None => self.report(format!("the definition {name} does not exist")),
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
            match Pattern::new(source) {
                Ok(compiled) if !compiled.is_match(text) => {
                    self.report(format!("expected a string matching {source}"));
                }
                Ok(_) => {}
                Err(error) => self.report(error.to_string()),
            }
        }
    }

    fn number(&mut self, whole: bool, min: Option<f64>, max: Option<f64>, value: &Value) {
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
        if unique
            && elements.iter().enumerate().any(|(position, element)| {
                elements[..position]
                    .iter()
                    .any(|earlier| earlier.json_equal(element))
            })
        {
            self.report("expected every item to be different");
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
        let key_check = key_pattern.map(|source| (source, Pattern::new(source)));
        for (key, entry) in pairs {
            self.path.push_key(key);
            match &key_check {
                Some((source, Ok(compiled))) if !compiled.is_match(key) => {
                    self.report(format!("the key must match {source}"));
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
                    self.report(format!("missing the required property {}", field.name))
                }
                None => {}
            }
        }
        if object.closed {
            for (key, _) in pairs {
                if !object.fields.iter().any(|field| field.name == *key) {
                    self.path.push_key(key);
                    self.report("unexpected property");
                    self.path.pop();
                }
            }
        }
        for (key, required) in &object.dependent_required {
            if value.get(key).is_none() {
                continue;
            }
            for other in required {
                if value.get(other).is_none() {
                    self.report(format!("{key} requires {other}"));
                }
            }
        }
    }

    fn one_of(&mut self, alternatives: &[ShapeDef], value: &Value) {
        let mut matching = 0;
        let mut closest: Option<Vec<Issue>> = None;
        for alternative in alternatives {
            let found = check(self.definitions, alternative, value);
            if found.is_empty() {
                matching += 1;
            } else if closest.as_ref().is_none_or(|best| found.len() < best.len()) {
                closest = Some(found);
            }
        }
        match (matching, closest) {
            (1, _) => {}
            (0, closest) => {
                let detail = closest
                    .and_then(|issues| issues.into_iter().next())
                    .map(|issue| format!(" (the closest: {issue})"))
                    .unwrap_or_default();
                self.report(format!("matches none of the alternatives{detail}"));
            }
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
                let names: Vec<&str> = variants.iter().map(|(name, _)| name.as_str()).collect();
                self.report(format!("expected one of {names:?}"));
                self.path.pop();
            }
        }
    }
}
