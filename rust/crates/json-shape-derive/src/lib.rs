//! `#[derive(Shape)]` for the `json-shape` crate.
//!
//! The derive reads the serde attributes a type already carries, so one declaration serves serde and the shape:
//! `tag`, `untagged`, `rename`, `rename_all`, `deny_unknown_fields`, `default` and `flatten`, plus
//! `skip_serializing_if`, which only affects how a value is written and so is accepted and ignored. The shape adds
//! `#[shape(...)]` for what serde cannot say.
//!
//! On a container: `strict` (the same as `deny_unknown_fields`), `name = "..."` (the definition name, which is the
//! type's identifier otherwise), `together(a, b)` (each named field requires the others) and `min_properties = n`.
//! On a field, a tuple variant's field, and a variant of an untagged enum: `min = n`, `max = n`, `min_length = n`,
//! `min_items = n`, `max_items = n`, `unique_items`, `min_properties = n`, `pattern = "..."`,
//! `property_names = "..."` (a pattern the keys of a map match) and `constant = true` or `constant = "text"`. Doc
//! comments become descriptions.
//!
//! Supported types: a struct with named fields (an object), an enum of unit variants (a string enum), an enum with
//! `#[serde(tag = "...")]` whose variants are unit, struct or newtype variants over a struct (an internally tagged
//! union), and an enum with `#[serde(untagged)]` whose variants are struct or newtype variants, and at most one unit
//! variant, which is `null` (a union that matches exactly one). Anything else, any attribute that is not read at
//! the position it is written, and any generic parameter is a compile error that names it. A constraint on a type
//! it does not apply to, a flattened or tagged newtype field that is not a struct, a pattern outside the supported
//! subset and a property key used twice are compile errors too.

use std::collections::BTreeSet;

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{quote, quote_spanned};
use syn::ext::IdentExt;
use syn::spanned::Spanned;
use syn::{
    Attribute, Data, DeriveInput, Expr, ExprLit, ExprUnary, Fields, FieldsNamed, Ident, Lit,
    LitStr, Meta, Token, Type, UnOp, Variant, parse_macro_input,
};

// The one source of the pattern grammar: json-shape includes this file too, so the derive and the validator cannot
// disagree about which patterns exist. The derive only compiles patterns, never matches with them.
#[allow(
    dead_code,
    reason = "the derive compiles patterns and never matches with them, which json-shape, including this file too, does"
)]
#[path = "../../json-shape/src/pattern.rs"]
mod pattern;

#[proc_macro_derive(Shape, attributes(shape, serde))]
pub fn derive_shape(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    expand(&input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

type Result<T> = syn::Result<T>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Case {
    Lower,
    Upper,
    Camel,
    Pascal,
    Snake,
    ScreamingSnake,
    Kebab,
    ScreamingKebab,
}

fn parse_case(text: &LitStr) -> Result<Case> {
    match text.value().as_str() {
        "lowercase" => Ok(Case::Lower),
        "UPPERCASE" => Ok(Case::Upper),
        "camelCase" => Ok(Case::Camel),
        "PascalCase" => Ok(Case::Pascal),
        "snake_case" => Ok(Case::Snake),
        "SCREAMING_SNAKE_CASE" => Ok(Case::ScreamingSnake),
        "kebab-case" => Ok(Case::Kebab),
        "SCREAMING-KEBAB-CASE" => Ok(Case::ScreamingKebab),
        other => Err(syn::Error::new(
            text.span(),
            format!("rename_all = \"{other}\" is not supported by json_shape::Shape"),
        )),
    }
}

/// The name of a variant (written in PascalCase) under a `rename_all` rule, as serde writes it.
fn variant_name(name: &str, case: Option<Case>) -> String {
    fn snake(name: &str) -> String {
        let mut snake = String::new();
        for (position, letter) in name.char_indices() {
            if position > 0 && letter.is_uppercase() {
                snake.push('_');
            }
            snake.push(letter.to_ascii_lowercase());
        }
        snake
    }
    match case {
        None | Some(Case::Pascal) => name.to_owned(),
        Some(Case::Lower) => name.to_ascii_lowercase(),
        Some(Case::Upper) => name.to_ascii_uppercase(),
        Some(Case::Camel) => name[..1].to_ascii_lowercase() + &name[1..],
        Some(Case::Snake) => snake(name),
        Some(Case::ScreamingSnake) => snake(name).to_ascii_uppercase(),
        Some(Case::Kebab) => snake(name).replace('_', "-"),
        Some(Case::ScreamingKebab) => snake(name).to_ascii_uppercase().replace('_', "-"),
    }
}

/// The name of a field (written in snake_case) under a `rename_all` rule, as serde writes it.
fn field_name(name: &str, case: Option<Case>) -> String {
    fn pascal(name: &str) -> String {
        let mut pascal = String::new();
        let mut capitalise = true;
        for letter in name.chars() {
            if letter == '_' {
                capitalise = true;
            } else if capitalise {
                pascal.push(letter.to_ascii_uppercase());
                capitalise = false;
            } else {
                pascal.push(letter);
            }
        }
        pascal
    }
    match case {
        None | Some(Case::Snake) => name.to_owned(),
        Some(Case::Lower) => name.to_ascii_lowercase(),
        Some(Case::Upper | Case::ScreamingSnake) => name.to_ascii_uppercase(),
        Some(Case::Pascal) => pascal(name),
        Some(Case::Camel) => {
            let pascal = pascal(name);
            if pascal.is_empty() {
                pascal
            } else {
                pascal[..1].to_ascii_lowercase() + &pascal[1..]
            }
        }
        Some(Case::Kebab) => name.replace('_', "-"),
        Some(Case::ScreamingKebab) => name.to_ascii_uppercase().replace('_', "-"),
    }
}

fn name_of(ident: &Ident) -> String {
    ident.unraw().to_string()
}

/// The doc comment of an item as one line, or none when it has no text.
fn description(attributes: &[Attribute]) -> Option<String> {
    let lines: Vec<String> = attributes
        .iter()
        .filter(|attribute| attribute.path().is_ident("doc"))
        .filter_map(|attribute| match &attribute.meta {
            Meta::NameValue(pair) => match &pair.value {
                Expr::Lit(ExprLit {
                    lit: Lit::Str(text),
                    ..
                }) => Some(text.value().trim().to_owned()),
                _ => None,
            },
            _ => None,
        })
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join(" "))
    }
}

/// Where an attribute is written, which decides which keys it may hold.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Position {
    Container,
    Variant,
    Field,
    TupleField,
}

impl Position {
    fn describe(self) -> &'static str {
        match self {
            Position::Container => "a struct or enum",
            Position::Variant => "a variant",
            Position::Field => "a named field",
            Position::TupleField => "the field of a tuple variant",
        }
    }
}

/// A constraint a `#[shape(...)]` attribute adds, with the classes of type it may apply to.
#[derive(Clone)]
enum Spec {
    Min(f64),
    Max(f64),
    MinLength(usize),
    Pattern(String),
    MinItems(usize),
    MaxItems(usize),
    UniqueItems,
    MinProperties(usize),
    KeyPattern(String),
}

impl Spec {
    fn name(&self) -> &'static str {
        match self {
            Spec::Min(_) => "min",
            Spec::Max(_) => "max",
            Spec::MinLength(_) => "min_length",
            Spec::Pattern(_) => "pattern",
            Spec::MinItems(_) => "min_items",
            Spec::MaxItems(_) => "max_items",
            Spec::UniqueItems => "unique_items",
            Spec::MinProperties(_) => "min_properties",
            Spec::KeyPattern(_) => "property_names",
        }
    }

    /// The `Class` variants a type may have for this constraint to apply to it.
    fn classes(&self) -> &'static [&'static str] {
        match self {
            Spec::Min(_) | Spec::Max(_) => &["Integer", "Number"],
            Spec::MinLength(_) | Spec::Pattern(_) => &["String"],
            Spec::MinItems(_) | Spec::MaxItems(_) | Spec::UniqueItems => &["Array"],
            Spec::MinProperties(_) => &["Map", "OpenObject"],
            Spec::KeyPattern(_) => &["Map"],
        }
    }

    fn tokens(&self) -> TokenStream2 {
        match self {
            Spec::Min(bound) => quote! { ::json_shape::Constraint::Min(#bound) },
            Spec::Max(bound) => quote! { ::json_shape::Constraint::Max(#bound) },
            Spec::MinLength(length) => quote! { ::json_shape::Constraint::MinLength(#length) },
            Spec::Pattern(source) => {
                quote! { ::json_shape::Constraint::Pattern(#source.to_owned()) }
            }
            Spec::MinItems(count) => quote! { ::json_shape::Constraint::MinItems(#count) },
            Spec::MaxItems(count) => quote! { ::json_shape::Constraint::MaxItems(#count) },
            Spec::UniqueItems => quote! { ::json_shape::Constraint::UniqueItems },
            Spec::MinProperties(count) => {
                quote! { ::json_shape::Constraint::MinProperties(#count) }
            }
            Spec::KeyPattern(source) => {
                quote! { ::json_shape::Constraint::KeyPattern(#source.to_owned()) }
            }
        }
    }
}

#[derive(Clone)]
struct Constrained {
    span: Span,
    spec: Spec,
}

/// A constant and where it was written.
type Located = (Span, Constant);

#[derive(Clone)]
enum Constant {
    Bool(bool),
    Text(String),
}

/// Everything a `serde` or `shape` attribute can say at any position. Which keys a position may hold is checked
/// once, in [`read`], and nothing outside it reads an attribute.
#[derive(Default)]
struct Attrs {
    tag: Option<String>,
    untagged: bool,
    rename_all: Option<Case>,
    strict: bool,
    name: Option<String>,
    together: Vec<(Span, Vec<Ident>)>,
    container_min_properties: Option<usize>,
    rename: Option<String>,
    default: bool,
    flatten: bool,
    constraints: Vec<Constrained>,
    constant: Option<Located>,
}

fn number_of(expression: &Expr) -> Result<f64> {
    match expression {
        Expr::Lit(ExprLit {
            lit: Lit::Int(number),
            ..
        }) => number.base10_parse(),
        Expr::Lit(ExprLit {
            lit: Lit::Float(number),
            ..
        }) => number.base10_parse(),
        Expr::Unary(ExprUnary {
            op: UnOp::Neg(_),
            expr,
            ..
        }) => number_of(expr).map(|number| -number),
        other => Err(syn::Error::new(other.span(), "expected a number")),
    }
}

fn count_of(literal: &Lit) -> Result<usize> {
    match literal {
        Lit::Int(number) => number.base10_parse(),
        other => Err(syn::Error::new(other.span(), "expected a whole number")),
    }
}

/// A pattern literal, refused here when the validator could not compile it.
fn pattern_of(literal: &LitStr) -> Result<String> {
    let source = literal.value();
    pattern::Pattern::new(&source)
        .map_err(|error| syn::Error::new(literal.span(), error.to_string()))?;
    Ok(source)
}

/// Reads every `serde` and `shape` attribute of one syntactic position. Every key is read here or is an error, so an
/// attribute can neither be ignored where it was written by mistake nor given twice.
fn read(attributes: &[Attribute], position: Position) -> Result<Attrs> {
    let mut attrs = Attrs::default();
    let mut seen = BTreeSet::new();
    for attribute in attributes {
        let from_serde = attribute.path().is_ident("serde");
        if !from_serde && !attribute.path().is_ident("shape") {
            continue;
        }
        attribute.parse_nested_meta(|meta| {
            let Some(ident) = meta.path.get_ident() else {
                return Err(meta.error("expected an attribute name"));
            };
            let key = name_of(ident);
            let source = if from_serde { "serde" } else { "shape" };
            if key != "together" && !seen.insert(format!("{source}:{key}")) {
                return Err(meta.error(format!("`{key}` is given twice")));
            }
            let span = meta.path.span();
            let applies_to = |positions: &[Position]| -> Result<()> {
                if positions.contains(&position) {
                    Ok(())
                } else {
                    Err(meta.error(format!("`{key}` does not apply to {}", position.describe())))
                }
            };
            let constrained = |spec: Spec| Constrained { span, spec };
            let on_member = [Position::Variant, Position::Field, Position::TupleField];
            if from_serde {
                match key.as_str() {
                    "tag" => {
                        applies_to(&[Position::Container])?;
                        attrs.tag = Some(meta.value()?.parse::<LitStr>()?.value());
                    }
                    "untagged" => {
                        applies_to(&[Position::Container])?;
                        attrs.untagged = true;
                    }
                    "rename_all" => {
                        applies_to(&[Position::Container])?;
                        attrs.rename_all = Some(parse_case(&meta.value()?.parse::<LitStr>()?)?);
                    }
                    "deny_unknown_fields" => {
                        applies_to(&[Position::Container])?;
                        attrs.strict = true;
                    }
                    "rename" => {
                        applies_to(&[Position::Variant, Position::Field])?;
                        attrs.rename = Some(meta.value()?.parse::<LitStr>()?.value());
                    }
                    "default" => {
                        applies_to(&[Position::Field])?;
                        if meta.input.peek(Token![=]) {
                            return Err(meta.error("default = \"path\" is not supported; use a type that implements Default"));
                        }
                        attrs.default = true;
                    }
                    "flatten" => {
                        applies_to(&[Position::Field])?;
                        attrs.flatten = true;
                    }
                    "skip_serializing_if" => {
                        applies_to(&[Position::Field])?;
                        meta.value()?.parse::<LitStr>()?;
                    }
                    _ => return Err(meta.error(format!("the serde attribute `{key}` is not supported by json_shape::Shape"))),
                }
                return Ok(());
            }
            match key.as_str() {
                "strict" => {
                    applies_to(&[Position::Container])?;
                    attrs.strict = true;
                }
                "name" => {
                    applies_to(&[Position::Container])?;
                    attrs.name = Some(meta.value()?.parse::<LitStr>()?.value());
                }
                "together" => {
                    applies_to(&[Position::Container])?;
                    let mut names = Vec::new();
                    meta.parse_nested_meta(|inner| {
                        let ident = inner
                            .path
                            .get_ident()
                            .ok_or_else(|| inner.error("expected a field name"))?;
                        names.push(ident.clone());
                        Ok(())
                    })?;
                    attrs.together.push((span, names));
                }
                "min_properties" if position == Position::Container => {
                    attrs.container_min_properties = Some(count_of(&meta.value()?.parse::<Lit>()?)?);
                }
                "min_properties" => {
                    applies_to(&on_member)?;
                    let count = count_of(&meta.value()?.parse::<Lit>()?)?;
                    attrs.constraints.push(constrained(Spec::MinProperties(count)));
                }
                "min" | "max" => {
                    applies_to(&on_member)?;
                    let bound = number_of(&meta.value()?.parse::<Expr>()?)?;
                    attrs
                        .constraints
                        .push(constrained(if key == "min" { Spec::Min(bound) } else { Spec::Max(bound) }));
                }
                "min_length" | "min_items" | "max_items" => {
                    applies_to(&on_member)?;
                    let count = count_of(&meta.value()?.parse::<Lit>()?)?;
                    attrs.constraints.push(constrained(match key.as_str() {
                        "min_length" => Spec::MinLength(count),
                        "min_items" => Spec::MinItems(count),
                        _ => Spec::MaxItems(count),
                    }));
                }
                "unique_items" => {
                    applies_to(&on_member)?;
                    attrs.constraints.push(constrained(Spec::UniqueItems));
                }
                "pattern" | "property_names" => {
                    applies_to(&on_member)?;
                    let source = pattern_of(&meta.value()?.parse::<LitStr>()?)?;
                    attrs.constraints.push(constrained(if key == "pattern" {
                        Spec::Pattern(source)
                    } else {
                        Spec::KeyPattern(source)
                    }));
                }
                "constant" => {
                    applies_to(&on_member)?;
                    attrs.constant = Some((
                        span,
                        match meta.value()?.parse::<Lit>()? {
                            Lit::Bool(flag) => Constant::Bool(flag.value),
                            Lit::Str(text) => Constant::Text(text.value()),
                            other => return Err(syn::Error::new(other.span(), "constant takes a boolean or a string")),
                        },
                    ));
                }
                _ => return Err(meta.error(format!("the `{key}` attribute is not supported by json_shape::Shape"))),
            }
            Ok(())
        })?;
    }
    Ok(attrs)
}

/// One named field with everything the generated code needs.
struct Member {
    ident: Ident,
    key: String,
    ty: Type,
    attrs: Attrs,
    description: Option<String>,
    span: Span,
}

fn members(fields: &FieldsNamed, rename_all: Option<Case>) -> Result<Vec<Member>> {
    let mut found = Vec::new();
    for field in &fields.named {
        let Some(ident) = &field.ident else {
            return Err(syn::Error::new(field.span(), "a field must be named"));
        };
        let attrs = read(&field.attrs, Position::Field)?;
        if attrs.flatten
            && (attrs.rename.is_some()
                || attrs.default
                || !attrs.constraints.is_empty()
                || attrs.constant.is_some())
        {
            return Err(syn::Error::new(
                ident.span(),
                "a flattened field takes no other attribute: its fields are the object's own",
            ));
        }
        let key = attrs
            .rename
            .clone()
            .unwrap_or_else(|| field_name(&name_of(ident), rename_all));
        found.push(Member {
            ident: ident.clone(),
            key,
            ty: field.ty.clone(),
            attrs,
            description: description(&field.attrs),
            span: field.span(),
        });
    }
    let mut keys = BTreeSet::new();
    for member in &found {
        if !member.attrs.flatten && !keys.insert(member.key.clone()) {
            return Err(syn::Error::new(
                member.ident.span(),
                format!("the key \"{}\" is used by two fields", member.key),
            ));
        }
    }
    Ok(found)
}

/// The compile-time assertions that a constraint or constant applies to the type it is written on.
fn constraint_assertions(
    ty: &Type,
    constraints: &[Constrained],
    constant: Option<&Located>,
) -> TokenStream2 {
    let mut assertions = Vec::new();
    for constrained in constraints {
        let classes: Vec<Ident> = constrained
            .spec
            .classes()
            .iter()
            .map(|class| Ident::new(class, constrained.span))
            .collect();
        let message = format!(
            "#[shape({})] applies only to a type whose shape is {}",
            constrained.spec.name(),
            constrained.spec.classes().join(" or ").to_lowercase()
        );
        assertions.push(quote_spanned! { constrained.span =>
            const _: () = ::core::assert!(
                ::json_shape::private::class_in(<#ty as ::json_shape::Shape>::CLASS, &[#(::json_shape::Class::#classes),*]),
                #message
            );
        });
    }
    if let Some((span, constant)) = constant {
        let (class, message) = match constant {
            Constant::Bool(_) => (
                "Bool",
                "#[shape(constant = true or false)] applies only to a boolean",
            ),
            Constant::Text(_) => (
                "String",
                "#[shape(constant = \"text\")] applies only to a string",
            ),
        };
        let class = Ident::new(class, *span);
        assertions.push(quote_spanned! { *span =>
            const _: () = ::core::assert!(
                ::json_shape::private::class_in(<#ty as ::json_shape::Shape>::CLASS, &[::json_shape::Class::#class]),
                #message
            );
        });
    }
    quote! { #(#assertions)* }
}

/// The key lists a duplicate-key assertion and the `KEYS` constant are built from: an optional leading key (the
/// tag), the own keys, then the keys of every flattened field.
fn key_parts(head: Option<&str>, members: &[Member]) -> Vec<TokenStream2> {
    let own: Vec<&String> = members
        .iter()
        .filter(|member| !member.attrs.flatten)
        .map(|member| &member.key)
        .collect();
    let mut parts = Vec::new();
    if let Some(tag) = head {
        parts.push(quote! { (&[#tag] as &[&str]) });
    }
    parts.push(quote! { (&[#(#own),*] as &[&str]) });
    for member in members.iter().filter(|member| member.attrs.flatten) {
        let ty = &member.ty;
        parts.push(quote! { <#ty as ::json_shape::Shape>::KEYS });
    }
    parts
}

fn member_assertions(members: &[Member]) -> TokenStream2 {
    let assertions = members.iter().map(|member| {
        let ty = &member.ty;
        if member.attrs.flatten {
            let span = member.span;
            quote_spanned! { span =>
                const _: () = ::core::assert!(
                    <#ty as ::json_shape::Shape>::IS_OBJECT,
                    "a flattened field must be a struct that derives Shape"
                );
            }
        } else {
            constraint_assertions(
                ty,
                &member.attrs.constraints,
                member.attrs.constant.as_ref(),
            )
        }
    });
    quote! { #(#assertions)* }
}

fn unique_keys_assertion(head: Option<&str>, members: &[Member], span: Span) -> TokenStream2 {
    let parts = key_parts(head, members);
    quote_spanned! { span =>
        const _: () = ::core::assert!(
            ::json_shape::private::keys_unique(&[#(#parts),*]),
            "a property key is used twice, counting the tag and the flattened fields"
        );
    }
}

/// Statements that push every field into `__fields` and `__dependent`.
fn fields_definition(members: &[Member]) -> TokenStream2 {
    let steps = members.iter().map(|member| {
        let ty = &member.ty;
        let key = &member.key;
        if member.attrs.flatten {
            return quote! {
                match <#ty as ::json_shape::Shape>::definition().kind {
                    ::json_shape::Kind::Object(__inner) => {
                        __fields.extend(__inner.fields);
                        __dependent.extend(__inner.dependent_required);
                    }
                    _ => ::core::unreachable!("a flattened field is checked to be a struct at compile time"),
                }
            };
        }
        let constraints: Vec<TokenStream2> = member
            .attrs
            .constraints
            .iter()
            .map(|constrained| constrained.spec.tokens())
            .collect();
        let described = member
            .description
            .as_ref()
            .map(|text| quote! { __shape = __shape.described(#text); });
        let constant = match &member.attrs.constant {
            Some((_, Constant::Bool(flag))) => Some(quote! { __shape = __shape.constant_bool(#flag); }),
            Some((_, Constant::Text(text))) => Some(quote! { __shape = __shape.constant_string(#text); }),
            None => None,
        };
        let optional = member.attrs.default;
        quote! {
            {
                let mut __shape = <#ty as ::json_shape::Shape>::reference();
                #( __shape = __shape.constrained(#constraints); )*
                #constant
                #described
                __fields.push(::json_shape::FieldDef {
                    name: #key.to_owned(),
                    shape: __shape,
                    required: !<#ty as ::json_shape::Shape>::OPTIONAL && !#optional,
                });
            }
        }
    });
    quote! { #(#steps)* }
}

/// An expression that is the `ObjectDef` of the members, after `fields_definition`'s statements.
fn object_definition(
    strict: bool,
    min_properties: Option<usize>,
    together: &[(Span, Vec<Ident>)],
    members: &[Member],
) -> Result<TokenStream2> {
    let mut groups = Vec::new();
    for (span, names) in together {
        let mut keys = Vec::new();
        for name in names {
            let Some(member) = members.iter().find(|member| member.ident == *name) else {
                return Err(syn::Error::new(
                    name.span(),
                    format!("together names {name}, which is not a field"),
                ));
            };
            keys.push(member.key.clone());
        }
        if keys.len() < 2 {
            return Err(syn::Error::new(*span, "together needs at least two fields"));
        }
        groups.push(keys);
    }
    let minimum = match min_properties {
        Some(count) => quote! { ::core::option::Option::Some(#count) },
        None => quote! { ::core::option::Option::None },
    };
    let together = groups.iter().map(|keys| {
        let entries = keys.iter().map(|key| {
            let others: Vec<&String> = keys.iter().filter(|other| *other != key).collect();
            quote! { __dependent.push((#key.to_owned(), vec![#(#others.to_owned()),*])); }
        });
        quote! { #(#entries)* }
    });
    Ok(quote! {
        {
            #(#together)*
            ::json_shape::ObjectDef {
                fields: __fields,
                closed: #strict,
                min_properties: #minimum,
                dependent_required: __dependent,
            }
        }
    })
}

/// The fields of a struct literal that read the members out of `__value`.
fn member_builds(members: &[Member]) -> Vec<TokenStream2> {
    members
        .iter()
        .map(|member| {
            let ident = &member.ident;
            let ty = &member.ty;
            let key = &member.key;
            if member.attrs.flatten {
                return quote! { #ident: <#ty as ::json_shape::Shape>::build(__value, __path)? };
            }
            let missing = if member.attrs.default {
                quote! { ::core::default::Default::default() }
            } else {
                quote! {
                    return ::core::result::Result::Err(::json_shape::Issues::at(
                        __path,
                        ::std::format!("missing the required property {}", #key),
                    ))
                }
            };
            quote! {
                #ident: match __value.get(#key) {
                    ::core::option::Option::Some(__entry) => {
                        __path.push_key(#key);
                        let __built = <#ty as ::json_shape::Shape>::build(__entry, __path);
                        __path.pop();
                        __built?
                    }
                    ::core::option::Option::None => match <#ty as ::json_shape::Shape>::absent() {
                        ::core::option::Option::Some(__absent) => __absent,
                        ::core::option::Option::None => #missing,
                    },
                }
            }
        })
        .collect()
}

fn member_registers(members: &[Member]) -> Vec<TokenStream2> {
    members
        .iter()
        .map(|member| {
            let ty = &member.ty;
            if member.attrs.flatten {
                quote! { <#ty as ::json_shape::Shape>::register_members(__registry); }
            } else {
                quote! { <#ty as ::json_shape::Shape>::register(__registry); }
            }
        })
        .collect()
}

/// A definition expression for a set of named fields, building an object shape.
fn object_shape(
    strict: bool,
    min_properties: Option<usize>,
    together: &[(Span, Vec<Ident>)],
    members: &[Member],
    doc: Option<&String>,
    head: Option<TokenStream2>,
) -> Result<TokenStream2> {
    let steps = fields_definition(members);
    let object = object_definition(strict, min_properties, together, members)?;
    let described = doc.map(|text| quote! { .described(#text) });
    Ok(quote! {
        {
            let mut __fields: ::std::vec::Vec<::json_shape::FieldDef> = ::std::vec::Vec::new();
            let mut __dependent: ::std::vec::Vec<(::std::string::String, ::std::vec::Vec<::std::string::String>)> =
                ::std::vec::Vec::new();
            #head
            #steps
            ::json_shape::ShapeDef::new(::json_shape::Kind::Object(#object)) #described
        }
    })
}

/// What an expansion produces beyond the shared parts.
struct Parts {
    definition: TokenStream2,
    register_members: TokenStream2,
    build: TokenStream2,
    constants: TokenStream2,
    assertions: TokenStream2,
}

fn expand(input: &DeriveInput) -> Result<TokenStream2> {
    if !input.generics.params.is_empty() {
        return Err(syn::Error::new(
            input.generics.span(),
            "json_shape::Shape does not support generic types",
        ));
    }
    let container = read(&input.attrs, Position::Container)?;
    let name = &input.ident;
    let label = container.name.clone().unwrap_or_else(|| name_of(name));
    let doc = description(&input.attrs);
    let parts = match &input.data {
        Data::Struct(data) => {
            let Fields::Named(fields) = &data.fields else {
                return Err(syn::Error::new(
                    input.span(),
                    "json_shape::Shape needs a struct with named fields",
                ));
            };
            if container.tag.is_some() || container.untagged {
                return Err(syn::Error::new(
                    input.span(),
                    "tag and untagged apply to enums",
                ));
            }
            expand_struct(&container, fields, doc.as_ref(), input.span())?
        }
        Data::Enum(data) => expand_enum(
            &container,
            doc.as_ref(),
            name,
            &data.variants.iter().collect::<Vec<_>>(),
        )?,
        Data::Union(_) => {
            return Err(syn::Error::new(
                input.span(),
                "json_shape::Shape does not support unions",
            ));
        }
    };
    let Parts {
        definition,
        register_members,
        build,
        constants,
        assertions,
    } = parts;
    Ok(quote! {
        #assertions

        impl ::json_shape::Shape for #name {
            #constants

            fn reference() -> ::json_shape::ShapeDef {
                ::json_shape::ShapeDef::new(::json_shape::Kind::Ref(#label.to_owned()))
            }

            fn definition() -> ::json_shape::ShapeDef {
                #definition
            }

            fn register(__registry: &mut ::json_shape::Registry) {
                if __registry.reserve(
                    #label,
                    ::std::any::TypeId::of::<Self>(),
                    ::std::any::type_name::<Self>(),
                ) {
                    __registry.define(#label, <Self as ::json_shape::Shape>::definition());
                    <Self as ::json_shape::Shape>::register_members(__registry);
                }
            }

            fn register_members(__registry: &mut ::json_shape::Registry) {
                #register_members
            }

            fn definitions() -> ::std::borrow::Cow<'static, ::json_shape::Definitions> {
                static DEFINITIONS: ::std::sync::OnceLock<::json_shape::Definitions> = ::std::sync::OnceLock::new();
                ::std::borrow::Cow::Borrowed(DEFINITIONS.get_or_init(::json_shape::Definitions::of::<Self>))
            }

            fn build(
                __value: &::json_shape::Value,
                __path: &mut ::json_shape::Path,
            ) -> ::core::result::Result<Self, ::json_shape::Issues> {
                #build
            }
        }

        impl<'de> ::json_shape::private::serde::Deserialize<'de> for #name {
            fn deserialize<D>(__deserializer: D) -> ::core::result::Result<Self, D::Error>
            where
                D: ::json_shape::private::serde::Deserializer<'de>,
            {
                let __value = <::json_shape::Value as ::json_shape::private::serde::Deserialize>::deserialize(
                    __deserializer,
                )?;
                <Self as ::json_shape::Shape>::from_json(&__value)
                    .map_err(<D::Error as ::json_shape::private::serde::de::Error>::custom)
            }
        }
    })
}

fn expand_struct(
    container: &Attrs,
    fields: &FieldsNamed,
    doc: Option<&String>,
    span: Span,
) -> Result<Parts> {
    let members = members(fields, container.rename_all)?;
    let definition = object_shape(
        container.strict,
        container.container_min_properties,
        &container.together,
        &members,
        doc,
        None,
    )?;
    let registers = member_registers(&members);
    let builds = member_builds(&members);
    let parts = key_parts(None, &members);
    let own = members
        .iter()
        .filter(|member| !member.attrs.flatten)
        .count();
    let flattened_lengths: Vec<TokenStream2> = members
        .iter()
        .filter(|member| member.attrs.flatten)
        .map(|member| {
            let ty = &member.ty;
            quote! { <#ty as ::json_shape::Shape>::KEYS.len() }
        })
        .collect();
    let mut assertions = vec![
        member_assertions(&members),
        unique_keys_assertion(None, &members, span),
    ];
    assertions.retain(|assertion| !assertion.is_empty());
    Ok(Parts {
        definition,
        register_members: quote! { #(#registers)* },
        build: quote! { ::core::result::Result::Ok(Self { #(#builds),* }) },
        constants: quote! {
            const CLASS: ::json_shape::Class = ::json_shape::Class::Named;
            const IS_OBJECT: bool = true;
            const KEYS: &'static [&'static str] = {
                const LENGTH: usize = #own #( + #flattened_lengths )*;
                const JOINED: [&'static str; LENGTH] = ::json_shape::private::concat_keys::<LENGTH>(&[#(#parts),*]);
                &JOINED
            };
        },
        assertions: quote! { #(#assertions)* },
    })
}

/// The key of a variant, and the attributes of the variant and of its tuple field.
struct VariantInfo<'a> {
    variant: &'a Variant,
    key: String,
    attrs: Attrs,
    description: Option<String>,
}

fn variant_info<'a>(variant: &'a Variant, rename_all: Option<Case>) -> Result<VariantInfo<'a>> {
    let attrs = read(&variant.attrs, Position::Variant)?;
    let key = attrs
        .rename
        .clone()
        .unwrap_or_else(|| variant_name(&name_of(&variant.ident), rename_all));
    Ok(VariantInfo {
        variant,
        key,
        attrs,
        description: description(&variant.attrs),
    })
}

/// The type of a newtype variant and the attributes written on its field.
fn newtype(variant: &Variant) -> Result<Option<(&Type, Attrs)>> {
    match &variant.fields {
        Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
            let field = &fields.unnamed[0];
            Ok(Some((&field.ty, read(&field.attrs, Position::TupleField)?)))
        }
        Fields::Unnamed(_) => Err(syn::Error::new(
            variant.span(),
            "a tuple variant must hold exactly one field",
        )),
        _ => Ok(None),
    }
}

/// The constraints written on a variant and on its tuple field, which together describe the newtype's type.
fn newtype_constraints(
    info: &VariantInfo<'_>,
    field: &Attrs,
) -> Result<(Vec<Constrained>, Option<Located>)> {
    let mut constraints = info.attrs.constraints.clone();
    for constrained in &field.constraints {
        if constraints
            .iter()
            .any(|known| known.spec.name() == constrained.spec.name())
        {
            return Err(syn::Error::new(
                constrained.span,
                format!("`{}` is given twice", constrained.spec.name()),
            ));
        }
        constraints.push(constrained.clone());
    }
    if info.attrs.constant.is_some() && field.constant.is_some() {
        return Err(syn::Error::new(
            info.variant.span(),
            "`constant` is given twice",
        ));
    }
    Ok((
        constraints,
        info.attrs
            .constant
            .clone()
            .or_else(|| field.constant.clone()),
    ))
}

/// The shape of one variant of a tagged enum, as an object holding the tag as a constant.
fn tagged_variant(
    info: &VariantInfo<'_>,
    tag: &str,
    strict: bool,
    parts: &mut VariantParts,
) -> Result<TokenStream2> {
    let span = info.variant.span();
    let info_key = &info.key;
    let tag_field = quote! {
        __fields.push(::json_shape::FieldDef {
            name: #tag.to_owned(),
            shape: ::json_shape::ShapeDef::new(::json_shape::Kind::ConstString(#info_key.to_owned())),
            required: true,
        });
    };
    let doc = info.description.as_ref();
    match &info.variant.fields {
        Fields::Unit => {
            let described = doc.map(|text| quote! { .described(#text) });
            Ok(quote! {
                {
                    let mut __fields: ::std::vec::Vec<::json_shape::FieldDef> = ::std::vec::Vec::new();
                    #tag_field
                    ::json_shape::ShapeDef::new(::json_shape::Kind::Object(::json_shape::ObjectDef {
                        fields: __fields,
                        closed: #strict,
                        min_properties: ::core::option::Option::None,
                        dependent_required: ::std::vec::Vec::new(),
                    })) #described
                }
            })
        }
        Fields::Named(fields) => {
            let members = members(fields, None)?;
            parts.assertions.push(member_assertions(&members));
            parts
                .assertions
                .push(unique_keys_assertion(Some(tag), &members, span));
            parts.registers.extend(member_registers(&members));
            object_shape(strict, None, &[], &members, doc, Some(tag_field))
        }
        Fields::Unnamed(_) => {
            let Some((ty, field)) = newtype(info.variant)? else {
                return Err(syn::Error::new(span, "unreachable"));
            };
            if !info.attrs.constraints.is_empty()
                || info.attrs.constant.is_some()
                || !field.constraints.is_empty()
                || field.constant.is_some()
            {
                return Err(syn::Error::new(
                    span,
                    "no constraint applies to a newtype variant of a tagged enum: its struct carries its own",
                ));
            }
            parts.assertions.push(quote_spanned! { span =>
                const _: () = ::core::assert!(
                    <#ty as ::json_shape::Shape>::IS_OBJECT,
                    "a newtype variant of a tagged enum must hold a struct that derives Shape"
                );
                const _: () = ::core::assert!(
                    ::json_shape::private::keys_unique(&[(&[#tag] as &[&str]), <#ty as ::json_shape::Shape>::KEYS]),
                    "a property key is used twice, counting the tag and the flattened fields"
                );
            });
            parts
                .registers
                .push(quote! { <#ty as ::json_shape::Shape>::register_members(__registry); });
            let described = doc.map(|text| quote! { __shape = __shape.described(#text); });
            Ok(quote! {
                {
                    let mut __shape = <#ty as ::json_shape::Shape>::definition();
                    match &mut __shape.kind {
                        ::json_shape::Kind::Object(__object) => {
                            __object.closed = __object.closed || #strict;
                            let __rest = ::std::mem::take(&mut __object.fields);
                            let mut __fields: ::std::vec::Vec<::json_shape::FieldDef> = ::std::vec::Vec::new();
                            #tag_field
                            __fields.extend(__rest);
                            __object.fields = __fields;
                        }
                        _ => ::core::unreachable!("a newtype variant is checked to hold a struct at compile time"),
                    }
                    #described
                    __shape
                }
            })
        }
    }
}

#[derive(Default)]
struct VariantParts {
    registers: Vec<TokenStream2>,
    assertions: Vec<TokenStream2>,
}

/// The definition, member registration and build expression of an enum.
fn expand_enum(
    container: &Attrs,
    doc: Option<&String>,
    name: &Ident,
    variants: &[&Variant],
) -> Result<Parts> {
    let described = doc.map(|text| quote! { .described(#text) });
    if !container.together.is_empty() || container.container_min_properties.is_some() {
        return Err(syn::Error::new(
            name.span(),
            "together and min_properties describe one object, so they apply to structs",
        ));
    }
    if variants.is_empty() {
        return Err(syn::Error::new(
            name.span(),
            "an enum needs at least one variant",
        ));
    }
    if container.tag.is_some() && container.untagged {
        return Err(syn::Error::new(
            name.span(),
            "tag and untagged cannot be combined",
        ));
    }
    let mut infos = Vec::new();
    let mut keys = BTreeSet::new();
    for variant in variants {
        let info = variant_info(variant, container.rename_all)?;
        if !keys.insert(info.key.clone()) {
            return Err(syn::Error::new(
                variant.span(),
                format!("the variant key \"{}\" is used twice", info.key),
            ));
        }
        infos.push(info);
    }
    let constants = quote! {
        const CLASS: ::json_shape::Class = ::json_shape::Class::Named;
    };
    let all_unit = variants
        .iter()
        .all(|variant| matches!(variant.fields, Fields::Unit));
    if all_unit && container.tag.is_none() && !container.untagged {
        for info in &infos {
            if !info.attrs.constraints.is_empty() || info.attrs.constant.is_some() {
                return Err(syn::Error::new(
                    info.variant.span(),
                    "no constraint applies to a unit variant",
                ));
            }
        }
        let idents: Vec<&Ident> = variants.iter().map(|variant| &variant.ident).collect();
        let texts: Vec<&String> = infos.iter().map(|info| &info.key).collect();
        return Ok(Parts {
            definition: quote! {
                ::json_shape::ShapeDef::new(::json_shape::Kind::Enum(::std::vec![#(#texts.to_owned()),*])) #described
            },
            register_members: quote! {},
            build: quote! {
                match __value.as_str() {
                    #( ::core::option::Option::Some(#texts) => ::core::result::Result::Ok(Self::#idents), )*
                    _ => ::core::result::Result::Err(::json_shape::Issues::at(__path, "not one of the variants")),
                }
            },
            constants,
            assertions: quote! {},
        });
    }
    let mut parts = VariantParts::default();
    if let Some(tag) = &container.tag {
        let mut definitions = Vec::new();
        let mut arms = Vec::new();
        for info in &infos {
            if !info.attrs.constraints.is_empty() || info.attrs.constant.is_some() {
                return Err(syn::Error::new(
                    info.variant.span(),
                    "#[shape] constraints on a variant apply only to a newtype variant of an untagged enum",
                ));
            }
            definitions.push(tagged_variant(info, tag, container.strict, &mut parts)?);
            let (ident, key) = (&info.variant.ident, &info.key);
            match &info.variant.fields {
                Fields::Unit => {
                    arms.push(quote! { #key => ::core::result::Result::Ok(Self::#ident), })
                }
                Fields::Named(fields) => {
                    let members = members(fields, None)?;
                    let builds = member_builds(&members);
                    arms.push(quote! { #key => ::core::result::Result::Ok(Self::#ident { #(#builds),* }), });
                }
                Fields::Unnamed(_) => {
                    let Some((ty, _)) = newtype(info.variant)? else {
                        return Err(syn::Error::new(info.variant.span(), "unreachable"));
                    };
                    arms.push(quote! {
                        #key => <#ty as ::json_shape::Shape>::build(__value, __path).map(Self::#ident),
                    });
                }
            }
        }
        let keys: Vec<&String> = infos.iter().map(|info| &info.key).collect();
        let registers = &parts.registers;
        let assertions = &parts.assertions;
        return Ok(Parts {
            definition: quote! {
                ::json_shape::ShapeDef::new(::json_shape::Kind::Tagged {
                    tag: #tag.to_owned(),
                    variants: ::std::vec![#( (#keys.to_owned(), #definitions) ),*],
                }) #described
            },
            register_members: quote! { #(#registers)* },
            build: quote! {
                let ::core::option::Option::Some(__kind) = __value.get(#tag).and_then(::json_shape::Value::as_str) else {
                    return ::core::result::Result::Err(::json_shape::Issues::at(__path, "expected a string naming the kind"));
                };
                match __kind {
                    #(#arms)*
                    _ => ::core::result::Result::Err(::json_shape::Issues::at(__path, "not a known kind")),
                }
            },
            constants,
            assertions: quote! { #(#assertions)* },
        });
    }
    if container.untagged {
        let units = variants
            .iter()
            .filter(|variant| matches!(variant.fields, Fields::Unit))
            .count();
        if units > 1 {
            return Err(syn::Error::new(
                name.span(),
                "an untagged enum can have one unit variant, which is null: with two, null matches both",
            ));
        }
        let mut alternatives = Vec::new();
        let mut arms = Vec::new();
        for (position, info) in infos.iter().enumerate() {
            let (ident, doc) = (&info.variant.ident, info.description.as_ref());
            let described = doc.map(|text| quote! { .described(#text) });
            match &info.variant.fields {
                Fields::Unit => {
                    if !info.attrs.constraints.is_empty() || info.attrs.constant.is_some() {
                        return Err(syn::Error::new(
                            info.variant.span(),
                            "no constraint applies to a unit variant",
                        ));
                    }
                    alternatives.push(
                        quote! { ::json_shape::ShapeDef::new(::json_shape::Kind::Null) #described },
                    );
                    arms.push(quote! { #position => ::core::result::Result::Ok(Self::#ident), });
                }
                Fields::Named(fields) => {
                    if !info.attrs.constraints.is_empty() || info.attrs.constant.is_some() {
                        return Err(syn::Error::new(
                            info.variant.span(),
                            "#[shape] constraints on a variant apply only to a newtype variant",
                        ));
                    }
                    let members = members(fields, None)?;
                    parts.assertions.push(member_assertions(&members));
                    parts.assertions.push(unique_keys_assertion(
                        None,
                        &members,
                        info.variant.span(),
                    ));
                    parts.registers.extend(member_registers(&members));
                    alternatives.push(object_shape(
                        container.strict,
                        None,
                        &[],
                        &members,
                        doc,
                        None,
                    )?);
                    let builds = member_builds(&members);
                    arms.push(quote! { #position => ::core::result::Result::Ok(Self::#ident { #(#builds),* }), });
                }
                Fields::Unnamed(_) => {
                    let Some((ty, field)) = newtype(info.variant)? else {
                        return Err(syn::Error::new(info.variant.span(), "unreachable"));
                    };
                    let (constraints, constant) = newtype_constraints(info, &field)?;
                    parts.assertions.push(constraint_assertions(
                        ty,
                        &constraints,
                        constant.as_ref(),
                    ));
                    let tokens: Vec<TokenStream2> = constraints
                        .iter()
                        .map(|constrained| constrained.spec.tokens())
                        .collect();
                    let constant = match constant {
                        Some((_, Constant::Bool(flag))) => {
                            Some(quote! { __shape = __shape.constant_bool(#flag); })
                        }
                        Some((_, Constant::Text(text))) => {
                            Some(quote! { __shape = __shape.constant_string(#text); })
                        }
                        None => None,
                    };
                    alternatives.push(quote! {
                        {
                            let mut __shape = <#ty as ::json_shape::Shape>::reference();
                            #( __shape = __shape.constrained(#tokens); )*
                            #constant
                            __shape #described
                        }
                    });
                    parts
                        .registers
                        .push(quote! { <#ty as ::json_shape::Shape>::register(__registry); });
                    arms.push(quote! {
                        #position => <#ty as ::json_shape::Shape>::build(__value, __path).map(Self::#ident),
                    });
                }
            }
        }
        let registers = &parts.registers;
        let assertions = &parts.assertions;
        return Ok(Parts {
            definition: quote! {
                ::json_shape::ShapeDef::new(::json_shape::Kind::OneOf(::std::vec![#(#alternatives),*])) #described
            },
            register_members: quote! { #(#registers)* },
            build: quote! {
                static ALTERNATIVES: ::std::sync::OnceLock<::std::vec::Vec<::json_shape::ShapeDef>> =
                    ::std::sync::OnceLock::new();
                let __alternatives = ALTERNATIVES.get_or_init(|| match <Self as ::json_shape::Shape>::definition().kind {
                    ::json_shape::Kind::OneOf(__alternatives) => __alternatives,
                    _ => ::core::unreachable!("an untagged enum is a union"),
                });
                let __definitions = <Self as ::json_shape::Shape>::definitions();
                for (__index, __alternative) in __alternatives.iter().enumerate() {
                    if ::json_shape::private::decide(__path, &__definitions, __alternative, __value) {
                        return match __index {
                            #(#arms)*
                            _ => ::core::result::Result::Err(::json_shape::Issues::at(__path, "no such alternative")),
                        };
                    }
                }
                ::core::result::Result::Err(::json_shape::Issues::at(__path, "matches no alternative"))
            },
            constants,
            assertions: quote! { #(#assertions)* },
        });
    }
    Err(syn::Error::new(
        name.span(),
        "an enum with data needs #[serde(tag = \"...\")] or #[serde(untagged)]; json_shape::Shape does not support externally tagged enums",
    ))
}

#[cfg(test)]
mod tests {
    use syn::DeriveInput;

    use super::{Case, expand, field_name, variant_name};

    fn parse(source: &str) -> DeriveInput {
        syn::parse_str(source).unwrap_or_else(|error| panic!("{source}: {error}"))
    }

    fn refusal(source: &str) -> String {
        match expand(&parse(source)) {
            Ok(_) => panic!("{source} was accepted"),
            Err(error) => error.to_string(),
        }
    }

    #[test]
    fn every_position_refuses_what_it_does_not_read() {
        let cases = [
            // container
            (
                "#[shape(bogus)] struct A { a: u8 }",
                "the `bogus` attribute is not supported",
            ),
            (
                "#[shape(min = 1)] struct A { a: u8 }",
                "`min` does not apply to a struct or enum",
            ),
            (
                "#[serde(rename = \"X\")] struct A { a: u8 }",
                "`rename` does not apply to a struct or enum",
            ),
            (
                "#[serde(alias = \"X\")] struct A { a: u8 }",
                "the serde attribute `alias` is not supported",
            ),
            (
                "#[serde(rename_all = \"weird\")] struct A { a: u8 }",
                "rename_all = \"weird\" is not supported",
            ),
            (
                "#[serde(deny_unknown_fields, deny_unknown_fields)] struct A { a: u8 }",
                "`deny_unknown_fields` is given twice",
            ),
            (
                "#[serde(tag = \"k\")] struct A { a: u8 }",
                "tag and untagged apply to enums",
            ),
            (
                "#[shape(together(a))] struct A { a: u8 }",
                "together needs at least two fields",
            ),
            (
                "#[shape(together(a, z))] struct A { a: u8 }",
                "together names z, which is not a field",
            ),
            (
                "#[shape(together(a, b))] enum E { A { a: u8, b: u8 } }",
                "apply to structs",
            ),
            // named field
            (
                "struct A { #[shape(strict)] a: u8 }",
                "`strict` does not apply to a named field",
            ),
            (
                "struct A { #[serde(tag = \"x\")] a: u8 }",
                "`tag` does not apply to a named field",
            ),
            (
                "struct A { #[serde(alias = \"x\")] a: u8 }",
                "the serde attribute `alias` is not supported",
            ),
            (
                "struct A { #[serde(default = \"f\")] a: u8 }",
                "default = \"path\" is not supported",
            ),
            (
                "struct A { #[shape(min = 1, min = 2)] a: u8 }",
                "`min` is given twice",
            ),
            (
                "struct A { #[shape(constant = true)] #[shape(constant = false)] a: bool }",
                "`constant` is given twice",
            ),
            (
                "struct A { #[serde(rename = \"a\", rename = \"b\")] a: u8 }",
                "`rename` is given twice",
            ),
            (
                "struct A { #[shape(pattern = \"a{2}\")] a: String }",
                "is not supported",
            ),
            (
                "struct A { #[shape(property_names = \"(\")] a: u8 }",
                "a group is not closed",
            ),
            (
                "struct A { #[shape(constant = 1)] a: u8 }",
                "constant takes a boolean or a string",
            ),
            (
                "struct A { #[shape(min = \"x\")] a: u8 }",
                "expected a number",
            ),
            (
                "struct A { #[shape(zzz)] a: u8 }",
                "the `zzz` attribute is not supported",
            ),
            (
                "struct A { #[serde(flatten, rename = \"x\")] a: B }",
                "takes no other attribute",
            ),
            (
                "struct A { a: u8, #[serde(rename = \"a\")] b: u8 }",
                "the key \"a\" is used by two fields",
            ),
            // variant
            (
                "#[serde(untagged)] enum E { #[shape(bogus_typo)] U, V { a: u8 } }",
                "the `bogus_typo` attribute is not supported",
            ),
            (
                "#[serde(untagged)] enum E { #[serde(default)] U, V { a: u8 } }",
                "`default` does not apply to a variant",
            ),
            (
                "#[serde(untagged)] enum E { #[shape(min_properties = 5)] N { a: u8 }, M(String) }",
                "apply only to a newtype variant",
            ),
            (
                "#[serde(untagged)] enum E { #[shape(min_length = 1)] U, V { a: u8 } }",
                "no constraint applies to a unit variant",
            ),
            (
                "#[serde(tag = \"k\")] enum E { #[shape(min_items = 1)] A { a: u8 } }",
                "apply only to a newtype variant of an untagged enum",
            ),
            (
                "enum E { A, #[serde(rename = \"A\")] B }",
                "the variant key \"A\" is used twice",
            ),
            (
                "#[serde(tag = \"k\", untagged)] enum E { A }",
                "tag and untagged cannot be combined",
            ),
            ("#[serde(untagged)] enum E { A, B }", "one unit variant"),
            ("enum E { A(u8), B }", "externally tagged"),
            ("enum E {}", "at least one variant"),
            // tuple variant field
            (
                "#[serde(untagged)] enum E { One(#[serde(flatten)] String) }",
                "`flatten` does not apply to the field of a tuple variant",
            ),
            (
                "#[serde(untagged)] enum E { One(#[shape(zzz)] String) }",
                "the `zzz` attribute is not supported",
            ),
            (
                "#[serde(untagged)] enum E { #[shape(min_length = 1)] One(#[shape(min_length = 2)] String) }",
                "`min_length` is given twice",
            ),
            (
                "#[serde(untagged)] enum E { One(u8, u8) }",
                "exactly one field",
            ),
            (
                "#[serde(tag = \"k\")] enum E { A(#[shape(min = 1)] B) }",
                "no constraint applies to a newtype variant of a tagged enum",
            ),
            // the item itself
            ("struct A<T> { a: T }", "does not support generic types"),
            ("struct A(u8);", "needs a struct with named fields"),
            ("union A { a: u8 }", "does not support unions"),
        ];
        for (source, expected) in cases {
            let message = refusal(source);
            assert!(
                message.contains(expected),
                "{source}: {message:?} lacks {expected:?}"
            );
        }
    }

    #[test]
    fn what_the_type_system_decides_is_asserted_in_the_expansion() {
        let wrong_kind = expand(&parse("struct A { #[shape(min = 1)] a: String }"))
            .expect("the kind is checked by the compiler")
            .to_string();
        assert!(wrong_kind.contains("class_in"), "{wrong_kind}");
        assert!(
            wrong_kind.contains("Integer") && wrong_kind.contains("Number"),
            "{wrong_kind}"
        );
        let flattened = expand(&parse("struct A { #[serde(flatten)] a: B }"))
            .expect("the type is checked by the compiler")
            .to_string();
        assert!(flattened.contains("IS_OBJECT"), "{flattened}");
        let tagged = expand(&parse("#[serde(tag = \"k\")] enum E { A(B) }"))
            .expect("the type is checked by the compiler")
            .to_string();
        assert!(
            tagged.contains("IS_OBJECT") && tagged.contains("keys_unique"),
            "{tagged}"
        );
        let constant = expand(&parse("struct A { #[shape(constant = \"x\")] a: u8 }"))
            .expect("the kind is checked by the compiler")
            .to_string();
        assert!(
            constant.contains("class_in") && constant.contains("String"),
            "{constant}"
        );
    }

    #[test]
    fn variant_names_follow_serde() {
        let table = [
            ("HTTPServer", Case::Snake, "h_t_t_p_server"),
            ("HTTPServer", Case::Kebab, "h-t-t-p-server"),
            ("HTTPServer", Case::ScreamingSnake, "H_T_T_P_SERVER"),
            ("HTTPServer", Case::ScreamingKebab, "H-T-T-P-SERVER"),
            ("HTTPServer", Case::Camel, "hTTPServer"),
            ("HTTPServer", Case::Lower, "httpserver"),
            ("HTTPServer", Case::Upper, "HTTPSERVER"),
            ("HTTPServer", Case::Pascal, "HTTPServer"),
            ("Utf8Bom", Case::Snake, "utf8_bom"),
            ("Utf8Bom", Case::Kebab, "utf8-bom"),
            ("A", Case::Snake, "a"),
            ("RegexParse", Case::Kebab, "regex-parse"),
            ("RegexParse", Case::Camel, "regexParse"),
            ("V2Api", Case::Snake, "v2_api"),
        ];
        for (name, case, expected) in table {
            assert_eq!(
                variant_name(name, Some(case)),
                expected,
                "{name} as {case:?}"
            );
        }
        assert_eq!(variant_name("RegexParse", None), "RegexParse");
    }

    #[test]
    fn field_names_follow_serde() {
        let table = [
            ("code_unit", Case::Camel, "codeUnit"),
            ("code_unit", Case::Pascal, "CodeUnit"),
            ("code_unit", Case::Kebab, "code-unit"),
            ("code_unit", Case::ScreamingSnake, "CODE_UNIT"),
            ("code_unit", Case::ScreamingKebab, "CODE-UNIT"),
            ("code_unit", Case::Upper, "CODE_UNIT"),
            ("code_unit", Case::Lower, "code_unit"),
            ("code_unit", Case::Snake, "code_unit"),
            ("x_1_y", Case::Pascal, "X1Y"),
            ("x_1_y", Case::Camel, "x1Y"),
            ("_leading", Case::Pascal, "Leading"),
            ("_leading", Case::Camel, "leading"),
            ("trailing_", Case::Pascal, "Trailing"),
            ("a__b", Case::Pascal, "AB"),
            ("a__b", Case::Kebab, "a--b"),
            ("http_server", Case::Camel, "httpServer"),
        ];
        for (name, case, expected) in table {
            assert_eq!(field_name(name, Some(case)), expected, "{name} as {case:?}");
        }
        assert_eq!(field_name("code_unit", None), "code_unit");
    }
}
