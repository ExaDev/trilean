//! The descriptor of a shape: what a type accepts, as data, so one description drives validation, the JSON Schema
//! and the TypeScript declarations.

use std::any::TypeId;

use crate::pattern::Pattern;
use crate::shape::Shape;

/// The class of a type's shape, which decides at compile time which `#[shape(...)]` constraints may apply to a field
/// of that type. A named type (a derived struct or enum) is written as a reference to its definition, so no
/// constraint applies to the field itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Any,
    Bool,
    String,
    Integer,
    Number,
    Array,
    Map,
    OpenObject,
    Named,
}

/// What a value of a shape looks like.
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    /// Any JSON value.
    Any,
    Null,
    Bool,
    /// Exactly this boolean.
    ConstBool(bool),
    /// Exactly this string.
    ConstString(String),
    /// One of these strings.
    Enum(Vec<String>),
    /// A string, at least `min_length` characters long (Unicode scalar values, as JSON Schema counts them) and,
    /// when `pattern` is given, matching it.
    String {
        min_length: Option<usize>,
        pattern: Option<String>,
    },
    /// A whole number between the bounds. A number written with a zero fraction (`97.0`) is whole, as in JSON Schema.
    Integer {
        min: Option<f64>,
        exclusive_min: Option<f64>,
        max: Option<f64>,
    },
    Number {
        min: Option<f64>,
        exclusive_min: Option<f64>,
        max: Option<f64>,
    },
    Array {
        items: Box<ShapeDef>,
        min_items: Option<usize>,
        max_items: Option<usize>,
        unique: bool,
    },
    /// An object whose every value has one shape, with keys that match `key_pattern` when it is given.
    Map {
        values: Box<ShapeDef>,
        min_properties: Option<usize>,
        key_pattern: Option<String>,
    },
    Object(ObjectDef),
    /// A value that matches exactly one of the alternatives.
    OneOf(Vec<ShapeDef>),
    /// An object chosen by the string under `tag`: every variant is an object that holds `tag` as a constant.
    Tagged {
        tag: String,
        variants: Vec<(String, ShapeDef)>,
    },
    /// A value that does not match the shape.
    Not(Box<ShapeDef>),
    /// A value that matches every shape. Written as one schema node when the shapes use different keywords, and as
    /// `allOf` when they do not.
    AllOf(Vec<ShapeDef>),
    /// A named definition.
    Ref(String),
}

/// A shape with the description that documents it.
#[derive(Clone, Debug, PartialEq)]
pub struct ShapeDef {
    pub description: Option<String>,
    pub kind: Kind,
}

/// One field of an object.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldDef {
    pub name: String,
    pub shape: ShapeDef,
    pub required: bool,
}

/// An object with named fields.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ObjectDef {
    pub fields: Vec<FieldDef>,
    /// Whether a key outside `fields` is refused.
    pub closed: bool,
    /// The shape of the value of a key outside `fields`, for an object that holds any key but types its value.
    pub additional: Option<Box<ShapeDef>>,
    /// When not empty, at least one of these keys is present.
    pub any_of_keys: Vec<String>,
    /// When not empty, exactly one of these keys is present.
    pub one_of_keys: Vec<String>,
    pub min_properties: Option<usize>,
    /// For each key, the keys that must be present whenever it is.
    pub dependent_required: Vec<(String, Vec<String>)>,
}

/// A constraint a field attribute adds to the shape of the field's type.
#[derive(Clone, Debug, PartialEq)]
pub enum Constraint {
    Min(f64),
    ExclusiveMin(f64),
    Max(f64),
    MinLength(usize),
    Pattern(String),
    MinItems(usize),
    MaxItems(usize),
    UniqueItems,
    MinProperties(usize),
    KeyPattern(String),
}

impl ShapeDef {
    pub fn new(kind: Kind) -> Self {
        ShapeDef {
            description: None,
            kind,
        }
    }

    pub fn described(mut self, description: &str) -> Self {
        self.description = Some(description.to_owned());
        self
    }

    /// Replaces the shape with exactly the boolean `value`.
    pub fn constant_bool(mut self, value: bool) -> Self {
        self.kind = Kind::ConstBool(value);
        self
    }

    /// Replaces the shape with exactly the string `value`.
    pub fn constant_string(mut self, value: &str) -> Self {
        self.kind = Kind::ConstString(value.to_owned());
        self
    }

    /// Adds `constraint`.
    ///
    /// # Panics
    ///
    /// When the constraint does not apply to this kind of shape, or a pattern is outside the supported subset
    /// (see [`crate::Pattern`]). A derive attribute that does either is a mistake in the type, found the first time
    /// its definitions are built.
    pub fn constrained(mut self, constraint: Constraint) -> Self {
        match (&mut self.kind, constraint) {
            (Kind::Integer { min, .. } | Kind::Number { min, .. }, Constraint::Min(bound)) => {
                *min = Some(bound);
            }
            (
                Kind::Integer { exclusive_min, .. } | Kind::Number { exclusive_min, .. },
                Constraint::ExclusiveMin(bound),
            ) => {
                *exclusive_min = Some(bound);
            }
            (Kind::Integer { max, .. } | Kind::Number { max, .. }, Constraint::Max(bound)) => {
                *max = Some(bound);
            }
            (Kind::String { min_length, .. }, Constraint::MinLength(length)) => {
                *min_length = Some(length)
            }
            (Kind::String { pattern, .. }, Constraint::Pattern(source)) => {
                check_pattern(&source);
                *pattern = Some(source);
            }
            (Kind::Array { min_items, .. }, Constraint::MinItems(count)) => {
                *min_items = Some(count)
            }
            (Kind::Array { max_items, .. }, Constraint::MaxItems(count)) => {
                *max_items = Some(count)
            }
            (Kind::Array { unique, .. }, Constraint::UniqueItems) => *unique = true,
            (Kind::Map { min_properties, .. }, Constraint::MinProperties(count)) => {
                *min_properties = Some(count);
            }
            (Kind::Object(object), Constraint::MinProperties(count)) => {
                object.min_properties = Some(count)
            }
            (Kind::Map { key_pattern, .. }, Constraint::KeyPattern(source)) => {
                check_pattern(&source);
                *key_pattern = Some(source);
            }
            (kind, constraint) => {
                panic!("the constraint {constraint:?} does not apply to {kind:?}")
            }
        }
        self
    }
}

fn check_pattern(source: &str) {
    if let Err(error) = Pattern::new(source) {
        panic!("{error}");
    }
}

/// The named shapes a document is described by, in the order they were first reached.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Definitions {
    entries: Vec<(String, ShapeDef)>,
}

impl Definitions {
    /// The definition of `T` and of every named type it refers to.
    ///
    /// # Panics
    ///
    /// When two different types reachable from `T` have the same definition name, naming both types. A derived
    /// type's name is its identifier, or the one `#[shape(name = "...")]` gives.
    pub fn of<T: Shape>() -> Self {
        let mut registry = Registry::default();
        T::register(&mut registry);
        registry.into_definitions()
    }

    pub fn get(&self, name: &str) -> Option<&ShapeDef> {
        self.entries
            .iter()
            .find(|(entry, _)| entry == name)
            .map(|(_, shape)| shape)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &ShapeDef)> {
        self.entries
            .iter()
            .map(|(name, shape)| (name.as_str(), shape))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The definitions without the one named `name`, for a document that holds that shape inline.
    pub fn without(mut self, name: &str) -> Self {
        self.entries.retain(|(entry, _)| entry != name);
        self
    }
}

/// Collects definitions while a type registers itself and what it refers to.
#[derive(Debug, Default)]
pub struct Registry {
    definitions: Definitions,
    owners: Vec<(TypeId, &'static str)>,
}

impl Registry {
    /// The definitions collected so far.
    pub fn into_definitions(self) -> Definitions {
        self.definitions
    }

    /// Reserves `name` for the type `id`, called `type_name` in messages. Returns whether the caller is the first to
    /// reach it and so must call [`Registry::define`] and register what it refers to; a recursive type is reserved
    /// before its fields are visited.
    ///
    /// # Panics
    ///
    /// When `name` is already reserved by a different type, naming both, because a definition is looked up by name
    /// and one of the two would otherwise be silently replaced by the other.
    pub fn reserve(&mut self, name: &str, id: TypeId, type_name: &'static str) -> bool {
        if let Some(position) = self
            .definitions
            .entries
            .iter()
            .position(|(entry, _)| entry == name)
        {
            let (owner, owner_name) = self.owners[position];
            assert!(
                owner == id,
                "the definition name {name:?} is used by two types, {owner_name} and {type_name}; give one of them #[shape(name = \"...\")]"
            );
            return false;
        }
        self.definitions
            .entries
            .push((name.to_owned(), ShapeDef::new(Kind::Any)));
        self.owners.push((id, type_name));
        true
    }

    /// Sets the definition of a reserved name.
    pub fn define(&mut self, name: &str, shape: ShapeDef) {
        if let Some(entry) = self
            .definitions
            .entries
            .iter_mut()
            .find(|(entry, _)| entry == name)
        {
            entry.1 = shape;
        }
    }
}
