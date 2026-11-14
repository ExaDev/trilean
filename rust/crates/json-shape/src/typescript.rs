//! The TypeScript declarations a shape writes.

use crate::def::{Definitions, Kind, ObjectDef, ShapeDef};
use crate::value::Value;

fn literal(value: &str) -> String {
    Value::String(value.to_owned()).to_string()
}

fn comment(description: &str, indent: &str) -> String {
    format!("{indent}/** {} */\n", description.replace("*/", "* /"))
}

fn property_key(name: &str) -> String {
    let identifier = name.chars().enumerate().all(|(position, letter)| {
        letter == '_'
            || letter == '$'
            || letter.is_ascii_alphabetic()
            || (position > 0 && letter.is_ascii_digit())
    });
    if identifier && !name.is_empty() {
        name.to_owned()
    } else {
        literal(name)
    }
}

fn object_type(object: &ObjectDef, indent: &str) -> String {
    let mut lines = String::from("{\n");
    let inner = format!("{indent}  ");
    for field in &object.fields {
        if let Some(description) = &field.shape.description {
            lines.push_str(&comment(description, &inner));
        }
        let optional = if field.required { "" } else { "?" };
        lines.push_str(&format!(
            "{inner}{}{optional}: {};\n",
            property_key(&field.name),
            type_of(&field.shape, &inner)
        ));
    }
    if let Some(additional) = &object.additional {
        lines.push_str(&format!(
            "{inner}[key: string]: {};\n",
            type_of(additional, &inner)
        ));
    } else if !object.closed {
        lines.push_str(&format!("{inner}[key: string]: unknown;\n"));
    }
    lines.push_str(indent);
    lines.push('}');
    lines
}

fn union(members: Vec<String>) -> String {
    members.join(" | ")
}

/// The TypeScript type of a shape, with references written as the names of the declarations.
fn type_of(shape: &ShapeDef, indent: &str) -> String {
    match &shape.kind {
        Kind::Any => "unknown".to_owned(),
        Kind::Null => "null".to_owned(),
        Kind::Bool => "boolean".to_owned(),
        Kind::ConstBool(flag) => flag.to_string(),
        Kind::ConstString(value) => literal(value),
        Kind::Enum(options) => union(options.iter().map(|option| literal(option)).collect()),
        Kind::String { .. } => "string".to_owned(),
        Kind::Integer { .. } | Kind::Number { .. } => "number".to_owned(),
        Kind::Array { items, .. } => {
            let element = type_of(items, indent);
            if element.contains(' ') {
                format!("({element})[]")
            } else {
                format!("{element}[]")
            }
        }
        Kind::Map { values, .. } => format!("{{ [key: string]: {} }}", type_of(values, indent)),
        Kind::Object(object)
            if object.fields.is_empty() && !object.closed && object.additional.is_none() =>
        {
            "{ [key: string]: unknown }".to_owned()
        }
        Kind::Object(object) => object_type(object, indent),
        Kind::OneOf(alternatives) => union(
            alternatives
                .iter()
                .map(|alternative| type_of(alternative, indent))
                .collect(),
        ),
        Kind::Tagged { variants, .. } => union(
            variants
                .iter()
                .map(|(_, variant)| type_of(variant, indent))
                .collect(),
        ),
        Kind::Not(_) => "unknown".to_owned(),
        Kind::AllOf(parts) => parts
            .iter()
            .map(|part| type_of(part, indent))
            .collect::<Vec<_>>()
            .join(" & "),
        Kind::Ref(name) => name.clone(),
    }
}

/// One `export type` declaration per definition, in the order the definitions were reached. The types describe the
/// values a document holds once it has been validated: an object that is not closed has an index signature, and a
/// field that may be absent is optional.
pub fn typescript_declarations(definitions: &Definitions) -> String {
    let mut text = String::new();
    for (name, shape) in definitions.iter() {
        if let Some(description) = &shape.description {
            text.push_str(&comment(description, ""));
        }
        text.push_str(&format!("export type {name} = {};\n", type_of(shape, "")));
    }
    text
}
