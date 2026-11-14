//! The entry point for a caller that runs the same pattern in an ECMAScript engine too.

use std::fmt;

use crate::error::RegexParseError;
use crate::matcher::CompiledPattern;
use crate::parser::parse_with_hazards;

/// Why a pattern does not compile as an ECMAScript-compatible one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EcmaSubsetError {
    /// The pattern is not in the grammar at all.
    Parse(RegexParseError),
    /// The pattern is in the grammar, and `construct` at `index` (in UTF-16 code units) means something else in an unflagged ECMAScript `RegExp`.
    Unsupported {
        index: usize,
        construct: &'static str,
    },
}

impl fmt::Display for EcmaSubsetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => error.fmt(formatter),
            Self::Unsupported { index, construct } => write!(
                formatter,
                "the construct '{construct}' at index {index} does not mean the same in an ECMAScript regular expression"
            ),
        }
    }
}

impl std::error::Error for EcmaSubsetError {}

impl From<RegexParseError> for EcmaSubsetError {
    fn from(error: RegexParseError) -> Self {
        Self::Parse(error)
    }
}

/// Compiles a pattern given as code units only when every construct in it means the same as in an unflagged ECMAScript `RegExp`, so the answer for any input is the one that engine gives.
///
/// These constructs differ and are refused as `Unsupported`:
///
/// - `.`, which matches a line terminator here and not there.
/// - `\s` and `\S` outside a class, and inside a class that does not hold every code unit. ECMAScript's `\s` is every white-space and line-terminator code point (U+00A0, U+FEFF, U+2028 and the `Zs` separators), with or without the `u` flag, where this grammar's is the six ASCII white-space characters. A class that holds every code unit, as `[\s\S]` does, is the same set in both.
/// - A braced quantifier with nothing to repeat (`{2}` at the start of a pattern, a group or a branch), which is a syntax error there and a literal here.
///
/// When several occur, the one at the lowest index is reported.
pub fn compile_ecmascript_subset_utf16(
    pattern: &[u16],
) -> Result<CompiledPattern, EcmaSubsetError> {
    let (node, hazards) = parse_with_hazards(pattern)?;
    match hazards.iter().min_by_key(|hazard| hazard.index) {
        Some(hazard) => Err(EcmaSubsetError::Unsupported {
            index: hazard.index,
            construct: hazard.construct,
        }),
        None => Ok(CompiledPattern::from_node(&node)),
    }
}

/// `compile_ecmascript_subset_utf16` for a pattern given as text.
pub fn compile_ecmascript_subset(pattern: &str) -> Result<CompiledPattern, EcmaSubsetError> {
    compile_ecmascript_subset_utf16(&pattern.encode_utf16().collect::<Vec<u16>>())
}
