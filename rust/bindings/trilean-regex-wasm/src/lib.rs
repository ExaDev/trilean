//! The wasm binding of `trilean-regex`.
//!
//! The API is the one the TypeScript implementation had: trees and errors cross as plain JavaScript values, and a string crosses as the UTF-16 code units it is, so an unpaired surrogate behaves as it always has. The error classes are JavaScript, written by the package build beside the generated binding and handed to `registerErrorClasses` by the package's entry point.

use std::cell::RefCell;

use js_sys::{Array, Function, JsString, Object, Reflect};
use trilean_regex::{
    CharClassNode, CharRange, CompiledPattern, EcmaSubsetError, RegexNode, RegexParseError,
    ShorthandClassLetter, compile_ecmascript_subset_utf16, compile_pattern_utf16,
    expand_shorthand_class, parse_regex_utf16,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const SYNTAX_TREE_TYPES: &str = r#"
/** A single literal character, matched by its UTF-16 code unit value. */
export interface LiteralNode {
  readonly kind: "literal";
  readonly codeUnit: number;
}

/** `.`: exactly one character of any value, a line terminator included. */
export interface AnyCharNode {
  readonly kind: "anyChar";
}

/** An inclusive range of code units within a character class. A single character `c` is `{ from: c, to: c }`. */
export interface CharRange {
  readonly from: number;
  readonly to: number;
}

/** `[...]` and `[^...]`, and the standalone shorthand classes once expanded. `ranges` is the positive set and `negated` flips membership, so a negated class still reports the ranges it was written against. */
export interface CharClassNode {
  readonly kind: "charClass";
  readonly negated: boolean;
  readonly ranges: readonly CharRange[];
}

/** `^`: the position is the start of the input. */
export interface AnchorStartNode {
  readonly kind: "anchorStart";
}

/** `$`: the position is the end of the input. */
export interface AnchorEndNode {
  readonly kind: "anchorEnd";
}

/** The operands one after another. No operands is the empty pattern. */
export interface ConcatNode {
  readonly kind: "concat";
  readonly operands: readonly RegexNode[];
}

/** `a|b|c`: exactly one of the branches matches. There are always at least two. */
export interface AlternationNode {
  readonly kind: "alternation";
  readonly branches: readonly RegexNode[];
}

/** `a*`: zero or more repetitions of the operand. */
export interface StarNode {
  readonly kind: "star";
  readonly operand: RegexNode;
}

/** `a+`: one or more repetitions of the operand. */
export interface PlusNode {
  readonly kind: "plus";
  readonly operand: RegexNode;
}

/** `a?`: zero or one repetition of the operand. */
export interface OptionalNode {
  readonly kind: "optional";
  readonly operand: RegexNode;
}

/** `a{min,max}`: between `min` and `max` repetitions, `max: undefined` meaning no upper bound. The parser never builds `min > max`, and never a shape `star`, `plus` or `optional` already covers. */
export interface RepeatNode {
  readonly kind: "repeat";
  readonly operand: RegexNode;
  readonly min: number;
  readonly max: number | undefined;
}

/** The syntax tree the parser produces. */
export type RegexNode =
  | LiteralNode
  | AnyCharNode
  | CharClassNode
  | AnchorStartNode
  | AnchorEndNode
  | ConcatNode
  | AlternationNode
  | StarNode
  | PlusNode
  | OptionalNode
  | RepeatNode;

/** The letter a shorthand class is written with: upper case negates the class of the lower case. */
export type ShorthandClassLetter = "d" | "D" | "w" | "W" | "s" | "S";
"#;

/// The error classes the package's entry point registers, which are written beside the generated binding.
struct ErrorClasses {
    parse_error: Function,
    unsupported_construct: Function,
    internal_error: Function,
}

thread_local! {
    static CLASSES: RefCell<Option<ErrorClasses>> = const { RefCell::new(None) };
}

/// Hands the binding the classes it throws and installs the panic hook that throws one of them. The package's entry point calls it once, with `RegexParseError`, `UnsupportedConstructError` and `InternalError` in that order, before anything else in the package can run; the classes are JavaScript, so the binding is given them rather than importing them.
///
/// A panic in Rust would otherwise reach JavaScript as a bare `RuntimeError: unreachable` with no message. The hook throws an `InternalError` carrying the panic's message and location instead, from inside the panic, so the module is not usable afterwards in the strict sense: the panic never finishes unwinding, and a second panic in the same instance traps as before. A caller that gets an `InternalError` should treat the instance as spent and report the message.
#[wasm_bindgen(js_name = registerErrorClasses)]
pub fn register_error_classes(
    parse_error: Function,
    unsupported_construct: Function,
    internal_error: Function,
) {
    CLASSES.with(|classes| {
        *classes.borrow_mut() = Some(ErrorClasses {
            parse_error,
            unsupported_construct,
            internal_error,
        });
    });
    std::panic::set_hook(Box::new(|info| {
        let message = format!("trilean-regex: internal error: {info}");
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

/// Panics on purpose, so that a test can see the panic hook turn it into an `InternalError`. The package's entry point does not export it.
#[wasm_bindgen(js_name = panicForTesting)]
pub fn panic_for_testing() {
    panic!("deliberate panic for the test of the panic hook");
}

/// The argument as a JavaScript string, or a `TypeError` naming it. A value that merely converts to text (a number, an object with `toString`, a `String` object) is not accepted: a pattern or a subject is a string.
fn string_argument(value: &JsValue, name: &str) -> Result<JsString, JsValue> {
    value
        .dyn_ref::<JsString>()
        .cloned()
        .ok_or_else(|| js_sys::TypeError::new(&format!("{name} must be a string")).into())
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
            "trilean-regex: import the package entry point, which registers the error classes",
        )
        .into(),
    })
}

/// The code units of a JavaScript string, read one at a time so that an unpaired surrogate is kept, which converting to a Rust `String` would replace.
fn code_units(text: &JsString) -> Vec<u16> {
    text.iter().collect()
}

fn index_to_js(index: usize) -> u32 {
    u32::try_from(index).unwrap_throw()
}

fn parse_error(error: &RegexParseError, pattern: &JsString) -> JsValue {
    construct(
        |classes| &classes.parse_error,
        &[
            JsString::from_char_code(&error.message_utf16()).into(),
            pattern.into(),
            index_to_js(error.index()).into(),
        ],
    )
}

fn subset_error(error: &EcmaSubsetError, pattern: &JsString) -> JsValue {
    match error {
        EcmaSubsetError::Parse(error) => parse_error(error, pattern),
        EcmaSubsetError::Unsupported {
            index,
            construct: text,
        } => construct(
            |classes| &classes.unsupported_construct,
            &[
                JsString::from(error.to_string().as_str()).into(),
                index_to_js(*index).into(),
                JsValue::from_str(text),
            ],
        ),
    }
}

fn set(object: &Object, key: &str, value: &JsValue) {
    Reflect::set(object, &JsValue::from_str(key), value).unwrap_throw();
}

fn tagged(kind: &str) -> Object {
    let object = Object::new();
    set(&object, "kind", &JsValue::from_str(kind));
    object
}

fn operand_node(kind: &str, operand: &RegexNode) -> JsValue {
    let object = tagged(kind);
    set(&object, "operand", &node_to_js(operand));
    object.into()
}

fn nodes_to_js(nodes: &[RegexNode]) -> Array {
    let array = Array::new();
    for node in nodes {
        array.push(&node_to_js(node));
    }
    array
}

fn class_to_js(class: &CharClassNode) -> JsValue {
    let object = tagged("charClass");
    set(&object, "negated", &JsValue::from_bool(class.negated));
    let ranges = Array::new();
    for range in &class.ranges {
        let entry = Object::new();
        set(&entry, "from", &JsValue::from_f64(f64::from(range.from)));
        set(&entry, "to", &JsValue::from_f64(f64::from(range.to)));
        ranges.push(&entry);
    }
    set(&object, "ranges", &ranges);
    object.into()
}

fn node_to_js(node: &RegexNode) -> JsValue {
    match node {
        RegexNode::Literal { code_unit } => {
            let object = tagged("literal");
            set(
                &object,
                "codeUnit",
                &JsValue::from_f64(f64::from(*code_unit)),
            );
            object.into()
        }
        RegexNode::AnyChar => tagged("anyChar").into(),
        RegexNode::CharClass(class) => class_to_js(class),
        RegexNode::AnchorStart => tagged("anchorStart").into(),
        RegexNode::AnchorEnd => tagged("anchorEnd").into(),
        RegexNode::Concat(operands) => {
            let object = tagged("concat");
            set(&object, "operands", &nodes_to_js(operands));
            object.into()
        }
        RegexNode::Alternation(branches) => {
            let object = tagged("alternation");
            set(&object, "branches", &nodes_to_js(branches));
            object.into()
        }
        RegexNode::Star(operand) => operand_node("star", operand),
        RegexNode::Plus(operand) => operand_node("plus", operand),
        RegexNode::Optional(operand) => operand_node("optional", operand),
        RegexNode::Repeat { operand, min, max } => {
            let object = tagged("repeat");
            set(&object, "operand", &node_to_js(operand));
            set(&object, "min", &JsValue::from_f64(f64::from(*min)));
            // The property is present with the value `undefined` for an unbounded repeat, as it always was.
            set(
                &object,
                "max",
                &max.map_or(JsValue::UNDEFINED, |max| JsValue::from_f64(f64::from(max))),
            );
            object.into()
        }
    }
}

fn property(object: &JsValue, key: &str) -> Result<JsValue, JsValue> {
    Reflect::get(object, &JsValue::from_str(key))
}

/// The code unit a JavaScript number is, if it is one: a whole number from 0 to 65535.
fn as_code_unit(value: f64) -> Option<u16> {
    (value.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(&value)).then_some(value as u16)
}

fn code_unit_property(object: &JsValue, key: &str) -> Result<u16, JsValue> {
    property(object, key)?
        .as_f64()
        .and_then(as_code_unit)
        .ok_or_else(|| {
            js_sys::TypeError::new(&format!(
                "\"{key}\" must be a code unit, a whole number from 0 to 65535"
            ))
            .into()
        })
}

fn range_from_js(range: &JsValue) -> Result<CharRange, JsValue> {
    Ok(CharRange {
        from: code_unit_property(range, "from")?,
        to: code_unit_property(range, "to")?,
    })
}

fn class_from_js(node: &JsValue) -> Result<CharClassNode, JsValue> {
    let ranges = property(node, "ranges")?;
    if !Array::is_array(&ranges) {
        return Err(js_sys::TypeError::new("\"ranges\" must be an array").into());
    }
    Ok(CharClassNode {
        negated: property(node, "negated")?.is_truthy(),
        ranges: ranges
            .unchecked_into::<Array>()
            .iter()
            .map(|range| range_from_js(&range))
            .collect::<Result<_, _>>()?,
    })
}

/// Whether `unit` falls inside an inclusive range. A number that is no code unit is in no range.
#[wasm_bindgen(js_name = rangeContains)]
pub fn range_contains(
    #[wasm_bindgen(unchecked_param_type = "CharRange")] range: &JsValue,
    unit: f64,
) -> Result<bool, JsValue> {
    let range = range_from_js(range)?;
    Ok(as_code_unit(unit).is_some_and(|unit| trilean_regex::range_contains(&range, unit)))
}

/// Whether `unit` is a member of a character class, honouring `negated`. A number that is no code unit is in no range, so a negated class holds it.
#[wasm_bindgen(js_name = charClassMatches)]
pub fn char_class_matches(
    #[wasm_bindgen(unchecked_param_type = "CharClassNode")] node: &JsValue,
    unit: f64,
) -> Result<bool, JsValue> {
    let class = class_from_js(node)?;
    Ok(match as_code_unit(unit) {
        Some(unit) => trilean_regex::char_class_matches(&class, unit),
        None => class.negated,
    })
}

/// Expands a shorthand class letter to the class it stands for.
#[wasm_bindgen(js_name = expandShorthandClass, unchecked_return_type = "CharClassNode")]
pub fn expand_shorthand(
    #[wasm_bindgen(unchecked_param_type = "ShorthandClassLetter")] letter: &JsValue,
) -> Result<JsValue, JsValue> {
    let units = code_units(&string_argument(letter, "letter")?);
    match units.as_slice() {
        [unit] => ShorthandClassLetter::from_unit(*unit)
            .map(|letter| class_to_js(&expand_shorthand_class(letter)))
            .ok_or_else(|| js_sys::TypeError::new("unknown shorthand class letter").into()),
        _ => Err(js_sys::TypeError::new("a shorthand class letter is one character").into()),
    }
}

/// Parses a pattern in this package's grammar into its syntax tree.
///
/// Never returns a partial result: a pattern parses completely or `RegexParseError` is thrown, naming where parsing could not proceed. The index counts UTF-16 code units.
#[wasm_bindgen(js_name = parseRegex, unchecked_return_type = "RegexNode")]
pub fn parse_regex(
    #[wasm_bindgen(unchecked_param_type = "string")] pattern: &JsValue,
) -> Result<JsValue, JsValue> {
    let pattern = &string_argument(pattern, "pattern")?;
    parse_regex_utf16(&code_units(pattern))
        .map(|node| node_to_js(&node))
        .map_err(|error| parse_error(&error, pattern))
}

/// A parsed and compiled pattern, ready to test any number of inputs without parsing or compiling again.
#[wasm_bindgen(js_name = CompiledPattern)]
pub struct JsCompiledPattern {
    compiled: CompiledPattern,
}

#[wasm_bindgen(js_class = CompiledPattern)]
impl JsCompiledPattern {
    /// Whether any substring of `input` matches this pattern. The work is bounded by the pattern's size and the input's length, whatever the pattern is.
    pub fn test(
        &self,
        #[wasm_bindgen(unchecked_param_type = "string")] input: &JsValue,
    ) -> Result<bool, JsValue> {
        let input = string_argument(input, "input")?;
        Ok(self.compiled.test_utf16(&code_units(&input)))
    }
}

/// Parses `pattern` and compiles it to a matcher.
///
/// Prefer this over `testPattern` when the same pattern is tested against more than one input: it parses and compiles once.
///
/// @throws `RegexParseError` if `pattern` is not a valid pattern in this grammar.
#[wasm_bindgen(js_name = compilePattern)]
pub fn compile_pattern(
    #[wasm_bindgen(unchecked_param_type = "string")] pattern: &JsValue,
) -> Result<JsCompiledPattern, JsValue> {
    let pattern = &string_argument(pattern, "pattern")?;
    compile_pattern_utf16(&code_units(pattern))
        .map(|compiled| JsCompiledPattern { compiled })
        .map_err(|error| parse_error(&error, pattern))
}

/// Parses `pattern` and tests it against `input` in one call.
///
/// @throws `RegexParseError` if `pattern` is not a valid pattern in this grammar.
#[wasm_bindgen(js_name = testPattern)]
pub fn test_pattern(
    #[wasm_bindgen(unchecked_param_type = "string")] pattern: &JsValue,
    #[wasm_bindgen(unchecked_param_type = "string")] input: &JsValue,
) -> Result<bool, JsValue> {
    let (pattern, input) = (
        &string_argument(pattern, "pattern")?,
        string_argument(input, "input")?,
    );
    compile_pattern_utf16(&code_units(pattern))
        .map(|compiled| compiled.test_utf16(&code_units(&input)))
        .map_err(|error| parse_error(&error, pattern))
}

/// Compiles `pattern` only when every construct in it means the same as in an unflagged ECMAScript `RegExp`.
///
/// `.`, `\s` and `\S` outside a class holding every code unit, and a braced quantifier with nothing to repeat, are refused.
///
/// @throws `RegexParseError` if `pattern` is not a valid pattern in this grammar, and `UnsupportedConstructError` if a construct in it means something else in ECMAScript.
#[wasm_bindgen(js_name = compileEcmascriptSubset)]
pub fn compile_ecmascript_subset(
    #[wasm_bindgen(unchecked_param_type = "string")] pattern: &JsValue,
) -> Result<JsCompiledPattern, JsValue> {
    let pattern = &string_argument(pattern, "pattern")?;
    compile_ecmascript_subset_utf16(&code_units(pattern))
        .map(|compiled| JsCompiledPattern { compiled })
        .map_err(|error| subset_error(&error, pattern))
}
