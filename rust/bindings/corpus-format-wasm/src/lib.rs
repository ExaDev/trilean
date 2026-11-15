//! The wasm binding of `corpus-format`.
//!
//! Documents cross as the JSON text they are and files as the bytes they are, so what a loader reads from disk goes in
//! unchanged and the rules that depend on the exact text (canonical bytes, repeated keys, unpaired surrogates) are
//! applied to that text and not to a parsed copy. Values a case compares cross as plain JavaScript values, and a string
//! crosses as the UTF-16 code units it is. The error classes are JavaScript, written by the package build beside the
//! generated binding and handed to `registerErrorClasses` by the package's entry point.

use std::cell::RefCell;

use corpus_format::{
    CaseSummary, Completeness, CorpusFile, Decoded, Encodings, Entry, Implementation, Layout,
    Manifest, Mismatch, Problem, Requirement, Skip, Tolerance, Tree,
};
use js_sys::{Array, Function, JsString, Object, Reflect};
use json_shape::Value;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
/** What a path in a corpus tree is: a regular file, a directory, or anything else (a link, a device). */
export type EntryKind = "file" | "directory" | "other";

/** One entry of a corpus tree: its `/`-separated path relative to the root, and what it is. */
export interface TreeEntry {
  readonly path: string;
  readonly kind: EntryKind;
}

/** The files a corpus root holds, in UTF-16 order, and what is neither a corpus file nor a root file nor a skipped directory. */
export interface Selection {
  readonly files: string[];
  readonly problems: string[];
}

/** What is wrong with a document: the byte offset it was found at, and what. */
export interface Problem {
  readonly offset: number;
  readonly message: string;
}

/** Where two compared values differ: the place as `$` followed by `.name` and `[index]` steps, and how. */
export interface Mismatch {
  readonly path: string;
  readonly message: string;
}

/** How far a number may be from the one a case gives: `ulps` representable doubles, or an `absolute` distance that must not be reached. */
export type Tolerance = { readonly ulps: number } | { readonly absolute: number };

/** A case as the manifest records it. */
export interface CaseSummary {
  readonly id: string;
  readonly skip?: "ts" | "rust";
  readonly requires?: readonly "ecmascript-regex"[];
}

/** A corpus file as read: its path under the corpus root and its cases in file order. */
export interface CorpusFile {
  readonly name: string;
  readonly cases: readonly CaseSummary[];
}

/** The implementation a run is of. */
export type ImplementationName = "ts" | "rust";
"#;

/// The error classes the package's entry point registers, which are written beside the generated binding.
struct ErrorClasses {
    corpus_error: Function,
    decode_error: Function,
    internal_error: Function,
}

thread_local! {
    static CLASSES: RefCell<Option<ErrorClasses>> = const { RefCell::new(None) };
}

/// Hands the binding the classes it throws and installs the panic hook that throws one of them. The package's entry point calls it once, with `CorpusFormatError`, `DecodeError` and `InternalError` in that order, before anything else in the package can run.
///
/// A panic in Rust would otherwise reach JavaScript as a bare `RuntimeError: unreachable` with no message. The hook throws an `InternalError` carrying the panic's message and location instead; the instance that panicked is spent.
#[wasm_bindgen(js_name = registerErrorClasses)]
pub fn register_error_classes(
    corpus_error: Function,
    decode_error: Function,
    internal_error: Function,
) {
    CLASSES.with(|classes| {
        *classes.borrow_mut() = Some(ErrorClasses {
            corpus_error,
            decode_error,
            internal_error,
        });
    });
    std::panic::set_hook(Box::new(|info| {
        let message = format!("corpus-format: internal error: {info}");
        let error = CLASSES.with(|classes| {
            classes.try_borrow().ok().and_then(|classes| {
                classes.as_ref().and_then(|registered| {
                    Reflect::construct(
                        &registered.internal_error,
                        &Array::of1(&JsValue::from_str(&message)),
                    )
                    .ok()
                })
            })
        });
        wasm_bindgen::throw_val(error.unwrap_or_else(|| js_sys::Error::new(&message).into()))
    }));
}

/// Panics on purpose, so that a test can see the panic hook turn it into an `InternalError`. It exists only in the build with the `test-hooks` feature, which is never published.
#[cfg(feature = "test-hooks")]
#[wasm_bindgen(js_name = panicForTesting)]
pub fn panic_for_testing() {
    panic!("deliberate panic for the test of the panic hook");
}

/// An instance of one of the registered classes. Without registration, which only happens to a caller that imports the generated module directly instead of the package, the error says so.
fn construct(class: impl Fn(&ErrorClasses) -> &Function, arguments: &[JsValue]) -> JsValue {
    CLASSES.with(|classes| match classes.borrow().as_ref() {
        Some(registered) => {
            let list = Array::new();
            for argument in arguments {
                list.push(argument);
            }
            Reflect::construct(class(registered), &list).unwrap_throw()
        }
        None => js_sys::Error::new(
            "corpus-format: import the package entry point, which registers the error classes",
        )
        .into(),
    })
}

fn corpus_error(message: &str) -> JsValue {
    construct(
        |classes| &classes.corpus_error,
        &[JsValue::from_str(message)],
    )
}

fn type_error(message: &str) -> JsValue {
    js_sys::TypeError::new(message).into()
}

/// A JavaScript string of the code units, built in pieces: `String.fromCharCode` takes its arguments from the call stack, so one call for a long text overflows it.
fn js_string(units: &[u16]) -> JsString {
    const PIECE: usize = 4096;
    units.chunks(PIECE).fold(JsString::from(""), |text, piece| {
        text.concat(&JsString::from_char_code(piece))
    })
}

fn units_of(text: &JsString) -> Vec<u16> {
    text.iter().collect()
}

fn set(object: &Object, key: &str, value: &JsValue) {
    Reflect::set(object, &JsValue::from_str(key), value).unwrap_throw();
}

fn get(object: &JsValue, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(object, &JsValue::from_str(key))
}

fn index_to_js(index: usize) -> JsValue {
    JsValue::from_f64(f64::from(u32::try_from(index).unwrap_throw()))
}

fn problem_to_js(problem: &Problem) -> JsValue {
    let object = Object::new();
    set(&object, "offset", &index_to_js(problem.offset));
    set(&object, "message", &JsValue::from_str(&problem.message));
    object.into()
}

fn mismatch_to_js(mismatch: &Mismatch) -> JsValue {
    let object = Object::new();
    set(&object, "path", &JsValue::from_str(&mismatch.path));
    set(&object, "message", &JsValue::from_str(&mismatch.message));
    object.into()
}

fn strings_to_js(strings: &[String]) -> Array {
    let array = Array::new();
    for text in strings {
        array.push(&JsValue::from_str(text));
    }
    array
}

fn string_of(value: &JsValue, what: &str) -> Result<String, JsValue> {
    value
        .dyn_ref::<JsString>()
        .and_then(|text| String::from_utf16(&units_of(text)).ok())
        .ok_or_else(|| type_error(&format!("{what} must be a string")))
}

fn array_of(value: &JsValue, what: &str) -> Result<Array, JsValue> {
    if Array::is_array(value) {
        Ok(Array::from(value))
    } else {
        Err(type_error(&format!("{what} must be an array")))
    }
}

fn document(text: &JsValue, what: &str) -> Result<Value, JsValue> {
    let text = string_of(text, what)?;
    serde_json::from_str::<Value>(&text)
        .map_err(|error| corpus_error(&format!("{what} is not a JSON document: {error}")))
}

fn implementation(value: &JsValue) -> Result<Implementation, JsValue> {
    match value.as_string().as_deref() {
        Some("ts") => Ok(Implementation::Ts),
        Some("rust") => Ok(Implementation::Rust),
        _ => Err(type_error("an implementation is \"ts\" or \"rust\"")),
    }
}

fn requirement(name: &str) -> Result<Requirement, JsValue> {
    match name {
        "ecmascript-regex" => Ok(Requirement::EcmascriptRegex),
        other => Err(corpus_error(&format!("{other} is not a requirement"))),
    }
}

/// Which files under a corpus root are corpus files. `entries` are the paths of the tree, relative to the root, and what each is; `depth` is how many directories hold a corpus file (two for `<package>/<area>/<name>.json`).
#[wasm_bindgen(unchecked_return_type = "Selection")]
pub fn select(
    #[wasm_bindgen(unchecked_param_type = "readonly TreeEntry[]")] entries: &JsValue,
    depth: u32,
) -> Result<JsValue, JsValue> {
    let mut tree = Tree::new();
    for entry in array_of(entries, "entries")?.iter() {
        let path = string_of(&get(&entry, "path")?, "an entry's path")?;
        let kind = match get(&entry, "kind")?.as_string().as_deref() {
            Some("file") => Entry::File(Vec::new()),
            Some("directory") => Entry::Directory,
            Some("other") => Entry::Other,
            _ => {
                return Err(type_error(
                    "an entry's kind is \"file\", \"directory\" or \"other\"",
                ));
            }
        };
        tree.insert(path, kind);
    }
    let selection = corpus_format::select(
        &tree,
        Layout {
            depth: depth as usize,
        },
    );
    let result = Object::new();
    set(&result, "files", &strings_to_js(&selection.files));
    set(&result, "problems", &strings_to_js(&selection.problems));
    Ok(result.into())
}

/// The first thing that keeps a file from being canonical, or `undefined` when the bytes are exactly what `writeCanonical` writes for the document they hold.
#[wasm_bindgen(js_name = checkCanonical, unchecked_return_type = "Problem | undefined")]
pub fn check_canonical(bytes: &[u8]) -> JsValue {
    match corpus_format::check_canonical(bytes) {
        Ok(()) => JsValue::UNDEFINED,
        Err(problem) => problem_to_js(&problem),
    }
}

/// Everything the content rules find wrong with a document (keys out of order or repeated, an unpaired surrogate, a number not in its shortest form), in the order found.
#[wasm_bindgen(js_name = keyProblems, unchecked_return_type = "Problem[]")]
pub fn key_problems(bytes: &[u8]) -> Array {
    let problems = Array::new();
    for problem in corpus_format::key_problems(bytes) {
        problems.push(&problem_to_js(&problem));
    }
    problems
}

/// The canonical text of a JSON document: keys in UTF-16 code unit order, two-space indent, one element per line, one final line feed.
#[wasm_bindgen(js_name = writeCanonical)]
pub fn write_canonical(
    #[wasm_bindgen(unchecked_param_type = "string")] json: &JsValue,
) -> Result<String, JsValue> {
    corpus_format::write_canonical(&document(json, "the document")?)
        .map_err(|problem| corpus_error(&problem.to_string()))
}

fn decoded_to_js(value: &Decoded) -> JsValue {
    match value {
        Decoded::Null => JsValue::NULL,
        Decoded::Bool(flag) => JsValue::from_bool(*flag),
        Decoded::Number(number) => JsValue::from_f64(*number),
        Decoded::Text(units) => js_string(units).into(),
        Decoded::Undefined => JsValue::UNDEFINED,
        Decoded::Array(items) => {
            let array = Array::new();
            for item in items {
                array.push(&decoded_to_js(item));
            }
            array.into()
        }
        Decoded::Object(members) => {
            let object = Object::new();
            for (name, item) in members {
                Reflect::set(&object, &js_string(name), &decoded_to_js(item)).unwrap_throw();
            }
            object.into()
        }
        Decoded::Custom { .. } => JsValue::UNDEFINED,
    }
}

/// The value a document's encodings stand for: `{ "$number": "-0" }` is a negative zero, `{ "$undefined": true }` is `undefined`, `{ "codeUnits": [...] }` is the string of those code units, and `{ "$object": [[name, value], ...] }` an object whose members are in the order given. A member `$` followed by any other name, or an encoding with another member beside it or a value of the wrong form, throws a `DecodeError`.
#[wasm_bindgen(unchecked_return_type = "unknown")]
pub fn decode(
    #[wasm_bindgen(unchecked_param_type = "string")] json: &JsValue,
) -> Result<JsValue, JsValue> {
    let value = document(json, "the document")?;
    corpus_format::decode(&value, &Encodings::shared())
        .map(|decoded| decoded_to_js(&decoded))
        .map_err(|error| {
            construct(
                |classes| &classes.decode_error,
                &[
                    JsValue::from_str(&error.message),
                    JsValue::from_str(&error.path),
                ],
            )
        })
}

/// The deepest a compared JavaScript value may nest, so a cyclic value is refused instead of overflowing the stack.
const MAX_COMPARED_DEPTH: usize = 512;

fn decoded_of(value: &JsValue, depth: usize) -> Result<Decoded, JsValue> {
    if depth > MAX_COMPARED_DEPTH {
        return Err(type_error(
            "a compared value is nested too deeply, or cyclic",
        ));
    }
    if value.is_undefined() {
        Ok(Decoded::Undefined)
    } else if value.is_null() {
        Ok(Decoded::Null)
    } else if let Some(flag) = value.as_bool() {
        Ok(Decoded::Bool(flag))
    } else if let Some(number) = value.as_f64() {
        Ok(Decoded::Number(number))
    } else if let Some(text) = value.dyn_ref::<JsString>() {
        Ok(Decoded::Text(units_of(text)))
    } else if Array::is_array(value) {
        Array::from(value)
            .iter()
            .map(|item| decoded_of(&item, depth + 1))
            .collect::<Result<_, _>>()
            .map(Decoded::Array)
    } else if value.is_object() && !value.is_function() {
        let mut members = Vec::new();
        for key in Object::keys(value.unchecked_ref::<Object>()).iter() {
            let name = key
                .dyn_ref::<JsString>()
                .map(units_of)
                .ok_or_else(|| type_error("a member name is a string"))?;
            let member = Reflect::get(value, &key)?;
            members.push((name, decoded_of(&member, depth + 1)?));
        }
        Ok(Decoded::Object(members))
    } else {
        Err(type_error(
            "a compared value is undefined, null, a boolean, a number, a string, an array or a plain object",
        ))
    }
}

fn tolerance_of(value: &JsValue) -> Result<Option<Tolerance>, JsValue> {
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    let ulps = get(value, "ulps")?;
    let absolute = get(value, "absolute")?;
    match (ulps.as_f64(), absolute.as_f64()) {
        (Some(ulps), None) if ulps >= 0.0 && ulps.fract() == 0.0 => Ok(Some(Tolerance::Ulps {
            // A non-negative whole double, which `u64` holds as far as a double does.
            ulps: ulps as u64,
        })),
        (None, Some(absolute)) if absolute > 0.0 => Ok(Some(Tolerance::Absolute { absolute })),
        _ => Err(type_error(
            "a tolerance is { ulps: a non-negative integer } or { absolute: a positive number }",
        )),
    }
}

/// Where `actual` is not equal to `expected`, or `undefined` when it is. Numbers are the same double unless a tolerance is given (`-0` is not `0`); a member of `actual` whose value is `undefined` counts as absent.
#[wasm_bindgen(unchecked_return_type = "Mismatch | undefined")]
pub fn compare(
    #[wasm_bindgen(unchecked_param_type = "unknown")] actual: &JsValue,
    #[wasm_bindgen(unchecked_param_type = "unknown")] expected: &JsValue,
    #[wasm_bindgen(unchecked_param_type = "Tolerance | undefined")] tolerance: &JsValue,
) -> Result<JsValue, JsValue> {
    let tolerance = tolerance_of(tolerance)?;
    Ok(
        match corpus_format::compare(
            &decoded_of(actual, 0)?,
            &decoded_of(expected, 0)?,
            tolerance.as_ref(),
        ) {
            Ok(()) => JsValue::UNDEFINED,
            Err(mismatch) => mismatch_to_js(&mismatch),
        },
    )
}

/// Where `actual` does not match `expected`, which names only some of the members, or `undefined` when it does.
#[wasm_bindgen(unchecked_return_type = "Mismatch | undefined")]
pub fn subset(
    #[wasm_bindgen(unchecked_param_type = "unknown")] actual: &JsValue,
    #[wasm_bindgen(unchecked_param_type = "unknown")] expected: &JsValue,
    #[wasm_bindgen(unchecked_param_type = "Tolerance | undefined")] tolerance: &JsValue,
) -> Result<JsValue, JsValue> {
    let tolerance = tolerance_of(tolerance)?;
    Ok(
        match corpus_format::subset(
            &decoded_of(actual, 0)?,
            &decoded_of(expected, 0)?,
            tolerance.as_ref(),
        ) {
            Ok(()) => JsValue::UNDEFINED,
            Err(mismatch) => mismatch_to_js(&mismatch),
        },
    )
}

/// Why the fragments do not occur in `text` in order, each after the end of the one before, or `undefined` when they do. All as UTF-16 code units.
#[wasm_bindgen(unchecked_return_type = "string | undefined")]
pub fn fragments(
    #[wasm_bindgen(unchecked_param_type = "string")] text: &JsValue,
    #[wasm_bindgen(unchecked_param_type = "readonly string[]")] fragments: &JsValue,
    ignore_ascii_case: bool,
) -> Result<JsValue, JsValue> {
    let text = text
        .dyn_ref::<JsString>()
        .map(units_of)
        .ok_or_else(|| type_error("text must be a string"))?;
    let mut wanted = Vec::new();
    for fragment in array_of(fragments, "fragments")?.iter() {
        wanted.push(
            fragment
                .dyn_ref::<JsString>()
                .map(units_of)
                .ok_or_else(|| type_error("a fragment must be a string"))?,
        );
    }
    Ok(
        match corpus_format::fragments(&text, &wanted, ignore_ascii_case) {
            Ok(()) => JsValue::UNDEFINED,
            Err(message) => JsValue::from_str(&message),
        },
    )
}

fn corpus_of(value: &JsValue) -> Result<Vec<CorpusFile>, JsValue> {
    let mut files = Vec::new();
    for file in array_of(value, "the corpus")?.iter() {
        let name = string_of(&get(&file, "name")?, "a file's name")?;
        let mut cases = Vec::new();
        for case in array_of(&get(&file, "cases")?, "a file's cases")?.iter() {
            let id = string_of(&get(&case, "id")?, "a case's id")?;
            let skip = match get(&case, "skip")?.as_string().as_deref() {
                None => None,
                Some("ts") => Some(Skip::Ts),
                Some("rust") => Some(Skip::Rust),
                Some(_) => return Err(type_error("a case's skip is \"ts\" or \"rust\"")),
            };
            let requires = match get(&case, "requires")? {
                list if list.is_undefined() => Vec::new(),
                list => array_of(&list, "a case's requires")?
                    .iter()
                    .map(|name| requirement(&string_of(&name, "a requirement")?))
                    .collect::<Result<_, _>>()?,
            };
            cases.push(CaseSummary { id, skip, requires });
        }
        files.push(CorpusFile { name, cases });
    }
    Ok(files)
}

/// The manifest a document holds, read by the parser that checks the canonical form, so a member given twice is refused and not merged. `depth` is how many directories hold a corpus file.
fn manifest_of(json: &JsValue, depth: u32) -> Result<Manifest, JsValue> {
    let text = string_of(json, "the manifest")?;
    let value = corpus_format::parse_canonical(text.as_bytes())
        .map_err(|problem| corpus_error(&format!("the manifest: {problem}")))?;
    Manifest::from_value(&value, depth as usize).map_err(|message| corpus_error(&message))
}

/// Everything wrong between the corpus as read and the manifest document: a file in one and not the other, a case count that differs, an id repeated, a skip or requirement list that is not the set of cases that carry the mark. An empty list is a corpus that is what the manifest says it is. A manifest that is not a well-formed canonical document, or names a file at another depth than `depth`, throws a `CorpusFormatError`.
#[wasm_bindgen(js_name = manifestProblems, unchecked_return_type = "string[]")]
pub fn manifest_problems(
    #[wasm_bindgen(unchecked_param_type = "readonly CorpusFile[]")] corpus: &JsValue,
    #[wasm_bindgen(unchecked_param_type = "string")] manifest: &JsValue,
    depth: u32,
) -> Result<Array, JsValue> {
    Ok(strings_to_js(&corpus_format::manifest_problems(
        &corpus_of(corpus)?,
        &manifest_of(manifest, depth)?,
    )))
}

/// A run's record of its cases, made as the run goes.
#[wasm_bindgen(js_name = Completeness)]
pub struct JsCompleteness {
    inner: Completeness,
}

#[wasm_bindgen(js_class = Completeness)]
impl JsCompleteness {
    /// A record for a run of the manifest's files whose path starts with `prefix` (all of them without one).
    #[wasm_bindgen(constructor)]
    pub fn new(prefix: Option<String>) -> JsCompleteness {
        JsCompleteness {
            inner: prefix
                .as_deref()
                .map_or_else(Completeness::new, Completeness::scoped),
        }
    }

    /// A case's test is registered.
    pub fn register(&mut self, id: &str) {
        self.inner.register(id);
    }

    /// A case's body began.
    pub fn started(&mut self, id: &str) {
        self.inner.started(id);
    }

    /// A case is skipped, and why.
    pub fn skipped(&mut self, id: &str, why: &str) {
        self.inner.skipped(id, why);
    }

    /// What is wrong between the record and the manifest document (corpus files `depth` directories down), for a run of `implementation` that provides `provides`; empty when the run is complete.
    #[wasm_bindgen(unchecked_return_type = "string[]")]
    pub fn finish(
        &self,
        #[wasm_bindgen(unchecked_param_type = "string")] manifest: &JsValue,
        #[wasm_bindgen(unchecked_param_type = "ImplementationName")] which: &JsValue,
        #[wasm_bindgen(unchecked_param_type = "readonly string[]")] provides: &JsValue,
        depth: u32,
    ) -> Result<Array, JsValue> {
        let provided = array_of(provides, "provides")?
            .iter()
            .map(|name| requirement(&string_of(&name, "a requirement")?))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(
            match self.inner.finish(
                &manifest_of(manifest, depth)?,
                implementation(which)?,
                &provided,
            ) {
                Ok(()) => Array::new(),
                Err(problems) => strings_to_js(&problems),
            },
        )
    }
}
