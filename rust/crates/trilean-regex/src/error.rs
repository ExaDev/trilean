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

    /// The source pattern, as the code units it was parsed from.
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
