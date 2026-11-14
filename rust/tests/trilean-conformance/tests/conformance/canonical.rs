//! The key rule of canonical corpus files, checked on the text of a file, as the TypeScript loaders do
//! (`packages/trilean/src/test-support/canonical-keys.ts`): in every object the keys are in strictly ascending UTF-16
//! code-unit order, which for an integer-like key is the order of the strings (`"10"` before `"2"`), and no key holds
//! an unpaired surrogate. A key is compared as the text it stands for, so an escaped spelling is read first. The
//! comparison is over UTF-16 code units and not over code points or bytes, which order a character outside the Basic
//! Multilingual Plane differently from a character in the private-use area.
//!
//! The same scan states two more rules, so that every loader gives one verdict: a document does not begin with a byte
//! order mark, and no array or object is nested deeper than `MAX_DEPTH`. The TypeScript and the Rust JSON parsers
//! would otherwise differ on both (one strips a mark, the other refuses it; their recursion limits differ).

/// The deepest nesting a corpus file may have: a document that is one array holding one array, and so on, has that
/// many levels at most. It is the same value in every loader.
pub const MAX_DEPTH: usize = 64;

/// How many hexadecimal digits follow `\u`.
const HEX_DIGITS: usize = 4;

enum Frame {
    Object {
        /// Whether the next string is a key of this object.
        expect_key: bool,
        /// The previous key of this object, as UTF-16 code units, if any.
        last: Option<Vec<u16>>,
    },
    Array,
}

/// The UTF-16 code units of the string literal whose opening quote has been read, escapes decoded. An unpaired
/// surrogate survives as the code unit the escape names.
fn read_string(chars: &mut std::str::Chars<'_>) -> Vec<u16> {
    let mut units = Vec::new();
    while let Some(character) = chars.next() {
        match character {
            '"' => break,
            '\\' => match chars.next() {
                Some('u') => {
                    let digits: String = chars.by_ref().take(HEX_DIGITS).collect();
                    units.push(u16::from_str_radix(&digits, 16).unwrap_or(0));
                }
                Some('b') => units.push(0x08),
                Some('f') => units.push(0x0c),
                Some('n') => units.push(0x0a),
                Some('r') => units.push(0x0d),
                Some('t') => units.push(0x09),
                Some(other) => units.extend(other.encode_utf16(&mut [0; 2]).iter()),
                None => break,
            },
            other => units.extend(other.encode_utf16(&mut [0; 2]).iter()),
        }
    }
    units
}

/// Everything the key rule finds wrong with the text of a JSON document, in the order found; empty when the keys are
/// canonical. The text must be valid JSON, which every loader checks by parsing it.
pub fn key_problems(text: &str) -> Vec<String> {
    let mut problems = Vec::new();
    if text.starts_with('\u{feff}') {
        problems.push("the document begins with a byte order mark".to_owned());
    }
    let mut stack: Vec<Frame> = Vec::new();
    let mut chars = text.chars();
    while let Some(character) = chars.next() {
        match character {
            '"' => {
                let units = read_string(&mut chars);
                if let Some(Frame::Object { expect_key, last }) = stack.last_mut()
                    && *expect_key
                {
                    *expect_key = false;
                    let shown = String::from_utf16_lossy(&units);
                    if String::from_utf16(&units).is_err() {
                        problems.push(format!("the key {shown:?} holds an unpaired surrogate"));
                    }
                    if let Some(before) = last.as_ref()
                        && units <= *before
                    {
                        problems.push(format!(
                            "the key {shown:?} follows {:?}: keys are in ascending UTF-16 code-unit order, without repeats",
                            String::from_utf16_lossy(before)
                        ));
                    }
                    *last = Some(units);
                }
            }
            '{' | '[' => {
                stack.push(if character == '{' {
                    Frame::Object {
                        expect_key: true,
                        last: None,
                    }
                } else {
                    Frame::Array
                });
                if stack.len() == MAX_DEPTH + 1 {
                    problems.push(format!("nesting is deeper than {MAX_DEPTH} levels"));
                }
            }
            '}' | ']' => {
                stack.pop();
            }
            ',' => {
                if let Some(Frame::Object { expect_key, .. }) = stack.last_mut() {
                    *expect_key = true;
                }
            }
            _ => {}
        }
    }
    problems
}
