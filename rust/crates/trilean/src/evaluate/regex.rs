//! The engine `matches` and `notMatches` read a pattern with.

use crate::evaluation::{IndeterminateCode, IndeterminateReason};

/// An engine for ECMAScript regular expressions, which `matches` and `notMatches` test a text against.
///
/// The pattern is read as `new RegExp(pattern)` reads it, with no flags, and the answer is what `.test(text)` gives.
/// An engine that cannot give that answer (the pattern is not a valid ECMAScript pattern, it uses a construct the
/// engine does not run, or the text is beyond a limit of the engine) returns the reason the comparison is
/// indeterminate, which the evaluator reports unchanged; an engine never throws for a data problem.
pub trait EcmaScriptRegex {
    /// Whether `pattern` matches somewhere in `text`, or why that cannot be answered.
    ///
    /// # Errors
    ///
    /// The indeterminate reason for a pattern or text the engine cannot answer for: `wrong-type` for a pattern it
    /// refuses, `domain-error` for a text past one of its limits, by the convention of the other node rules.
    fn test(&self, pattern: &str, text: &str) -> Result<bool, IndeterminateReason>;
}

/// The engine the evaluator uses unless it is given another: trilean-regex's ECMAScript subset, which accepts only
/// constructs that mean the same as in an unflagged ECMAScript `RegExp`, so every answer it gives is ECMAScript's.
/// It runs every pattern the derived-pattern builders emit. A pattern outside the subset (a lookahead, a
/// backreference, `.`, `\s`) is `wrong-type` with a message that names the problem, where a full ECMAScript engine
/// would answer; a host with one (the host's `RegExp` in a wasm build) supplies it instead.
#[derive(Clone, Copy, Debug, Default)]
pub struct EcmaScriptSubset;

impl EcmaScriptRegex for EcmaScriptSubset {
    fn test(&self, pattern: &str, text: &str) -> Result<bool, IndeterminateReason> {
        let compiled = trilean_regex::compile_ecmascript_subset(pattern).map_err(|error| {
            IndeterminateReason {
                code: IndeterminateCode::WrongType,
                message: match error {
                    // The subset's grammar is narrower than ECMAScript's, so a pattern it refuses may still be one ECMAScript reads: the message says which grammar refused it.
                    trilean_regex::EcmaSubsetError::Parse(parse) => {
                        format!("'{pattern}' is not a regular expression pattern this engine reads: {parse}")
                    }
                    unsupported @ trilean_regex::EcmaSubsetError::Unsupported { .. } => {
                        format!("'{pattern}' cannot be tested by this regular expression engine: {unsupported}")
                    }
                },
            }
        })?;
        compiled.test(text).map_err(|error| IndeterminateReason {
            code: IndeterminateCode::DomainError,
            message: format!("the text cannot be tested against '{pattern}': {error}"),
        })
    }
}
