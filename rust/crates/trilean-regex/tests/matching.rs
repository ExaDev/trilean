//! What the matcher answers, beyond the cases the conformance corpus pins.

use trilean_regex::{compile_pattern, compile_pattern_utf16, test_pattern};

fn matches(pattern: &str, input: &str) -> bool {
    test_pattern(pattern, input).expect(pattern)
}

#[test]
fn an_unanchored_pattern_matches_anywhere_and_anchors_pin_the_ends() {
    assert!(matches("cat", "concatenate"));
    assert!(!matches("^cat", "concatenate"));
    assert!(matches("^con", "concatenate"));
    assert!(matches("ate$", "concatenate"));
    assert!(!matches("cat$", "concatenate"));
}

#[test]
fn an_anchor_inside_a_branch_or_a_group_still_tests_the_absolute_position() {
    assert!(matches("x|^a", "ab"));
    assert!(!matches("x|^a", "ba"));
    assert!(matches("(?:^a|b$)", "cb"));
    assert!(!matches("(?:^a|b$)", "ca"));
}

#[test]
fn the_empty_pattern_matches_every_input() {
    assert!(matches("", ""));
    assert!(matches("", "anything"));
    assert!(matches("^$", ""));
    assert!(!matches("^$", "a"));
}

#[test]
fn bounded_and_unbounded_repeats_count_exactly() {
    assert!(!matches("^a{2,3}$", "a"));
    assert!(matches("^a{2,3}$", "aa"));
    assert!(matches("^a{2,3}$", "aaa"));
    assert!(!matches("^a{2,3}$", "aaaa"));
    assert!(matches("^a{0}$", ""));
    assert!(!matches("^a{0}$", "a"));
    assert!(matches("^a{3}$", "aaa"));
    assert!(!matches("^a{3}$", "aa"));
    assert!(!matches("^a{2,}$", "a"));
    assert!(matches("^a{2,}$", "aaaaaaaa"));
    assert!(matches("^a{0,}$", ""));
}

#[test]
fn a_negated_shorthand_inside_a_class_matches_what_it_means() {
    assert!(matches(r"^[\Da]$", "a"));
    assert!(matches(r"^[\Da]$", "x"));
    assert!(!matches(r"^[\Da]$", "5"));
    assert!(matches(r"^[\s\S]*$", "line\nbreak\u{2028}"));
    assert!(matches(r"^[\s\S]*$", ""));
}

#[test]
fn dot_matches_a_line_terminator_here() {
    assert!(matches("^a.b$", "a\nb"));
}

#[test]
fn matching_is_over_code_units_so_one_astral_character_is_two_dots() {
    assert!(!matches("^.$", "\u{1F600}"));
    assert!(matches("^..$", "\u{1F600}"));
}

#[test]
fn an_unpaired_surrogate_in_the_input_is_one_character() {
    let lone_high = [0xD800u16];
    let any = compile_pattern("^.$").expect("dot");
    assert!(any.test_utf16(&lone_high));
    let class = compile_pattern_utf16(&[
        u16::from(b'^'),
        u16::from(b'['),
        0xD800,
        u16::from(b'-'),
        0xDBFF,
        u16::from(b']'),
        u16::from(b'$'),
    ])
    .expect("surrogate range");
    assert!(class.test_utf16(&lone_high));
    assert!(!class.test_utf16(&[0xDC00]));
    assert!(!class.test("a"));
}

#[test]
fn a_pattern_compiled_once_answers_every_input_as_a_fresh_compile_would() {
    let compiled = compile_pattern("^(?:ab|a)+c$").expect("pattern");
    for input in ["", "ac", "abc", "aabc", "abac", "abx", "c"] {
        assert_eq!(
            compiled.test(input),
            matches("^(?:ab|a)+c$", input),
            "{input}"
        );
    }
}

#[test]
fn the_text_and_code_unit_entry_points_agree() {
    let compiled = compile_pattern("b+$").expect("pattern");
    for input in ["", "b", "abb", "bba", "\u{1F600}b"] {
        let units: Vec<u16> = input.encode_utf16().collect();
        assert_eq!(compiled.test(input), compiled.test_utf16(&units), "{input}");
    }
}
