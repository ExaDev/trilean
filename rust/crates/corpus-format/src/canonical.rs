//! The one byte form a corpus file has, so every loader reads the same bytes the same way and a regenerated file
//! differs from the committed one only where its content does.
//!
//! A canonical file is UTF-8 without a byte order mark and ends in one line feed. Two spaces indent each level, every
//! array element and object member is on a line of its own, an empty array or object is `[]` or `{}`, and a member is
//! `"key": value`. Object keys are in strictly ascending UTF-16 code unit order (which puts `"10"` before `"2"`, as
//! `JSON.stringify` of an array of keys sorted by `<` does, and never as a JavaScript object does), without a repeat.
//! A number is written as `JSON.stringify` writes the double it denotes, so `97.0`, `1e2` and `-0` are refused (an
//! integer written `97.0` is still the integer 97 when a typed reader reads it; this is a rule about bytes). A string
//! holds only the escapes JSON requires (the quote, the backslash and the control characters below U+0020, as `\b`,
//! `\f`, `\n`, `\r`, `\t` or `\u00xx`), every other character literally, and no unpaired surrogate, in a key or a value.
//! Nesting is at most [`MAX_DEPTH`] levels.
//!
//! The check reads the text itself, in one pass with a parser that keeps every pair as written, because a general
//! JSON reader merges a repeated key and reorders the rest, which are the things the rule is about.

use std::fmt;

use json_shape::Value;

use crate::name::utf16_order;

/// The deepest nesting a corpus file may have: a document that is one array holding one array, and so on, has that
/// many levels at most. It is the same value in every loader, because the parsers differ in what they accept
/// (`serde_json` refuses more than 128 levels, `JSON.parse` has no limit short of the stack).
pub const MAX_DEPTH: usize = 64;

/// What is wrong with a document and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// The byte offset in the document the problem was found at.
    pub offset: usize,
    pub message: String,
}

impl fmt::Display for Problem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "at byte {}: {}", self.offset, self.message)
    }
}

/// A document with every object pair as it was written.
enum Doc {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Doc>),
    Object(Vec<(String, Doc)>),
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    position: usize,
    /// The problems of the content that do not stop the read: key order, a repeated key, an unpaired surrogate, a
    /// number not in its shortest form.
    problems: Vec<Problem>,
    /// The UTF-16 code units of the string `string` read last, an unpaired surrogate included, which a Rust string cannot hold.
    units: Vec<u16>,
}

fn push_char(units: &mut Vec<u16>, character: char) {
    units.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
}

fn problem(offset: usize, message: impl Into<String>) -> Problem {
    Problem {
        offset,
        message: message.into(),
    }
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Parser {
            bytes: text.as_bytes(),
            text,
            position: 0,
            problems: Vec::new(),
            units: Vec::new(),
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.position).copied()
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.position += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), Problem> {
        if self.peek() == Some(byte) {
            self.position += 1;
            Ok(())
        } else {
            Err(problem(
                self.position,
                format!("expected `{}`", char::from(byte)),
            ))
        }
    }

    fn literal(&mut self, word: &str) -> Result<(), Problem> {
        if self.text[self.position..].starts_with(word) {
            self.position += word.len();
            Ok(())
        } else {
            Err(problem(self.position, "not a JSON value"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Doc, Problem> {
        self.skip_space();
        match self.peek() {
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => Ok(Doc::String(self.string()?)),
            Some(b't') => self.literal("true").map(|()| Doc::Bool(true)),
            Some(b'f') => self.literal("false").map(|()| Doc::Bool(false)),
            Some(b'n') => self.literal("null").map(|()| Doc::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(problem(self.position, "not a JSON value")),
        }
    }

    fn enter(&self, depth: usize) -> Result<(), Problem> {
        if depth > MAX_DEPTH {
            Err(problem(
                self.position,
                format!("nesting is deeper than {MAX_DEPTH} levels"),
            ))
        } else {
            Ok(())
        }
    }

    fn array(&mut self, depth: usize) -> Result<Doc, Problem> {
        self.enter(depth)?;
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.position += 1;
            return Ok(Doc::Array(items));
        }
        loop {
            items.push(self.value(depth)?);
            self.skip_space();
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b']') => {
                    self.position += 1;
                    return Ok(Doc::Array(items));
                }
                _ => return Err(problem(self.position, "expected `,` or `]`")),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Doc, Problem> {
        self.enter(depth)?;
        self.expect(b'{')?;
        let mut pairs: Vec<(String, Doc)> = Vec::new();
        let mut last_units: Option<Vec<u16>> = None;
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.position += 1;
            return Ok(Doc::Object(pairs));
        }
        loop {
            self.skip_space();
            let key_at = self.position;
            if self.peek() != Some(b'"') {
                return Err(problem(self.position, "expected a key"));
            }
            let key = self.string()?;
            let key_units = std::mem::take(&mut self.units);
            if let Some(before) = &last_units
                && key_units <= *before
            {
                let before = String::from_utf16_lossy(before);
                self.problems.push(problem(
                    key_at,
                    format!(
                        "the key {key:?} follows {before:?}: keys are in ascending UTF-16 code-unit order, without repeats"
                    ),
                ));
            }
            last_units = Some(key_units);
            self.skip_space();
            self.expect(b':')?;
            let value = self.value(depth)?;
            pairs.push((key, value));
            self.skip_space();
            match self.peek() {
                Some(b',') => self.position += 1,
                Some(b'}') => {
                    self.position += 1;
                    return Ok(Doc::Object(pairs));
                }
                _ => return Err(problem(self.position, "expected `,` or `}`")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u16, Problem> {
        let digits = self
            .text
            .get(self.position..self.position + 4)
            .filter(|digits| digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| {
                problem(
                    self.position,
                    "`\\u` is not followed by four hexadecimal digits",
                )
            })?;
        self.position += 4;
        u16::from_str_radix(digits, 16).map_err(|error| problem(self.position, error.to_string()))
    }

    /// A string literal, escapes decoded. An unpaired surrogate escape is recorded as a problem and read as the
    /// replacement character, since a Rust string cannot hold it.
    fn string(&mut self) -> Result<String, Problem> {
        let start = self.position;
        self.expect(b'"')?;
        let mut units: Vec<u16> = Vec::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err(problem(start, "unterminated string"));
            };
            match byte {
                b'"' => {
                    self.position += 1;
                    self.units = units.clone();
                    return Ok(String::from_utf16_lossy(&units));
                }
                b'\\' => {
                    self.position += 1;
                    let Some(escape) = self.peek() else {
                        return Err(problem(start, "unterminated string"));
                    };
                    self.position += 1;
                    match escape {
                        b'"' => push_char(&mut units, '"'),
                        b'\\' => push_char(&mut units, '\\'),
                        b'/' => push_char(&mut units, '/'),
                        b'b' => push_char(&mut units, '\u{8}'),
                        b'f' => push_char(&mut units, '\u{c}'),
                        b'n' => push_char(&mut units, '\n'),
                        b'r' => push_char(&mut units, '\r'),
                        b't' => push_char(&mut units, '\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            match first {
                                0xD800..=0xDBFF => {
                                    let paired = self.text[self.position..].starts_with("\\u");
                                    let second = if paired {
                                        let saved = self.position;
                                        self.position += 2;
                                        let unit = self.hex4()?;
                                        if (0xDC00..=0xDFFF).contains(&unit) {
                                            Some(unit)
                                        } else {
                                            self.position = saved;
                                            None
                                        }
                                    } else {
                                        None
                                    };
                                    if let Some(second) = second {
                                        let code = 0x10000
                                            + ((u32::from(first) - 0xD800) << 10)
                                            + (u32::from(second) - 0xDC00);
                                        push_char(
                                            &mut units,
                                            char::from_u32(code).unwrap_or('\u{fffd}'),
                                        );
                                    } else {
                                        self.problems.push(problem(
                                            self.position,
                                            "a string holds an unpaired surrogate",
                                        ));
                                        units.push(first);
                                    }
                                }
                                0xDC00..=0xDFFF => {
                                    self.problems.push(problem(
                                        self.position,
                                        "a string holds an unpaired surrogate",
                                    ));
                                    units.push(first);
                                }
                                unit => units.push(unit),
                            }
                        }
                        _ => {
                            return Err(problem(self.position - 1, "not an escape of JSON"));
                        }
                    }
                }
                0..=0x1f => {
                    return Err(problem(
                        self.position,
                        "a control character in a string is written as an escape",
                    ));
                }
                _ => {
                    // The text is valid UTF-8, so a character starts at every non-continuation byte.
                    let character = self.text[self.position..]
                        .chars()
                        .next()
                        .ok_or_else(|| problem(self.position, "unterminated string"))?;
                    push_char(&mut units, character);
                    self.position += character.len_utf8();
                }
            }
        }
    }

    fn number(&mut self) -> Result<Doc, Problem> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.position += 1;
        }
        match self.peek() {
            Some(b'0') => self.position += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.position += 1;
                }
            }
            _ => return Err(problem(start, "not a JSON number")),
        }
        if self.peek() == Some(b'.') {
            self.position += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(problem(start, "not a JSON number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.position += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.position += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(problem(start, "not a JSON number"));
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.position += 1;
            }
        }
        let literal = &self.text[start..self.position];
        let number: f64 = literal
            .parse()
            .map_err(|_| problem(start, "not a JSON number"))?;
        if !number.is_finite() {
            return Err(problem(
                start,
                format!("{literal} is outside the range of a double"),
            ));
        }
        let shortest = Value::Number(number).to_string();
        if shortest != literal {
            self.problems.push(problem(
                start,
                format!("the number {literal} is written {shortest} in its shortest form"),
            ));
        }
        Ok(Doc::Number(number))
    }
}

fn into_value(doc: Doc) -> Value {
    match doc {
        Doc::Null => Value::Null,
        Doc::Bool(flag) => Value::Bool(flag),
        Doc::Number(number) => Value::Number(number),
        Doc::String(text) => Value::String(text),
        Doc::Array(items) => Value::Array(items.into_iter().map(into_value).collect()),
        Doc::Object(pairs) => Value::Object(
            pairs
                .into_iter()
                .map(|(key, value)| (key, into_value(value)))
                .collect(),
        ),
    }
}

fn text_of(bytes: &[u8]) -> Result<&str, Problem> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(problem(0, "the document begins with a byte order mark"));
    }
    std::str::from_utf8(bytes)
        .map_err(|error| problem(error.valid_up_to(), "the document is not valid UTF-8"))
}

/// Every problem of the content of a document that is valid JSON, in the order found, and the document itself: the
/// keys out of order or repeated, a string with an unpaired surrogate, a number not in its shortest form. A document
/// that is not valid JSON, or nests too deeply, or does not begin right, is the one problem it is.
fn read(bytes: &[u8]) -> Result<(Vec<Problem>, Value), Problem> {
    let text = text_of(bytes)?;
    let mut parser = Parser::new(text);
    let doc = parser.value(0)?;
    parser.skip_space();
    if parser.position != parser.bytes.len() {
        return Err(problem(
            parser.position,
            "unexpected content after the document",
        ));
    }
    Ok((parser.problems, into_value(doc)))
}

/// Everything the content rules find wrong with a document, in the order found: a repeated key or one out of order
/// (keys are compared as the text they stand for, so an escaped spelling is read first), an unpaired surrogate in a
/// key or a value, a number not in its shortest form. An empty list does not mean the document is canonical (see
/// [`check_canonical`]), only that these rules hold. A document that does not parse, begins with a byte order mark,
/// is not UTF-8 or nests more than [`MAX_DEPTH`] levels is the one problem it is.
pub fn key_problems(bytes: &[u8]) -> Vec<Problem> {
    match read(bytes) {
        Ok((problems, _)) => problems,
        Err(single) => vec![single],
    }
}

/// The canonical text of a value. Object keys are written in UTF-16 code unit order, whatever order the pairs are in.
/// A value nested deeper than [`MAX_DEPTH`] is refused, since the text could not be read back by [`check_canonical`] and
/// writing it would recurse as deep as the value does.
pub fn write_canonical(value: &Value) -> Result<String, Problem> {
    let mut out = String::new();
    write_value(value, 0, &mut out)?;
    out.push('\n');
    Ok(out)
}

fn write_value(value: &Value, level: usize, out: &mut String) -> Result<(), Problem> {
    if matches!(value, Value::Array(_) | Value::Object(_)) && level + 1 > MAX_DEPTH {
        return Err(too_deep());
    }
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            for (position, item) in items.iter().enumerate() {
                out.push_str(&"  ".repeat(level + 1));
                write_value(item, level + 1, out)?;
                if position + 1 < items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&"  ".repeat(level));
            out.push(']');
        }
        Value::Object(pairs) if !pairs.is_empty() => {
            let mut sorted: Vec<&(String, Value)> = pairs.iter().collect();
            sorted.sort_by(|left, right| utf16_order(&left.0, &right.0));
            out.push_str("{\n");
            for (position, (key, item)) in sorted.iter().enumerate() {
                out.push_str(&"  ".repeat(level + 1));
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                write_value(item, level + 1, out)?;
                if position + 1 < sorted.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            out.push_str(&"  ".repeat(level));
            out.push('}');
        }
        Value::Array(_) => out.push_str("[]"),
        Value::Object(_) => out.push_str("{}"),
        scalar => out.push_str(&scalar.to_string()),
    }
    Ok(())
}

fn too_deep() -> Problem {
    problem(0, format!("nesting is deeper than {MAX_DEPTH} levels"))
}

/// The value a canonical document holds, read by the same parser that checks it, so the two cannot disagree. The layout is
/// not looked at (see [`check_canonical`]); the content is: a repeated key, a key out of order, an unpaired surrogate, a number not in its shortest form or nesting past [`MAX_DEPTH`] is the
/// first [`Problem`] found, and a document that is not valid JSON or UTF-8 is the one problem it is. The value keeps every
/// object pair as written.
pub fn parse_canonical(bytes: &[u8]) -> Result<Value, Problem> {
    let (problems, value) = read(bytes)?;
    match problems.into_iter().next() {
        Some(first) => Err(first),
        None => Ok(value),
    }
}

fn position_of(bytes: &[u8], offset: usize) -> (usize, usize) {
    let before = String::from_utf8_lossy(&bytes[..offset.min(bytes.len())]).into_owned();
    let line = before.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |last| last.chars().count())
        + 1;
    (line, column)
}

/// Whether the bytes are exactly what [`write_canonical`] writes for the document they hold, and the first thing
/// that is not, as a [`Problem`]. The content rules of [`key_problems`] come first, so a file with keys out of order
/// is reported for that and not for its layout.
pub fn check_canonical(bytes: &[u8]) -> Result<(), Problem> {
    let value = parse_canonical(bytes)?;
    let written = write_canonical(&value)?;
    if written.as_bytes() == bytes {
        return Ok(());
    }
    let offset = written
        .bytes()
        .zip(bytes.iter().copied())
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| written.len().min(bytes.len()));
    let (line, column) = position_of(bytes, offset);
    Err(problem(
        offset,
        format!(
            "not in canonical form: line {line}, column {column} differs from what the writer writes"
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(text: &str) {
        assert_eq!(check_canonical(text.as_bytes()), Ok(()), "{text:?}");
    }

    fn refused(text: &str, fragment: &str) {
        let outcome = check_canonical(text.as_bytes());
        let message = outcome.expect_err(text).message;
        assert!(message.contains(fragment), "{text:?}: {message}");
    }

    #[test]
    fn a_document_in_canonical_form_is_accepted() {
        canonical("1\n");
        canonical("null\n");
        canonical("[]\n");
        canonical("{}\n");
        canonical(
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": \"c\"\n    }\n  ],\n  \"d\": {}\n}\n",
        );
    }

    #[test]
    fn the_writer_writes_what_the_check_accepts() {
        let value = Value::Object(vec![
            (
                "b".to_owned(),
                Value::Array(vec![Value::Number(1.5), Value::Null]),
            ),
            ("a".to_owned(), Value::String("é\n\u{1}\"\\😀".to_owned())),
            ("10".to_owned(), Value::Bool(true)),
            ("2".to_owned(), Value::Array(Vec::new())),
        ]);
        let text = write_canonical(&value).unwrap();
        assert_eq!(check_canonical(text.as_bytes()), Ok(()), "{text}");
        assert!(text.find("\"10\"").unwrap() < text.find("\"2\"").unwrap());
        assert!(text.contains("\\n\\u0001\\\"\\\\😀"));
    }

    #[test]
    fn layout_is_part_of_the_form() {
        refused("[1, 2]\n", "not in canonical form");
        refused("{\"a\":1}\n", "not in canonical form");
        refused("[\n    1\n]\n", "not in canonical form");
        refused("[\n  1\n]", "not in canonical form");
        refused("[\n  1\n]\n\n", "not in canonical form");
        refused("[\r\n  1\r\n]\r\n", "not in canonical form");
        refused("{\n  \"a\" : 1\n}\n", "not in canonical form");
        refused("[ ]\n", "not in canonical form");
    }

    #[test]
    fn a_number_is_in_its_shortest_form() {
        for literal in [
            "97.0",
            "1e2",
            "1E2",
            "-0",
            "0.10",
            "1.0e0",
            "100000000000000000000000",
        ] {
            refused(&format!("{literal}\n"), "shortest form");
        }
        for literal in ["97", "-1", "0.5", "1e+21", "1.5e-7", "9007199254740991"] {
            canonical(&format!("{literal}\n"));
        }
        refused("9007199254740993\n", "shortest form");
    }

    #[test]
    fn a_number_outside_the_double_range_is_refused() {
        refused("1e999\n", "outside the range");
    }

    #[test]
    fn a_string_holds_only_the_escapes_json_requires() {
        refused("\"\\u0041\"\n", "not in canonical form");
        refused("\"\\/\"\n", "not in canonical form");
        refused("\"\\u00e9\"\n", "not in canonical form");
        refused("\"\\ud83d\\ude00\"\n", "not in canonical form");
        refused("\"\\u000A\"\n", "not in canonical form");
        canonical("\"\\n\\t\\u0000\"\n");
    }

    #[test]
    fn an_unpaired_surrogate_is_refused_in_a_key_and_in_a_value() {
        refused("\"\\ud800\"\n", "unpaired surrogate");
        refused("\"\\udc00\"\n", "unpaired surrogate");
        refused("\"\\ud800\\u0041\"\n", "unpaired surrogate");
        refused("{\n  \"\\ud800\": 1\n}\n", "unpaired surrogate");
    }

    #[test]
    fn keys_are_in_ascending_utf16_order_without_repeats() {
        refused("{\n  \"b\": 1,\n  \"a\": 2\n}\n", "ascending");
        refused("{\n  \"a\": 1,\n  \"a\": 2\n}\n", "ascending");
        refused("{\n  \"2\": 1,\n  \"10\": 2\n}\n", "ascending");
        canonical("{\n  \"10\": 1,\n  \"2\": 2\n}\n");
        // U+1F600 is D83D DE00 in UTF-16, which is below U+E000.
        canonical("{\n  \"\u{1F600}\": 1,\n  \"\u{E000}\": 2\n}\n");
        refused(
            "{\n  \"\u{E000}\": 1,\n  \"\u{1F600}\": 2\n}\n",
            "ascending",
        );
    }

    #[test]
    fn an_escaped_key_is_compared_as_the_text_it_stands_for() {
        refused("{\n  \"b\": 1,\n  \"\\u0061\": 2\n}\n", "ascending");
    }

    #[test]
    fn a_byte_order_mark_and_invalid_utf8_are_refused() {
        refused("\u{feff}1\n", "byte order mark");
        assert!(check_canonical(&[0x31, 0xff, 0x0a]).is_err());
    }

    fn nested(levels: usize) -> Value {
        (0..levels).fold(Value::Array(Vec::new()), |inner, _| {
            Value::Array(vec![inner])
        })
    }

    #[test]
    fn nesting_is_limited() {
        // The innermost array is the first level, so `nested(MAX_DEPTH - 1)` holds MAX_DEPTH arrays.
        let at_limit = write_canonical(&nested(MAX_DEPTH - 1)).unwrap();
        assert_eq!(check_canonical(at_limit.as_bytes()), Ok(()));
        let deeper = format!(
            "{}{}\n",
            "[".repeat(MAX_DEPTH + 1),
            "]".repeat(MAX_DEPTH + 1)
        );
        refused(&deeper, "deeper than");
        refused(&"[".repeat(100_000), "deeper than");
    }

    #[test]
    fn the_writer_refuses_a_value_the_reader_would_refuse_and_does_not_recurse_past_the_bound() {
        let problem = write_canonical(&nested(MAX_DEPTH)).unwrap_err();
        assert!(problem.message.contains("deeper than"), "{problem}");
        // A value far deeper than the stack could write is refused at the bound, so this returns at all.
        let mut value = Value::Null;
        for _ in 0..100_000 {
            value = Value::Array(vec![value]);
        }
        assert!(write_canonical(&value).is_err());
        // Dropping a value this deep recurses too; take it apart from the inside out.
        let mut current = value;
        while let Value::Array(mut items) = current {
            current = items.pop().unwrap_or(Value::Null);
        }
    }

    #[test]
    fn parse_canonical_returns_the_value_the_check_read() {
        let text = "{\n  \"a\": [\n    1\n  ]\n}\n";
        let value = parse_canonical(text.as_bytes()).unwrap();
        assert_eq!(write_canonical(&value).unwrap(), text);
        assert_eq!(
            value,
            Value::Object(vec![(
                "a".to_owned(),
                Value::Array(vec![Value::Number(1.0)])
            )])
        );
        for bad in [
            "{\n  \"a\": 1,\n  \"a\": 2\n}\n",
            "97.0\n",
            "{\n  \"b\": 1,\n  \"a\": 2\n}\n",
        ] {
            assert!(parse_canonical(bad.as_bytes()).is_err(), "{bad}");
        }
    }

    #[test]
    fn unpaired_surrogate_keys_are_compared_by_code_unit() {
        // D800 is below E000. A scan that read each unpaired surrogate as U+FFFD put it above E000 and found a second problem.
        let text = "{\n  \"\\ud800\": 1,\n  \"\\ue000\": 2\n}\n";
        let problems = key_problems(text.as_bytes());
        assert_eq!(problems.len(), 1, "{problems:?}");
        assert!(problems[0].message.contains("unpaired surrogate"));
        // Two different unpaired surrogates are two problems and not also a repeated key.
        let two = "{\n  \"\\ud800\": 1,\n  \"\\ud801\": 2\n}\n";
        let problems = key_problems(two.as_bytes());
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems.iter().all(|p| !p.message.contains("ascending")));
        // The same unpaired surrogate twice is a repeated key.
        let repeated = "{\n  \"\\ud800\": 1,\n  \"\\ud800\": 2\n}\n";
        assert!(
            key_problems(repeated.as_bytes())
                .iter()
                .any(|p| p.message.contains("ascending"))
        );
    }

    #[test]
    fn line_separators_and_delete_are_written_as_themselves() {
        // `JSON.stringify` writes U+2028, U+2029 and U+007F literally, and so does the canonical form.
        for character in ['\u{2028}', '\u{2029}', '\u{7f}'] {
            let text = format!("\"{character}\"\n");
            assert_eq!(check_canonical(text.as_bytes()), Ok(()), "{character:?}");
            let escaped = format!("\"\\u{:04x}\"\n", u32::from(character));
            refused(&escaped, "not in canonical form");
        }
    }

    #[test]
    fn syntax_errors_are_refused() {
        for text in [
            "",
            "{",
            "[1,]\n",
            "{\"a\"}\n",
            "01\n",
            "1 2\n",
            "\"\u{1}\"\n",
            "\"\\q\"\n",
            "tru\n",
            "+1\n",
            ".5\n",
            "1.\n",
        ] {
            assert!(check_canonical(text.as_bytes()).is_err(), "{text:?}");
        }
    }

    #[test]
    fn key_problems_lists_each_content_problem() {
        let text = "{\n  \"b\": 1,\n  \"a\": 97.0,\n  \"a\": \"\\ud800\"\n}\n";
        assert_eq!(key_problems(text.as_bytes()).len(), 4);
        assert_eq!(key_problems(b"{\n  \"a\": 1\n}\n"), Vec::new());
    }

    #[test]
    fn the_workspace_reads_a_number_as_the_nearest_double() {
        // serde_json's default parser reads this literal one unit in the last place away from the double JSON.parse
        // reads; the workspace turns `float_roundtrip` on so a typed reader and a JavaScript reader agree. The
        // check parser above uses the standard library, which rounds correctly; this pins the feature for readers.
        let literal = "1.1920928955078125e-7";
        let reference: f64 = literal.parse().unwrap();
        let through: f64 = serde_json::from_str(literal).unwrap();
        assert_eq!(through.to_bits(), reference.to_bits());
        let hard = "2.2250738585072011e-308";
        let reference: f64 = hard.parse().unwrap();
        let through: f64 = serde_json::from_str(hard).unwrap();
        assert_eq!(through.to_bits(), reference.to_bits());
        let sensitive = "9007199254740993.000000000000000000001";
        let reference: f64 = sensitive.parse().unwrap();
        let through: f64 = serde_json::from_str(sensitive).unwrap();
        assert_eq!(through.to_bits(), reference.to_bits());
    }
}
