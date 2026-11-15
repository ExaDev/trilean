//! The error the parser reports.

use std::fmt;

/// A pattern the parser refuses, with a real position rather than a generic message.
///
/// The pattern and the reason are sequences of UTF-16 code units, not `String`s, because a pattern may hold an unpaired surrogate (a JavaScript string can) and the reason may quote one of its characters. `index` is the offset in code units into the pattern where parsing could not proceed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegexParseError {
    pattern: Vec<u16>,
    index: usize,
    reason: Vec<u16>,
}

impl RegexParseError {
    pub(crate) fn new(pattern: &[u16], index: usize, reason: Vec<u16>) -> Self {
        Self {
            pattern: pattern.to_vec(),
            index,
            reason,
        }
    }

    /// The error for a pattern longer than `MAX_PATTERN_UNITS`, which is refused without being read or copied: it names the length and the limit, and echoes no pattern.
    pub(crate) fn too_long(length: usize) -> Self {
        let reason = format!(
            "the pattern is {length} code units long, and a pattern may be at most {} code units",
            crate::parser::MAX_PATTERN_UNITS
        );
        Self {
            pattern: Vec::new(),
            index: 0,
            reason: reason.encode_utf16().collect(),
        }
    }

    /// The source pattern, as the code units it was parsed from. Empty for a pattern refused for its length.
    pub fn pattern_utf16(&self) -> &[u16] {
        &self.pattern
    }

    /// The offset in UTF-16 code units into the pattern where parsing could not proceed.
    pub fn index(&self) -> usize {
        self.index
    }

    /// The text that says why the pattern was refused, as code units: not the index, not the echoed pattern and not the position marker.
    pub fn reason_utf16(&self) -> &[u16] {
        &self.reason
    }

    /// The reason as text; an unpaired surrogate in it reads as U+FFFD.
    pub fn reason(&self) -> String {
        String::from_utf16_lossy(&self.reason)
    }

    /// The whole message as code units: the index and the reason, then the pattern on a line of its own and a caret under the offending position.
    pub fn message_utf16(&self) -> Vec<u16> {
        let mut message: Vec<u16> = format!("invalid pattern at index {}: ", self.index)
            .encode_utf16()
            .collect();
        message.extend_from_slice(&self.reason);
        message.extend("\n  ".encode_utf16());
        message.extend_from_slice(&self.pattern);
        message.extend("\n  ".encode_utf16());
        message.extend(std::iter::repeat_n(u16::from(b' '), self.index));
        message.push(u16::from(b'^'));
        message
    }
}

impl fmt::Display for RegexParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&String::from_utf16_lossy(&self.message_utf16()))
    }
}

impl std::error::Error for RegexParseError {}

/// Why a compiled pattern may not be tested against an input: the input is longer than `MAX_INPUT_UNITS`, or the work its length allows the pattern is over `MAX_WORK`.
///
/// The error names the numbers and echoes no input, which may be as long as the caller likes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegexInputError {
    limit: InputLimit,
    input_units: usize,
    reason: &'static str,
    states: usize,
    work: u64,
}

/// Which limit an input ran into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputLimit {
    /// The input is longer than `MAX_INPUT_UNITS`.
    Length,
    /// The pattern's states times the input's length is over `MAX_WORK`.
    Work,
}

impl RegexInputError {
    pub(crate) fn too_long(input_units: usize) -> Self {
        Self {
            limit: InputLimit::Length,
            input_units,
            reason: "the input is longer than the limit",
            states: 0,
            work: 0,
        }
    }

    pub(crate) fn too_much_work(input_units: usize, states: usize, work: u64) -> Self {
        Self {
            limit: InputLimit::Work,
            input_units,
            reason: "the work the input allows the pattern is over the limit",
            states,
            work,
        }
    }

    /// Which limit the input ran into.
    pub fn limit(&self) -> InputLimit {
        self.limit
    }

    /// The length of the refused input, in UTF-16 code units.
    pub fn input_units(&self) -> usize {
        self.input_units
    }
}

impl fmt::Display for RegexInputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.limit {
            InputLimit::Length => write!(
                formatter,
                "input refused: {}: the input is {} code units long, and an input may be at most {}",
                self.reason,
                self.input_units,
                crate::matcher::MAX_INPUT_UNITS
            ),
            InputLimit::Work => write!(
                formatter,
                "input refused: {}: {} states against {} code units allow up to {} state visits, and a test may take at most {}",
                self.reason,
                self.states,
                self.input_units,
                self.work,
                crate::matcher::MAX_WORK
            ),
        }
    }
}

impl std::error::Error for RegexInputError {}

/// Why `test_pattern` gave no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TestPatternError {
    /// The pattern is not in the grammar.
    Parse(RegexParseError),
    /// The input may not be tested against the compiled pattern.
    Input(RegexInputError),
}

impl fmt::Display for TestPatternError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(error) => error.fmt(formatter),
            Self::Input(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for TestPatternError {}

impl From<RegexParseError> for TestPatternError {
    fn from(error: RegexParseError) -> Self {
        Self::Parse(error)
    }
}

impl From<RegexInputError> for TestPatternError {
    fn from(error: RegexInputError) -> Self {
        Self::Input(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_names_the_index_the_reason_the_pattern_and_a_caret() {
        let pattern: Vec<u16> = "a(b".encode_utf16().collect();
        let error = RegexParseError::new(&pattern, 1, "because".encode_utf16().collect());
        assert_eq!(
            error.to_string(),
            "invalid pattern at index 1: because\n  a(b\n   ^"
        );
        assert_eq!(error.reason(), "because");
        assert_eq!(error.index(), 1);
    }

    #[test]
    fn an_unpaired_surrogate_survives_in_the_code_unit_message() {
        let error = RegexParseError::new(&[0xD800, 0x61], 0, vec![0xDC00]);
        let message = error.message_utf16();
        assert!(message.windows(2).any(|pair| pair == [0xD800, 0x61]));
        assert!(message.contains(&0xDC00));
    }
}
