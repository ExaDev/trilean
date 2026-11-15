//! The wasm binding of `trilean`.
//!
//! The binding reads a JavaScript value as one of the package's schemas and answers in the shape a Standard Schema
//! `validate` returns: `{ value }` for a value the schema accepts, read as the schema reads it, or `{ issues }`, each
//! with a message and the path of the value it is about. Nothing here is validation logic: the value is converted to
//! an ordered JSON value, `trilean::schemas::read` decides, and the answer is converted back.

use js_sys::{Array, Object, Reflect};
use json_shape::{Issue, PathSegment, Value};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const READING: &str = r#"
/** One problem with a value, at the path of the part of it the problem is about. */
export interface SchemaIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

/** What reading a value as a schema answers: the value as the schema reads it, or every problem found. */
export type SchemaReading =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: readonly SchemaIssue[] };
"#;

/// The deepest nesting of arrays and objects a value may have to be read, so that a value nested to the depth of the
/// call stack is refused with an issue and not a trap. A tree is read at a depth of about two for each level of
/// nodes, and an evaluator's nesting limit is far below this.
const MAX_DEPTH: usize = 2_000;

struct Found {
    path: Vec<PathSegment>,
    message: String,
}

fn issue(path: &[PathSegment], message: impl Into<String>) -> Found {
    Found {
        path: path.to_vec(),
        message: message.into(),
    }
}

/// The JavaScript kind of a value, for a message.
fn kind_of(value: &JsValue) -> &'static str {
    if value.is_undefined() {
        "undefined"
    } else if value.is_null() {
        "null"
    } else if value.is_bigint() {
        "a bigint"
    } else if value.is_symbol() {
        "a symbol"
    } else if value.is_function() {
        "a function"
    } else if value.as_bool().is_some() {
        "a boolean"
    } else if value.as_f64().is_some() {
        "a number"
    } else if value.is_string() {
        "a string"
    } else if Array::is_array(value) {
        "an array"
    } else {
        "an object"
    }
}

/// Whether the object is a plain one: its prototype is `Object.prototype` or none, so a `Date`, a `Map`, a class
/// instance and every other object that is not data are refused.
fn is_plain(object: &Object) -> bool {
    let prototype = Object::get_prototype_of(object);
    prototype.is_null() || prototype == Object::get_prototype_of(&Object::new())
}

/// A JavaScript string as text. A string that holds an unpaired surrogate has no text, since a Rust string holds
/// scalar values, so it is refused and not changed into a different string.
fn text_of(string: &js_sys::JsString, path: &[PathSegment]) -> Result<String, Found> {
    let text = String::from(string);
    if text.contains('\u{FFFD}') && has_unpaired_surrogate(string) {
        return Err(issue(path, "a string holds an unpaired surrogate"));
    }
    Ok(text)
}

fn has_unpaired_surrogate(string: &js_sys::JsString) -> bool {
    let units: Vec<u16> = string.iter().collect();
    let mut at = 0;
    while at < units.len() {
        match units[at] {
            0xD800..=0xDBFF => {
                if units
                    .get(at + 1)
                    .is_some_and(|next| (0xDC00..=0xDFFF).contains(next))
                {
                    at += 1;
                } else {
                    return true;
                }
            }
            0xDC00..=0xDFFF => return true,
            _ => {}
        }
        at += 1;
    }
    false
}

/// A JavaScript value as an ordered JSON value, or the first thing about it that no JSON value is.
fn read_value(value: &JsValue, path: &mut Vec<PathSegment>, depth: usize) -> Result<Value, Found> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    if let Some(flag) = value.as_bool() {
        return Ok(Value::Bool(flag));
    }
    if let Some(number) = value.as_f64() {
        return if number.is_finite() {
            Ok(Value::Number(number))
        } else {
            Err(issue(
                path,
                "expected a finite number, found NaN or an infinity",
            ))
        };
    }
    if let Some(string) = value.dyn_ref::<js_sys::JsString>() {
        return text_of(string, path).map(Value::String);
    }
    let is_array = Array::is_array(value);
    if !is_array && !value.is_object() {
        return Err(issue(
            path,
            format!("expected a JSON value, found {}", kind_of(value)),
        ));
    }
    if depth >= MAX_DEPTH {
        return Err(issue(path, "the value is nested too deeply to be read"));
    }
    if is_array {
        let array: &Array = value.unchecked_ref();
        let mut elements = Vec::with_capacity(array.length() as usize);
        for index in 0..array.length() {
            path.push(PathSegment::Index(index as usize));
            let element = array.get(index);
            let read = if element.is_undefined() {
                Err(issue(path, "expected a JSON value, found undefined"))
            } else {
                read_value(&element, path, depth + 1)
            };
            path.pop();
            elements.push(read?);
        }
        return Ok(Value::Array(elements));
    }
    let object: &Object = value.unchecked_ref();
    if !is_plain(object) {
        return Err(issue(
            path,
            "expected a plain object, found an object of another kind",
        ));
    }
    let mut members = Vec::new();
    for key in Object::keys(object).iter() {
        let Some(name) = key.as_string() else {
            continue;
        };
        let member =
            Reflect::get(object, &key).map_err(|_| issue(path, "a property could not be read"))?;
        // A property that is `undefined` is an absent one, as it is to a reader of the object.
        if member.is_undefined() {
            continue;
        }
        path.push(PathSegment::Key(name.clone()));
        let read = read_value(&member, path, depth + 1);
        path.pop();
        members.push((name, read?));
    }
    Ok(Value::Object(members))
}

/// An ordered JSON value as a JavaScript value, with the keys in the order the value has them.
fn write_value(value: &Value) -> JsValue {
    match value {
        Value::Null => JsValue::NULL,
        Value::Bool(flag) => JsValue::from_bool(*flag),
        Value::Number(number) => JsValue::from_f64(*number),
        Value::String(text) => JsValue::from_str(text),
        Value::Array(elements) => elements.iter().map(write_value).collect::<Array>().into(),
        Value::Object(members) => {
            let object = Object::new();
            for (key, entry) in members {
                // Own data properties, with no setter in the way: a key such as `__proto__` is a property like another.
                let descriptor = Object::new();
                set(&descriptor, "value", &write_value(entry));
                for flag in ["writable", "enumerable", "configurable"] {
                    set(&descriptor, flag, &JsValue::TRUE);
                }
                Object::define_property(&object, &JsValue::from_str(key), &descriptor);
            }
            object.into()
        }
    }
}

fn set(object: &Object, key: &str, value: &JsValue) {
    // Setting a property of a plain object that was just made cannot fail.
    let _ = Reflect::set(object, &JsValue::from_str(key), value);
}

fn issues_to_js(issues: &[Found]) -> JsValue {
    let list: Array = issues
        .iter()
        .map(|found| {
            let object = Object::new();
            set(&object, "message", &JsValue::from_str(&found.message));
            let path: Array = found
                .path
                .iter()
                .map(|segment| match segment {
                    PathSegment::Key(key) => JsValue::from_str(key),
                    PathSegment::Index(index) => JsValue::from_f64(*index as f64),
                })
                .collect();
            set(&object, "path", &path.into());
            JsValue::from(object)
        })
        .collect();
    let answer = Object::new();
    set(&answer, "issues", &list.into());
    answer.into()
}

fn found_from(issue: &Issue) -> Found {
    Found {
        path: issue.path.clone(),
        message: issue.message.clone(),
    }
}

/// Reads `value` as the schema called `name`.
///
/// Answers `{ value }` with the value as the schema reads it (the keys the schema names, in its order), or
/// `{ issues }` with every problem and the path of each. A value that no JSON value is (a function, a `Date`, a number
/// that is not finite, a string with an unpaired surrogate, an `undefined` in an array) is an issue at its path.
///
/// # Errors
///
/// Throws when no schema is called `name`, which is a mistake of the package's own generated code and not of a value.
#[wasm_bindgen(js_name = readSchema, unchecked_return_type = "SchemaReading")]
pub fn read_schema(
    #[wasm_bindgen(unchecked_param_type = "string")] name: &str,
    #[wasm_bindgen(unchecked_param_type = "unknown")] value: &JsValue,
) -> Result<JsValue, JsValue> {
    let converted = match read_value(value, &mut Vec::new(), 0) {
        Ok(converted) => converted,
        Err(found) => return Ok(issues_to_js(&[found])),
    };
    match trilean::schemas::read(name, &converted) {
        None => Err(js_sys::Error::new(&format!("no schema is called {name}")).into()),
        Some(Ok(read)) => {
            let answer = Object::new();
            set(&answer, "value", &write_value(&read));
            Ok(answer.into())
        }
        Some(Err(issues)) => Ok(issues_to_js(
            &issues.iter().map(found_from).collect::<Vec<_>>(),
        )),
    }
}
