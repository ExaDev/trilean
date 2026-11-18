//! Which forms a shape accepts that no instance uses. A form a corpus never writes is a contract nobody has run, and a
//! second implementation cannot tell what it should do with it, so a corpus must use every form its shape allows.
//!
//! The shape is the one the repository's types derive, which is also the source of the JSON Schema the corpus publishes (a
//! test of the repository compares the two), so nothing is read from a schema file and no schema validator is needed:
//! a form is named by where it is in the shape, and an instance uses it when walking the shape along the instance
//! reaches it.

use std::collections::BTreeSet;

use trilean_json_shape::{Definitions, Kind, ShapeDef, Value, accepts};

/// What the instances are walked along, as the places in the shape that can be used.
/// The prefix of a place that names a reference to a definition the shape does not have, which is a fault of the shape and
/// not a form an instance could use.
const DANGLING: &str = "dangling:";

struct Forms<'a> {
    definitions: &'a Definitions,
}

impl Forms<'_> {
    /// Every place in `shape` that an instance can use, below the place `at`, following each named definition once.
    fn all(
        &self,
        shape: &ShapeDef,
        at: &str,
        reached: &mut BTreeSet<String>,
        found: &mut BTreeSet<String>,
    ) {
        match &shape.kind {
            Kind::Ref(name) => {
                // A definition is followed once, which is what ends the walk of a type that refers to itself.
                if !reached.insert(name.clone()) {
                    return;
                }
                match self.definitions.get(name) {
                    Some(definition) => self.all(definition, name, reached, found),
                    None => {
                        found.insert(format!("{DANGLING}{name}"));
                    }
                }
            }
            Kind::Object(object) => {
                for field in &object.fields {
                    let here = format!("{at}/properties/{}", field.name);
                    found.insert(here.clone());
                    self.all(&field.shape, &here, reached, found);
                }
                if let Some(additional) = &object.additional {
                    self.all(
                        additional,
                        &format!("{at}/additionalProperties"),
                        reached,
                        found,
                    );
                }
            }
            Kind::Array { items, .. } => {
                self.all(items, &format!("{at}/items"), reached, found);
            }
            Kind::Map { values, .. } => {
                self.all(
                    values,
                    &format!("{at}/additionalProperties"),
                    reached,
                    found,
                );
            }
            Kind::OneOf(alternatives) => {
                for (position, alternative) in alternatives.iter().enumerate() {
                    let here = format!("{at}/oneOf/{position}");
                    found.insert(here.clone());
                    self.all(alternative, &here, reached, found);
                }
            }
            Kind::Tagged { tag, variants } => {
                for (name, variant) in variants {
                    let here = format!("{at}/{tag}={name}");
                    found.insert(here.clone());
                    self.all(variant, &here, reached, found);
                }
            }
            Kind::AllOf(shapes) => {
                for (position, part) in shapes.iter().enumerate() {
                    self.all(part, &format!("{at}/allOf/{position}"), reached, found);
                }
            }
            Kind::Enum(values) => {
                for value in values {
                    found.insert(format!("{at}/enum:{value}"));
                }
            }
            Kind::Any
            | Kind::Null
            | Kind::Bool
            | Kind::ConstBool(_)
            | Kind::ConstString(_)
            | Kind::String { .. }
            | Kind::Integer { .. }
            | Kind::Number { .. }
            | Kind::Not(_) => {}
        }
    }

    /// Marks every place `instance` uses when it is read as `shape`, below the place `at`.
    fn used(&self, shape: &ShapeDef, instance: &Value, at: &str, used: &mut BTreeSet<String>) {
        match (&shape.kind, instance) {
            (Kind::Ref(name), _) => {
                if let Some(definition) = self.definitions.get(name) {
                    self.used(definition, instance, name, used);
                }
            }
            (Kind::Object(object), Value::Object(pairs)) => {
                for (name, member) in pairs {
                    match object.fields.iter().find(|field| &field.name == name) {
                        Some(field) => {
                            let here = format!("{at}/properties/{name}");
                            used.insert(here.clone());
                            self.used(&field.shape, member, &here, used);
                        }
                        None => {
                            if let Some(additional) = &object.additional {
                                self.used(
                                    additional,
                                    member,
                                    &format!("{at}/additionalProperties"),
                                    used,
                                );
                            }
                        }
                    }
                }
            }
            (Kind::Array { items, .. }, Value::Array(members)) => {
                let here = format!("{at}/items");
                for member in members {
                    self.used(items, member, &here, used);
                }
            }
            (Kind::Map { values, .. }, Value::Object(pairs)) => {
                let here = format!("{at}/additionalProperties");
                for (_, member) in pairs {
                    self.used(values, member, &here, used);
                }
            }
            (Kind::OneOf(alternatives), _) => {
                if let Some((position, alternative)) = alternatives
                    .iter()
                    .enumerate()
                    .find(|(_, alternative)| accepts(self.definitions, alternative, instance))
                {
                    let here = format!("{at}/oneOf/{position}");
                    used.insert(here.clone());
                    self.used(alternative, instance, &here, used);
                }
            }
            (Kind::Tagged { tag, variants }, Value::Object(pairs)) => {
                let named = pairs
                    .iter()
                    .find(|(name, _)| name == tag)
                    .and_then(|(_, value)| value.as_str());
                if let Some(chosen) = named
                    && let Some((name, variant)) = variants.iter().find(|(name, _)| name == chosen)
                {
                    let here = format!("{at}/{tag}={name}");
                    used.insert(here.clone());
                    self.used(variant, instance, &here, used);
                }
            }
            (Kind::AllOf(shapes), _) => {
                for (position, part) in shapes.iter().enumerate() {
                    self.used(part, instance, &format!("{at}/allOf/{position}"), used);
                }
            }
            (Kind::Enum(_), Value::String(chosen)) => {
                used.insert(format!("{at}/enum:{chosen}"));
            }
            _ => {}
        }
    }
}

/// The forms of `root` that no instance uses, as messages in order: a property of an object, a branch of a `oneOf`, a
/// variant of a tagged union and a value of an enum, each named by its place (the definition it is in and the path
/// below it). `definitions` are the named shapes `root` refers to, as the repository's types derive them. An empty list
/// is a corpus that uses every form its shape allows. A reference to a definition `definitions` does not hold is a fault of
/// the shape and is reported by name.
pub fn schema_coverage(
    definitions: &Definitions,
    root: &ShapeDef,
    instances: &[Value],
) -> Vec<String> {
    let forms = Forms { definitions };
    let mut every = BTreeSet::new();
    forms.all(root, "$", &mut BTreeSet::new(), &mut every);
    let mut used = BTreeSet::new();
    for instance in instances {
        forms.used(root, instance, "$", &mut used);
    }
    every
        .difference(&used)
        .map(|form| match form.strip_prefix(DANGLING) {
            Some(name) => format!("the shape refers to {name}, which it does not define"),
            None => format!("no instance uses {form}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use trilean_json_shape::Shape;

    #[expect(
        dead_code,
        reason = "the types are described and walked, and no code reads their fields"
    )]
    #[derive(Shape)]
    #[serde(tag = "kind")]
    enum Case {
        #[serde(rename = "plain")]
        Plain { id: String, note: Option<String> },
        #[serde(rename = "sized")]
        Sized {
            id: String,
            size: Size,
            extra: Option<Choice>,
        },
    }

    #[derive(Shape)]
    #[serde(rename_all = "lowercase")]
    enum Size {
        Small,
        Large,
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    #[serde(untagged)]
    enum Choice {
        Number(f64),
        Text(String),
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    struct File {
        cases: Vec<Case>,
    }

    fn parse(text: &str) -> Value {
        serde_json::from_str(text).expect("valid JSON")
    }

    fn coverage(instances: &[&str]) -> Vec<String> {
        let definitions = Definitions::of::<File>();
        let instances: Vec<Value> = instances.iter().map(|text| parse(text)).collect();
        schema_coverage(&definitions, &File::reference(), &instances)
    }

    const FULL: [&str; 3] = [
        r#"{"cases":[{"kind":"plain","id":"a","note":"n"}]}"#,
        r#"{"cases":[{"kind":"sized","id":"b","size":"small","extra":1}]}"#,
        r#"{"cases":[{"kind":"sized","id":"c","size":"large","extra":"x"}]}"#,
    ];

    #[test]
    fn instances_that_use_every_form_leave_nothing_unused() {
        assert_eq!(coverage(&FULL), Vec::<String>::new());
    }

    #[test]
    fn a_property_no_instance_has_is_reported() {
        let without_note = [r#"{"cases":[{"kind":"plain","id":"a"}]}"#, FULL[1], FULL[2]];
        let unused = coverage(&without_note);
        assert_eq!(unused.len(), 1, "{unused:?}");
        assert!(unused[0].contains("properties/note"), "{unused:?}");
    }

    #[test]
    fn a_variant_of_a_tagged_union_no_instance_has_is_reported() {
        let unused = coverage(&[FULL[0]]);
        assert!(
            unused.iter().any(|form| form.contains("kind=sized")),
            "{unused:?}"
        );
    }

    #[test]
    fn a_value_of_an_enum_and_a_branch_of_a_union_no_instance_has_are_reported() {
        let unused = coverage(&[FULL[0], FULL[1]]);
        assert!(
            unused.iter().any(|form| form.contains("enum:large")),
            "{unused:?}"
        );
        assert!(
            unused.iter().any(|form| form.contains("oneOf/1")),
            "{unused:?}"
        );
        assert!(
            !unused.iter().any(|form| form.contains("enum:small")),
            "{unused:?}"
        );
        assert!(
            !unused.iter().any(|form| form.contains("oneOf/0")),
            "{unused:?}"
        );
    }

    #[test]
    fn nothing_is_used_by_no_instances_and_the_report_is_in_order() {
        let unused = coverage(&[]);
        assert!(unused.len() > 8, "{unused:?}");
        let mut sorted = unused.clone();
        sorted.sort();
        assert_eq!(unused, sorted);
    }

    #[test]
    fn an_instance_the_shape_does_not_describe_uses_nothing() {
        let unused = coverage(&[r#"[1,2]"#, r#"{"unknown":1}"#, r#"7"#]);
        assert_eq!(unused, coverage(&[]));
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    struct Node {
        name: String,
        children: Vec<Node>,
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    struct Leaf {
        value: u8,
        kind: Size,
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    struct Shared {
        left: Leaf,
        right: Leaf,
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    struct Bag {
        by_name: trilean_json_shape::Map<Leaf>,
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    struct Base {
        id: String,
    }

    #[expect(dead_code, reason = "described and walked only")]
    #[derive(Shape)]
    struct Both {
        base: Base,
        leaf: Leaf,
    }

    fn unused_of<T: Shape>(instances: &[&str]) -> Vec<String> {
        let instances: Vec<Value> = instances.iter().map(|text| parse(text)).collect();
        schema_coverage(&Definitions::of::<T>(), &T::reference(), &instances)
    }

    #[test]
    fn a_type_that_refers_to_itself_is_walked_once_and_its_instances_to_their_depth() {
        assert_eq!(
            unused_of::<Node>(&[]),
            [
                "no instance uses Node/properties/children",
                "no instance uses Node/properties/name"
            ]
        );
        let nested =
            r#"{"name":"a","children":[{"name":"b","children":[{"name":"c","children":[]}]}]}"#;
        assert_eq!(unused_of::<Node>(&[nested]), Vec::<String>::new());
    }

    #[test]
    fn a_definition_used_in_two_places_is_reported_once_and_credited_from_either() {
        assert_eq!(
            unused_of::<Shared>(&[]),
            [
                "no instance uses Leaf/properties/kind",
                "no instance uses Leaf/properties/value",
                "no instance uses Shared/properties/left",
                "no instance uses Shared/properties/right",
                "no instance uses Size/enum:large",
                "no instance uses Size/enum:small",
            ]
        );
        let through_left = r#"{"left":{"value":1,"kind":"small"}}"#;
        assert_eq!(
            unused_of::<Shared>(&[through_left]),
            [
                "no instance uses Shared/properties/right",
                "no instance uses Size/enum:large"
            ]
        );
    }

    #[test]
    fn the_values_of_a_map_are_walked_and_credited() {
        assert_eq!(
            unused_of::<Bag>(&[]),
            [
                "no instance uses Bag/properties/by_name",
                "no instance uses Leaf/properties/kind",
                "no instance uses Leaf/properties/value",
                "no instance uses Size/enum:large",
                "no instance uses Size/enum:small",
            ]
        );
        let one = r#"{"by_name":{"x":{"value":1,"kind":"small"},"y":{"value":2,"kind":"large"}}}"#;
        assert_eq!(unused_of::<Bag>(&[one]), Vec::<String>::new());
    }

    #[test]
    fn every_part_of_an_all_of_is_walked_and_credited() {
        let definitions = Definitions::of::<Both>();
        let root = ShapeDef::new(Kind::AllOf(vec![Base::reference(), Leaf::reference()]));
        let none = schema_coverage(&definitions, &root, &[]);
        assert!(
            none.iter().any(|form| form.contains("Base/properties/id")),
            "{none:?}"
        );
        assert!(
            none.iter()
                .any(|form| form.contains("Leaf/properties/value")),
            "{none:?}"
        );
        let used = parse(r#"{"id":"a","value":1,"kind":"small"}"#);
        assert_eq!(
            schema_coverage(&definitions, &root, &[used]),
            ["no instance uses Size/enum:large"]
        );
    }

    #[test]
    fn a_reference_to_a_definition_the_shape_does_not_hold_is_named() {
        let root = ShapeDef::new(Kind::Ref("Missing".to_owned()));
        assert_eq!(
            schema_coverage(&Definitions::default(), &root, &[]),
            ["the shape refers to Missing, which it does not define"]
        );
        // An instance cannot use it, so it is reported whatever the instances are.
        assert_eq!(
            schema_coverage(&Definitions::default(), &root, &[parse("{}")]),
            ["the shape refers to Missing, which it does not define"]
        );
    }
}
