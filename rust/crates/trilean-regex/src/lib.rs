//! A portable regular-expression grammar over UTF-16 code units.
//!
//! The grammar is a true regular language, so a pattern means the same wherever it is compiled to: here, in a database's own engine, or in an ECMAScript `RegExp` when `compile_ecmascript_subset` accepts it. The matcher is a Thompson-construction simulation that never backtracks, and reports its work in NFA state visits.
//!
//! Everything is defined over UTF-16 code units, as `String.prototype.charCodeAt` reads a string: an offset in an error counts code units, a character outside the Basic Multilingual Plane is two characters, and an unpaired surrogate is a character like any other. The `_utf16` entry points take code units directly.

mod ast;
mod ecma;
mod error;
mod matcher;
mod parser;
mod shorthand;

pub use ast::{CharClassNode, CharRange, RegexNode, char_class_matches, range_contains};
pub use ecma::{EcmaSubsetError, compile_ecmascript_subset, compile_ecmascript_subset_utf16};
pub use error::RegexParseError;
pub use matcher::{CompiledPattern, compile_pattern, compile_pattern_utf16, test_pattern};
pub use parser::{MAX_NESTING_DEPTH, parse_regex, parse_regex_utf16};
pub use shorthand::{ShorthandClassLetter, expand_shorthand_class};
