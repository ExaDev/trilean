//! What the parser accepts and refuses, beyond the cases the conformance corpus pins.

use trilean_regex::{
    CharClassNode, CharRange, MAX_NESTING_DEPTH, RegexNode, RegexParseError, char_class_matches,
    parse_regex, parse_regex_utf16,
};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn class_of(pattern: &str) -> CharClassNode {
    match parse_regex(pattern) {
        Ok(RegexNode::CharClass(class)) => class,
        other => panic!("{pattern} parsed to {other:?}, not a class"),
    }
}

fn refusal(pattern: &str) -> RegexParseError {
    parse_regex(pattern).expect_err(pattern)
}

fn range(from: u16, to: u16) -> CharRange {
    CharRange { from, to }
}

#[test]
fn a_negated_shorthand_inside_a_class_is_the_ranges_of_its_complement() {
    let class = class_of(r"[\Da]");
    assert!(!class.negated);
    assert_eq!(
        class.ranges,
        [range(0, 47), range(58, 65535), range(97, 97)]
    );
}

#[test]
fn every_negated_shorthand_inside_a_class_is_the_complement_of_the_shorthand_outside_it() {
    for letter in ["D", "W", "S"] {
        let inside = class_of(&format!(r"[\{letter}]"));
        let outside = class_of(&format!(r"\{letter}"));
        for unit in 0..=u16::MAX {
            assert_eq!(
                char_class_matches(&inside, unit),
                char_class_matches(&outside, unit),
                "\\{letter} at {unit}"
            );
        }
    }
}

#[test]
fn a_class_of_a_shorthand_and_its_negation_holds_every_code_unit() {
    for pattern in [r"[\s\S]", r"[\S\s]", r"[\d\D]", r"[\w\W]"] {
        let class = class_of(pattern);
        assert!(
            (0..=u16::MAX).all(|unit| char_class_matches(&class, unit)),
            "{pattern}"
        );
    }
}

#[test]
fn a_negated_class_of_a_shorthand_and_its_negation_holds_nothing() {
    let class = class_of(r"[^\s\S]");
    assert!((0..=u16::MAX).all(|unit| !char_class_matches(&class, unit)));
}

#[test]
fn a_shorthand_class_is_still_not_a_range_endpoint() {
    for pattern in [r"[a-\d]", r"[a-\D]", r"[a-\S]"] {
        assert!(
            refusal(pattern)
                .reason()
                .contains("cannot be a range endpoint"),
            "{pattern}"
        );
    }
}

#[test]
fn an_error_index_counts_code_units_so_a_character_outside_the_bmp_counts_as_two() {
    let error = refusal("\u{1F600}(b");
    assert_eq!(error.index(), 2);
    assert!(
        error
            .reason()
            .contains("capturing groups are not supported")
    );
}

#[test]
fn an_unpaired_surrogate_is_a_literal_character() {
    assert_eq!(
        parse_regex_utf16(&[0xD800]),
        Ok(RegexNode::Literal { code_unit: 0xD800 })
    );
}

#[test]
fn a_reason_quoting_an_unpaired_surrogate_keeps_it() {
    let error = parse_regex_utf16(&[b'\\' as u16, 0xD83D]).expect_err("unknown escape");
    assert_eq!(error.index(), 0);
    assert_eq!(
        error.reason_utf16(),
        "unknown escape sequence '\\"
            .encode_utf16()
            .chain([0xD83D, u16::from(b'\'')])
            .collect::<Vec<u16>>()
    );
    let reversed = parse_regex_utf16(&[b'[' as u16, 0xDC00, b'-' as u16, 0xD800, b']' as u16])
        .expect_err("reversed range");
    assert!(
        reversed
            .message_utf16()
            .windows(3)
            .any(|window| window == [0xDC00, b'-' as u16, 0xD800])
    );
}

#[test]
fn the_message_echoes_the_pattern_and_puts_a_caret_under_the_index() {
    assert_eq!(
        refusal("ab)").to_string(),
        "invalid pattern at index 2: unexpected character -- if this was meant literally, escape it with a backslash\n  ab)\n    ^"
    );
}

#[test]
fn groups_nest_to_the_limit_and_no_further() {
    let nested = |depth: usize| format!("{}a{}", "(?:".repeat(depth), ")".repeat(depth));
    assert!(parse_regex(&nested(MAX_NESTING_DEPTH)).is_ok());
    let error = refusal(&nested(MAX_NESTING_DEPTH + 1));
    assert_eq!(error.index(), 3 * MAX_NESTING_DEPTH);
    assert!(error.reason().contains("nested too deeply"));
}

#[test]
fn a_bound_is_a_count_that_fits_in_a_u32() {
    assert_eq!(
        parse_regex("a{4294967295}"),
        Ok(RegexNode::Repeat {
            operand: Box::new(RegexNode::Literal { code_unit: 97 }),
            min: u32::MAX,
            max: Some(u32::MAX),
        })
    );
    let error = refusal("a{4294967296}");
    assert_eq!(error.index(), 1);
    assert!(error.reason().contains("too large"));
    assert!(
        refusal("a{1,99999999999999999999}")
            .reason()
            .contains("too large")
    );
}

#[test]
fn a_backwards_bound_is_an_error_naming_the_bound_as_written() {
    let error = refusal("a{05,2}");
    assert_eq!(error.index(), 1);
    assert_eq!(
        error.reason(),
        "quantifier range is backwards: {05,2} would require between 5 and 2 repetitions"
    );
}

#[test]
fn a_brace_that_is_not_a_complete_bound_is_a_literal() {
    for pattern in ["a{", "a{}", "a{,5}", "a{1", "a{1,2", "{"] {
        assert!(parse_regex(pattern).is_ok(), "{pattern}");
    }
    assert_eq!(
        parse_regex("a{,5}")
            .map(|node| matches!(node, RegexNode::Concat(operands) if operands.len() == 5)),
        Ok(true)
    );
}

#[test]
fn an_unbounded_repeat_has_no_max() {
    assert_eq!(
        parse_regex("a{2,}"),
        Ok(RegexNode::Repeat {
            operand: Box::new(RegexNode::Literal { code_unit: 97 }),
            min: 2,
            max: None,
        })
    );
}

#[test]
fn an_empty_pattern_and_empty_branches_parse_to_empty_sequences() {
    assert_eq!(parse_regex(""), Ok(RegexNode::Concat(Vec::new())));
    assert_eq!(
        parse_regex("|"),
        Ok(RegexNode::Alternation(vec![
            RegexNode::Concat(Vec::new()),
            RegexNode::Concat(Vec::new())
        ]))
    );
}

#[test]
fn text_and_code_unit_entry_points_agree() {
    for pattern in ["a(", "[b-a]", "x{2,1}", "\u{1F600}+", "(?:a|b)*c"] {
        assert_eq!(parse_regex(pattern), parse_regex_utf16(&units(pattern)));
    }
}
