use std::cmp::Ordering;

/// Whether a name (a case id, or a directory or file name of a corpus file) uses only lower-case ASCII letters,
/// digits, dots, hyphens and underscores, and does not start with a punctuation character, so every loader orders
/// names the same way.
pub fn is_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

/// The order of two texts by UTF-16 code unit, which is the order JavaScript sorts strings in. It differs from byte
/// order and from code point order for a character above U+FFFF against one in U+E000 to U+FFFF.
pub fn utf16_order(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_lower_case_ascii_without_leading_punctuation() {
        for name in ["a", "0", "a.b-c_d", "stray.json", "a1"] {
            assert!(is_name(name), "{name}");
        }
        for name in ["", ".a", "-a", "_a", "A", "a b", "é", "a/b", "😀"] {
            assert!(!is_name(name), "{name}");
        }
    }

    #[test]
    fn utf16_order_places_an_astral_character_before_a_private_use_one() {
        // U+1F600 is the surrogate pair D83D DE00, below U+E000; in byte and code point order it is above.
        assert_eq!(utf16_order("\u{1F600}", "\u{E000}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{E000}"), Ordering::Greater);
        assert_eq!(utf16_order("10", "2"), Ordering::Less);
    }
}
