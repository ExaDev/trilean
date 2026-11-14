//! The names `#[serde(rename_all = ...)]` gives are the names serde itself gives: each rule is applied by serde's
//! own derive to the same identifiers, and the keys the shape derives must be the ones it serialises.

#![allow(
    non_camel_case_types,
    non_snake_case,
    dead_code,
    clippy::upper_case_acronyms,
    reason = "the identifiers are chosen to be awkward for a renaming rule, and no code reads the types' fields"
)]

use json_shape::{Kind, Shape, Value};
use serde::Serialize;

macro_rules! rule {
    ($module:ident, $rule:literal) => {
        mod $module {
            use super::*;

            #[derive(Serialize, Shape, Clone, Copy)]
            #[serde(rename_all = $rule)]
            pub enum Variants {
                HTTPServer,
                Utf8Bom,
                A,
                RegexParse,
                V2Api,
                XmlToJson,
                ABC,
                Snake_Case,
                Already,
                Trailing2,
            }

            pub const ALL: [Variants; 10] = [
                Variants::HTTPServer,
                Variants::Utf8Bom,
                Variants::A,
                Variants::RegexParse,
                Variants::V2Api,
                Variants::XmlToJson,
                Variants::ABC,
                Variants::Snake_Case,
                Variants::Already,
                Variants::Trailing2,
            ];

            #[derive(Serialize, Shape)]
            #[serde(rename_all = $rule)]
            pub struct Fields {
                pub code_unit: u8,
                pub x_1_y: u8,
                pub http_server: u8,
                pub a__b: u8,
                pub _leading: u8,
                pub trailing_: u8,
                pub already: u8,
                pub v2_api: u8,
                pub a: u8,
                pub abc: u8,
                pub Mixed_Case: u8,
            }

            pub const FIELDS: Fields = Fields {
                code_unit: 0,
                x_1_y: 0,
                http_server: 0,
                a__b: 0,
                _leading: 0,
                trailing_: 0,
                already: 0,
                v2_api: 0,
                a: 0,
                abc: 0,
                Mixed_Case: 0,
            };
        }
    };
}

rule!(lowercase, "lowercase");
rule!(uppercase, "UPPERCASE");
rule!(pascal, "PascalCase");
rule!(camel, "camelCase");
rule!(snake, "snake_case");
rule!(screaming_snake, "SCREAMING_SNAKE_CASE");
rule!(kebab, "kebab-case");
rule!(screaming_kebab, "SCREAMING-KEBAB-CASE");

fn ordered(text: &str) -> Value {
    serde_json::from_str(text).expect("serde writes JSON")
}

/// The names serde writes for each variant, in order.
fn serde_variant_names<T: Serialize>(all: &[T]) -> Vec<String> {
    all.iter()
        .map(|variant| {
            serde_json::from_str::<String>(&serde_json::to_string(variant).expect("JSON"))
                .expect("a string")
        })
        .collect()
}

/// The keys serde writes for a struct, in order.
fn serde_field_names<T: Serialize>(value: &T) -> Vec<String> {
    let document = ordered(&serde_json::to_string(value).expect("JSON"));
    document
        .as_object()
        .expect("an object")
        .iter()
        .map(|(key, _)| key.clone())
        .collect()
}

fn shape_variant_names<T: Shape>() -> Vec<String> {
    match T::definition().kind {
        Kind::Enum(options) => options,
        other => panic!("not an enum: {other:?}"),
    }
}

fn shape_field_names<T: Shape>() -> Vec<String> {
    match T::definition().kind {
        Kind::Object(object) => object.fields.into_iter().map(|field| field.name).collect(),
        other => panic!("not an object: {other:?}"),
    }
}

macro_rules! agree {
    ($($module:ident),*) => {
        #[test]
        fn variant_names_are_the_names_serde_writes() {
            $(assert_eq!(
                shape_variant_names::<$module::Variants>(),
                serde_variant_names(&$module::ALL),
                "{}", stringify!($module)
            );)*
        }

        #[test]
        fn field_names_are_the_names_serde_writes() {
            $(assert_eq!(
                shape_field_names::<$module::Fields>(),
                serde_field_names(&$module::FIELDS),
                "{}", stringify!($module)
            );)*
        }
    };
}

agree!(
    lowercase,
    uppercase,
    pascal,
    camel,
    snake,
    screaming_snake,
    kebab,
    screaming_kebab
);
