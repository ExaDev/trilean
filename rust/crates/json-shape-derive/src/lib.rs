//! `#[derive(Shape)]` for the `json-shape` crate.
//!
//! The derive reads the serde attributes a type already carries, so one declaration serves serde and the shape:
//! `tag`, `untagged`, `rename`, `rename_all`, `deny_unknown_fields`, `default` and `flatten`, plus
//! `skip_serializing_if`, which only affects how a value is written and so is accepted and ignored. The shape adds
//! `#[shape(...)]` for what serde cannot say.
//!
//! On a container: `strict` (the same as `deny_unknown_fields`), `together(a, b)` (each named field requires the
//! others) and `min_properties = n`. On a field: `min = n`, `max = n`, `min_length = n`, `min_items = n`,
//! `max_items = n`, `unique_items`, `min_properties = n`, `pattern = "..."`, `property_names = "..."` (a pattern
//! the keys of a map match) and `constant = true` or `constant = "text"`. Doc comments become descriptions.
//!
//! Supported types: a struct with named fields (an object), an enum of unit variants (a string enum), an enum with
//! `#[serde(tag = "...")]` whose variants are unit, struct or newtype variants over an object type (an internally
//! tagged union), and an enum with `#[serde(untagged)]` whose variants are unit (null), struct or newtype variants
//! (a union that matches exactly one). Anything else, any other serde attribute and any generic parameter is a
//! compile error that names it.

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::quote;
use syn::ext::IdentExt;
use syn::spanned::Spanned;
use syn::{
    Attribute, Data, DeriveInput, Expr, ExprLit, Fields, FieldsNamed, Ident, Lit, LitStr, Meta,
    Type, Variant, parse_macro_input,
};

#[proc_macro_derive(Shape, attributes(shape, serde))]
pub fn derive_shape(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    expand(&input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

type Result<T> = syn::Result<T>;

#[derive(Clone, Copy)]
enum Case {
    Lower,
    Upper,
    Camel,
    Pascal,
    Snake,
    Kebab,
}

fn parse_case(text: &LitStr) -> Result<Case> {
    match text.value().as_str() {
        "lowercase" => Ok(Case::Lower),
        "UPPERCASE" => Ok(Case::Upper),
        "camelCase" => Ok(Case::Camel),
        "PascalCase" => Ok(Case::Pascal),
        "snake_case" => Ok(Case::Snake),
        "kebab-case" => Ok(Case::Kebab),
        other => Err(syn::Error::new(
            text.span(),
            format!("rename_all = \"{other}\" is not supported by json_shape::Shape"),
        )),
    }
}

fn words(name: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for letter in name.chars() {
        if letter == '_' {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_lower = false;
        } else {
            if letter.is_uppercase() && previous_lower && !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            previous_lower = letter.is_lowercase() || letter.is_ascii_digit();
            current.extend(letter.to_lowercase());
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn capitalised(word: &str) -> String {
    let mut letters = word.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => String::new(),
    }
}

fn apply_case(name: &str, case: Option<Case>) -> String {
    let Some(case) = case else {
        return name.to_owned();
    };
    let words = words(name);
    match case {
        Case::Lower => words.concat(),
        Case::Upper => words.concat().to_uppercase(),
        Case::Snake => words.join("_"),
        Case::Kebab => words.join("-"),
        Case::Pascal => words.iter().map(|word| capitalised(word)).collect(),
        Case::Camel => words
            .iter()
            .enumerate()
            .map(|(position, word)| {
                if position == 0 {
                    word.clone()
                } else {
                    capitalised(word)
                }
            })
            .collect(),
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

fn number_of(literal: &Lit) -> Result<f64> {
    match literal {
        Lit::Int(number) => number.base10_parse(),
        Lit::Float(number) => number.base10_parse(),
        other => Err(syn::Error::new(
            other.span(),
            "expected a non-negative number",
        )),
    }
}

fn count_of(literal: &Lit) -> Result<usize> {
    match literal {
        Lit::Int(number) => number.base10_parse(),
        other => Err(syn::Error::new(other.span(), "expected a whole number")),
    }
}

#[derive(Default)]
struct Container {
    tag: Option<String>,
    untagged: bool,
    rename_all: Option<Case>,
    strict: bool,
    together: Vec<(Span, Vec<Ident>)>,
    min_properties: Option<usize>,
}

fn container_attributes(attributes: &[Attribute]) -> Result<Container> {
    let mut container = Container::default();
    for attribute in attributes {
        if attribute.path().is_ident("serde") {
            attribute.parse_nested_meta(|meta| {
                if meta.path.is_ident("tag") {
                    container.tag = Some(meta.value()?.parse::<LitStr>()?.value());
                } else if meta.path.is_ident("untagged") {
                    container.untagged = true;
                } else if meta.path.is_ident("rename_all") {
                    container.rename_all = Some(parse_case(&meta.value()?.parse::<LitStr>()?)?);
                } else if meta.path.is_ident("deny_unknown_fields") {
                    container.strict = true;
                } else {
                    return Err(meta.error(
                        "this serde container attribute is not supported by json_shape::Shape",
                    ));
                }
                Ok(())
            })?;
        } else if attribute.path().is_ident("shape") {
            attribute.parse_nested_meta(|meta| {
                if meta.path.is_ident("strict") {
                    container.strict = true;
                } else if meta.path.is_ident("min_properties") {
                    container.min_properties = Some(count_of(&meta.value()?.parse::<Lit>()?)?);
                } else if meta.path.is_ident("together") {
                    let mut names = Vec::new();
                    meta.parse_nested_meta(|inner| {
                        let ident = inner
                            .path
                            .get_ident()
                            .ok_or_else(|| inner.error("expected a field name"))?;
                        names.push(ident.clone());
                        Ok(())
                    })?;
                    container.together.push((meta.path.span(), names));
                } else {
                    return Err(meta.error("this #[shape] container attribute is not supported"));
                }
                Ok(())
            })?;
        }
    }
    Ok(container)
}

enum Constant {
    Bool(bool),
    Text(String),
}

#[derive(Default)]
struct Field {
    rename: Option<String>,
    default: bool,
    flatten: bool,
    constraints: Vec<TokenStream2>,
    constant: Option<Constant>,
}

fn field_attributes(attributes: &[Attribute]) -> Result<Field> {
    let mut field = Field::default();
    for attribute in attributes {
        if attribute.path().is_ident("serde") {
            attribute.parse_nested_meta(|meta| {
                if meta.path.is_ident("rename") {
                    field.rename = Some(meta.value()?.parse::<LitStr>()?.value());
                } else if meta.path.is_ident("default") {
                    if meta.input.peek(syn::Token![=]) {
                        return Err(meta.error("default = \"path\" is not supported; use a type that implements Default"));
                    }
                    field.default = true;
                } else if meta.path.is_ident("flatten") {
                    field.flatten = true;
                } else if meta.path.is_ident("skip_serializing_if") {
                    meta.value()?.parse::<LitStr>()?;
                } else {
                    return Err(meta.error("this serde field attribute is not supported by json_shape::Shape"));
                }
                Ok(())
            })?;
        } else if attribute.path().is_ident("shape") {
            attribute.parse_nested_meta(|meta| {
                let constraint = if meta.path.is_ident("min") {
                    let bound = number_of(&meta.value()?.parse::<Lit>()?)?;
                    quote! { ::json_shape::Constraint::Min(#bound) }
                } else if meta.path.is_ident("max") {
                    let bound = number_of(&meta.value()?.parse::<Lit>()?)?;
                    quote! { ::json_shape::Constraint::Max(#bound) }
                } else if meta.path.is_ident("min_length") {
                    let length = count_of(&meta.value()?.parse::<Lit>()?)?;
                    quote! { ::json_shape::Constraint::MinLength(#length) }
                } else if meta.path.is_ident("min_items") {
                    let count = count_of(&meta.value()?.parse::<Lit>()?)?;
                    quote! { ::json_shape::Constraint::MinItems(#count) }
                } else if meta.path.is_ident("max_items") {
                    let count = count_of(&meta.value()?.parse::<Lit>()?)?;
                    quote! { ::json_shape::Constraint::MaxItems(#count) }
                } else if meta.path.is_ident("min_properties") {
                    let count = count_of(&meta.value()?.parse::<Lit>()?)?;
                    quote! { ::json_shape::Constraint::MinProperties(#count) }
                } else if meta.path.is_ident("unique_items") {
                    quote! { ::json_shape::Constraint::UniqueItems }
                } else if meta.path.is_ident("pattern") {
                    let source = meta.value()?.parse::<LitStr>()?;
                    quote! { ::json_shape::Constraint::Pattern(#source.to_owned()) }
                } else if meta.path.is_ident("property_names") {
                    let source = meta.value()?.parse::<LitStr>()?;
                    quote! { ::json_shape::Constraint::KeyPattern(#source.to_owned()) }
                } else if meta.path.is_ident("constant") {
                    field.constant = Some(match meta.value()?.parse::<Lit>()? {
                        Lit::Bool(flag) => Constant::Bool(flag.value),
                        Lit::Str(text) => Constant::Text(text.value()),
                        other => {
                            return Err(syn::Error::new(
                                other.span(),
                                "constant takes a boolean or a string",
                            ));
                        }
                    });
                    return Ok(());
                } else {
                    return Err(meta.error("this #[shape] field attribute is not supported"));
                };
                field.constraints.push(constraint);
                Ok(())
            })?;
        }
    }
    Ok(field)
}

/// One named field with everything the generated code needs.
struct Member {
    ident: Ident,
    key: String,
    ty: Type,
    attributes: Field,
    description: Option<String>,
}

fn members(fields: &FieldsNamed, rename_all: Option<Case>) -> Result<Vec<Member>> {
    let mut found = Vec::new();
    for field in &fields.named {
        let Some(ident) = &field.ident else {
            return Err(syn::Error::new(field.span(), "a field must be named"));
        };
        let attributes = field_attributes(&field.attrs)?;
        let key = attributes
            .rename
            .clone()
            .unwrap_or_else(|| apply_case(&name_of(ident), rename_all));
        found.push(Member {
            ident: ident.clone(),
            key,
            ty: field.ty.clone(),
            attributes,
            description: description(&field.attrs),
        });
    }
    let mut keys = std::collections::BTreeSet::new();
    for member in &found {
        if !member.attributes.flatten && !keys.insert(member.key.clone()) {
            return Err(syn::Error::new(
                member.ident.span(),
                format!("the key \"{}\" is used by two fields", member.key),
            ));
        }
    }
    Ok(found)
}

/// Statements that build `__fields` and `__dependent` from the members.
fn fields_definition(members: &[Member]) -> TokenStream2 {
    let steps = members.iter().map(|member| {
        let ty = &member.ty;
        let key = &member.key;
        if member.attributes.flatten {
            return quote! {
                match <#ty as ::json_shape::Shape>::definition().kind {
                    ::json_shape::Kind::Object(__inner) => {
                        __fields.extend(__inner.fields);
                        __dependent.extend(__inner.dependent_required);
                    }
                    _ => panic!("a flattened field must be an object type"),
                }
            };
        }
        let constraints = &member.attributes.constraints;
        let described = member
            .description
            .as_ref()
            .map(|text| quote! { __shape = __shape.described(#text); });
        let constant = match &member.attributes.constant {
            Some(Constant::Bool(flag)) => Some(quote! { __shape = __shape.constant_bool(#flag); }),
            Some(Constant::Text(text)) => {
                Some(quote! { __shape = __shape.constant_string(#text); })
            }
            None => None,
        };
        let optional = member.attributes.default;
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
fn object_definition(container: &Container, members: &[Member]) -> Result<TokenStream2> {
    let mut groups = Vec::new();
    for (span, names) in &container.together {
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
    let strict = container.strict;
    let minimum = match container.min_properties {
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

/// Statements and an expression that read the members out of `__value`, as a struct literal's fields.
fn member_builds(members: &[Member]) -> Vec<TokenStream2> {
    members
        .iter()
        .map(|member| {
            let ident = &member.ident;
            let ty = &member.ty;
            let key = &member.key;
            if member.attributes.flatten {
                return quote! { #ident: <#ty as ::json_shape::Shape>::build(__value, __path)? };
            }
            let missing = if member.attributes.default {
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
            if member.attributes.flatten {
                quote! { <#ty as ::json_shape::Shape>::register_members(__registry); }
            } else {
                quote! { <#ty as ::json_shape::Shape>::register(__registry); }
            }
        })
        .collect()
}

/// A definition expression for a set of named fields, building an object shape.
fn object_shape(
    container: &Container,
    members: &[Member],
    doc: &Option<String>,
) -> Result<TokenStream2> {
    let steps = fields_definition(members);
    let object = object_definition(container, members)?;
    let described = doc.as_ref().map(|text| quote! { .described(#text) });
    Ok(quote! {
        {
            let mut __fields: ::std::vec::Vec<::json_shape::FieldDef> = ::std::vec::Vec::new();
            let mut __dependent: ::std::vec::Vec<(::std::string::String, ::std::vec::Vec<::std::string::String>)> =
                ::std::vec::Vec::new();
            #steps
            ::json_shape::ShapeDef::new(::json_shape::Kind::Object(#object)) #described
        }
    })
}

fn variant_key(variant: &Variant, rename_all: Option<Case>, allow_shape: bool) -> Result<String> {
    let mut rename = None;
    for attribute in &variant.attrs {
        if attribute.path().is_ident("serde") {
            attribute.parse_nested_meta(|meta| {
                if meta.path.is_ident("rename") {
                    rename = Some(meta.value()?.parse::<LitStr>()?.value());
                    Ok(())
                } else {
                    Err(meta.error(
                        "this serde variant attribute is not supported by json_shape::Shape",
                    ))
                }
            })?;
        } else if attribute.path().is_ident("shape") && !allow_shape {
            return Err(syn::Error::new(
                attribute.span(),
                "#[shape] applies to a variant only in an untagged enum, where it constrains a newtype variant",
            ));
        }
    }
    Ok(rename.unwrap_or_else(|| apply_case(&name_of(&variant.ident), rename_all)))
}

fn newtype_type(variant: &Variant) -> Result<Option<&Type>> {
    match &variant.fields {
        Fields::Unnamed(fields) if fields.unnamed.len() == 1 => {
            Ok(fields.unnamed.first().map(|field| &field.ty))
        }
        Fields::Unnamed(_) => Err(syn::Error::new(
            variant.span(),
            "a tuple variant must hold exactly one field",
        )),
        _ => Ok(None),
    }
}

fn expand(input: &DeriveInput) -> Result<TokenStream2> {
    if !input.generics.params.is_empty() {
        return Err(syn::Error::new(
            input.generics.span(),
            "json_shape::Shape does not support generic types",
        ));
    }
    let container = container_attributes(&input.attrs)?;
    let name = &input.ident;
    let label = name_of(name);
    let doc = description(&input.attrs);
    let (definition, register_members, build) = match &input.data {
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
            let members = members(fields, container.rename_all)?;
            let definition = object_shape(&container, &members, &doc)?;
            let registers = member_registers(&members);
            let builds = member_builds(&members);
            (
                definition,
                quote! { #(#registers)* },
                quote! { ::core::result::Result::Ok(Self { #(#builds),* }) },
            )
        }
        Data::Enum(data) => expand_enum(&container, &doc, name, data.variants.iter().collect())?,
        Data::Union(_) => {
            return Err(syn::Error::new(
                input.span(),
                "json_shape::Shape does not support unions",
            ));
        }
    };
    Ok(quote! {
        impl ::json_shape::Shape for #name {
            fn reference() -> ::json_shape::ShapeDef {
                ::json_shape::ShapeDef::new(::json_shape::Kind::Ref(#label.to_owned()))
            }

            fn definition() -> ::json_shape::ShapeDef {
                #definition
            }

            fn register(__registry: &mut ::json_shape::Registry) {
                if __registry.reserve(#label) {
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

/// The shape of one variant as an object: its fields, with the tag as a constant when the enum is tagged.
fn variant_object(
    container: &Container,
    variant: &Variant,
    tag: Option<(&str, &str)>,
) -> Result<TokenStream2> {
    let doc = description(&variant.attrs);
    let tag_field = tag.map(|(tag, value)| {
        quote! {
            __fields.push(::json_shape::FieldDef {
                name: #tag.to_owned(),
                shape: ::json_shape::ShapeDef::new(::json_shape::Kind::ConstString(#value.to_owned())),
                required: true,
            });
        }
    });
    let described = doc.as_ref().map(|text| quote! { .described(#text) });
    match &variant.fields {
        Fields::Unit => Ok(quote! {
            {
                let mut __fields: ::std::vec::Vec<::json_shape::FieldDef> = ::std::vec::Vec::new();
                #tag_field
                ::json_shape::ShapeDef::new(::json_shape::Kind::Object(::json_shape::ObjectDef {
                    fields: __fields,
                    closed: true,
                    min_properties: ::core::option::Option::None,
                    dependent_required: ::std::vec::Vec::new(),
                })) #described
            }
        }),
        Fields::Named(fields) => {
            let members = members(fields, None)?;
            let steps = fields_definition(&members);
            let object = object_definition(container, &members)?;
            Ok(quote! {
                {
                    let mut __fields: ::std::vec::Vec<::json_shape::FieldDef> = ::std::vec::Vec::new();
                    let mut __dependent: ::std::vec::Vec<(::std::string::String, ::std::vec::Vec<::std::string::String>)> =
                        ::std::vec::Vec::new();
                    #tag_field
                    #steps
                    ::json_shape::ShapeDef::new(::json_shape::Kind::Object(#object)) #described
                }
            })
        }
        Fields::Unnamed(_) => {
            let ty = newtype_type(variant)?
                .ok_or_else(|| syn::Error::new(variant.span(), "unreachable"))?;
            let strict = container.strict;
            let merged_description = doc
                .as_ref()
                .map(|text| quote! { __shape = __shape.described(#text); });
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
                        _ => panic!("a newtype variant of a tagged enum must hold an object type"),
                    }
                    #merged_description
                    __shape
                }
            })
        }
    }
}

/// The definition, member registration and build expression of an enum.
fn expand_enum(
    container: &Container,
    doc: &Option<String>,
    name: &Ident,
    variants: Vec<&Variant>,
) -> Result<(TokenStream2, TokenStream2, TokenStream2)> {
    let described = doc.as_ref().map(|text| quote! { .described(#text) });
    let mut keys = Vec::new();
    for variant in &variants {
        let key = variant_key(variant, container.rename_all, container.untagged)?;
        if keys.contains(&key) {
            return Err(syn::Error::new(
                variant.span(),
                format!("the variant key \"{key}\" is used twice"),
            ));
        }
        keys.push(key);
    }
    if variants.is_empty() {
        return Err(syn::Error::new(
            name.span(),
            "an enum needs at least one variant",
        ));
    }
    let all_unit = variants
        .iter()
        .all(|variant| matches!(variant.fields, Fields::Unit));
    if container.tag.is_some() && container.untagged {
        return Err(syn::Error::new(
            name.span(),
            "tag and untagged cannot be combined",
        ));
    }
    if all_unit && container.tag.is_none() && !container.untagged {
        let idents: Vec<&Ident> = variants.iter().map(|variant| &variant.ident).collect();
        return Ok((
            quote! {
                ::json_shape::ShapeDef::new(::json_shape::Kind::Enum(::std::vec![#(#keys.to_owned()),*])) #described
            },
            quote! {},
            quote! {
                match __value.as_str() {
                    #( ::core::option::Option::Some(#keys) => ::core::result::Result::Ok(Self::#idents), )*
                    _ => ::core::result::Result::Err(::json_shape::Issues::at(__path, "not one of the variants")),
                }
            },
        ));
    }
    if let Some(tag) = &container.tag {
        let mut definitions = Vec::new();
        let mut registers = Vec::new();
        let mut arms = Vec::new();
        for (variant, key) in variants.iter().zip(&keys) {
            definitions.push(variant_object(container, variant, Some((tag, key)))?);
            let ident = &variant.ident;
            match &variant.fields {
                Fields::Unit => {
                    arms.push(quote! { #key => ::core::result::Result::Ok(Self::#ident), })
                }
                Fields::Named(fields) => {
                    let members = members(fields, None)?;
                    let builds = member_builds(&members);
                    registers.extend(member_registers(&members));
                    arms.push(quote! { #key => ::core::result::Result::Ok(Self::#ident { #(#builds),* }), });
                }
                Fields::Unnamed(_) => {
                    let ty = newtype_type(variant)?
                        .ok_or_else(|| syn::Error::new(variant.span(), "unreachable"))?;
                    registers.push(
                        quote! { <#ty as ::json_shape::Shape>::register_members(__registry); },
                    );
                    arms.push(quote! {
                        #key => <#ty as ::json_shape::Shape>::build(__value, __path).map(Self::#ident),
                    });
                }
            }
        }
        return Ok((
            quote! {
                ::json_shape::ShapeDef::new(::json_shape::Kind::Tagged {
                    tag: #tag.to_owned(),
                    variants: ::std::vec![#( (#keys.to_owned(), #definitions) ),*],
                }) #described
            },
            quote! { #(#registers)* },
            quote! {
                let ::core::option::Option::Some(__kind) = __value.get(#tag).and_then(::json_shape::Value::as_str) else {
                    return ::core::result::Result::Err(::json_shape::Issues::at(__path, "expected a string naming the kind"));
                };
                match __kind {
                    #(#arms)*
                    _ => ::core::result::Result::Err(::json_shape::Issues::at(__path, "not a known kind")),
                }
            },
        ));
    }
    if container.untagged {
        let mut alternatives = Vec::new();
        let mut registers = Vec::new();
        let mut arms = Vec::new();
        for (position, variant) in variants.iter().enumerate() {
            let ident = &variant.ident;
            let doc = description(&variant.attrs);
            let described = doc.as_ref().map(|text| quote! { .described(#text) });
            match &variant.fields {
                Fields::Unit => {
                    alternatives.push(
                        quote! { ::json_shape::ShapeDef::new(::json_shape::Kind::Null) #described },
                    );
                    arms.push(quote! { #position => ::core::result::Result::Ok(Self::#ident), });
                }
                Fields::Named(fields) => {
                    alternatives.push(variant_object(container, variant, None)?);
                    let members = members(fields, None)?;
                    let builds = member_builds(&members);
                    registers.extend(member_registers(&members));
                    arms.push(quote! { #position => ::core::result::Result::Ok(Self::#ident { #(#builds),* }), });
                }
                Fields::Unnamed(_) => {
                    let ty = newtype_type(variant)?
                        .ok_or_else(|| syn::Error::new(variant.span(), "unreachable"))?;
                    let shape_only: Vec<Attribute> = variant
                        .attrs
                        .iter()
                        .filter(|attribute| attribute.path().is_ident("shape"))
                        .cloned()
                        .collect();
                    let constraints = field_attributes(&shape_only)?.constraints;
                    alternatives.push(quote! {
                        {
                            let mut __shape = <#ty as ::json_shape::Shape>::reference();
                            #( __shape = __shape.constrained(#constraints); )*
                            __shape #described
                        }
                    });
                    registers.push(quote! { <#ty as ::json_shape::Shape>::register(__registry); });
                    arms.push(quote! {
                        #position => <#ty as ::json_shape::Shape>::build(__value, __path).map(Self::#ident),
                    });
                }
            }
        }
        return Ok((
            quote! {
                ::json_shape::ShapeDef::new(::json_shape::Kind::OneOf(::std::vec![#(#alternatives),*])) #described
            },
            quote! { #(#registers)* },
            quote! {
                let __definitions = <Self as ::json_shape::Shape>::definitions();
                let ::json_shape::Kind::OneOf(__alternatives) = <Self as ::json_shape::Shape>::definition().kind else {
                    return ::core::result::Result::Err(::json_shape::Issues::at(__path, "the shape is not a union"));
                };
                for (__index, __alternative) in __alternatives.iter().enumerate() {
                    if ::json_shape::accepts(&__definitions, __alternative, __value) {
                        return match __index {
                            #(#arms)*
                            _ => ::core::result::Result::Err(::json_shape::Issues::at(__path, "no such alternative")),
                        };
                    }
                }
                ::core::result::Result::Err(::json_shape::Issues::at(__path, "matches no alternative"))
            },
        ));
    }
    Err(syn::Error::new(
        name.span(),
        "an enum with data needs #[serde(tag = \"...\")] or #[serde(untagged)]; json_shape::Shape does not support externally tagged enums",
    ))
}
