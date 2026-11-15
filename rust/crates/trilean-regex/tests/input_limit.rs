//! The limits on what a compiled pattern is tested against: the length of the input, and the work its length allows the pattern. Both are refused from the lengths alone, before any simulation or copy.

use trilean_regex::{
    InputLimit, MAX_INPUT_UNITS, MAX_STATES, MAX_WORK, TestPatternError, compile_pattern,
    test_pattern,
};

/// The pattern with the most states the limit allows: the final state and a state for each of `MAX_STATES - 1` copies of `a`.
fn largest_pattern() -> String {
    format!("a{{{}}}", MAX_STATES - 1)
}

/// The longest input the largest pattern may be tested against, in code units.
fn largest_input_units() -> usize {
    usize::try_from(MAX_WORK).expect("the limit fits") / MAX_STATES - 1
}

#[test]
fn the_largest_pattern_is_tested_against_an_input_just_under_the_work_limit() {
    let compiled = compile_pattern(&largest_pattern()).expect("pattern");
    assert_eq!(compiled.state_count(), MAX_STATES);
    let units = largest_input_units();
    assert_eq!(units, 999);
    assert!(!compiled.test(&"a".repeat(units)).expect("under the limit"));
}

#[test]
fn the_largest_pattern_is_refused_an_input_one_code_unit_over_the_work_limit() {
    let compiled = compile_pattern(&largest_pattern()).expect("pattern");
    let error = compiled
        .test(&"a".repeat(largest_input_units() + 1))
        .expect_err("over the limit");
    assert_eq!(error.limit(), InputLimit::Work);
    assert_eq!(error.input_units(), largest_input_units() + 1);
}

#[test]
fn the_work_limit_follows_the_patterns_states() {
    let small = compile_pattern("^a$").expect("pattern");
    let units = vec![u16::from(b'a'); MAX_INPUT_UNITS];
    assert!(small.test_utf16(&units).is_ok());
    let medium = compile_pattern(&format!("a{{{}}}", 200)).expect("pattern");
    assert_eq!(
        medium.test_utf16(&units).expect_err("200 states").limit(),
        InputLimit::Work
    );
}

#[test]
fn an_input_over_the_length_limit_is_refused_by_its_length_whatever_the_pattern() {
    let compiled = compile_pattern("a").expect("pattern");
    let error = compiled
        .test_utf16(&vec![0; MAX_INPUT_UNITS + 1])
        .expect_err("too long");
    assert_eq!(error.limit(), InputLimit::Length);
    assert!(compiled.check_input(MAX_INPUT_UNITS).is_ok());
    assert_eq!(
        compiled
            .check_input(MAX_INPUT_UNITS + 1)
            .expect_err("too long")
            .limit(),
        InputLimit::Length
    );
}

#[test]
fn the_text_entry_points_count_code_units_not_bytes() {
    let compiled = compile_pattern("\u{1F600}").expect("pattern");
    let half = "\u{1F600}".repeat(MAX_INPUT_UNITS / 2);
    assert!(compiled.test(&half).is_ok());
    assert_eq!(
        compiled
            .test(&format!("{half}a"))
            .expect_err("one unit over")
            .limit(),
        InputLimit::Length
    );
}

#[test]
fn a_refusal_names_the_numbers_and_echoes_no_input_and_leaves_the_pattern_usable() {
    let compiled = compile_pattern("^a$").expect("pattern");
    let secret = "secret".repeat(MAX_INPUT_UNITS);
    let message = compiled.test(&secret).expect_err("too long").to_string();
    assert!(!message.contains("secret"));
    assert!(message.contains(&MAX_INPUT_UNITS.to_string()));
    assert!(compiled.test("a").expect("short"));
    assert!(!compiled.test("b").expect("short"));
}

#[test]
fn test_pattern_separates_a_refused_pattern_from_a_refused_input() {
    assert!(matches!(
        test_pattern("(", "a"),
        Err(TestPatternError::Parse(_))
    ));
    assert!(matches!(
        test_pattern(&largest_pattern(), &"a".repeat(largest_input_units() + 1)),
        Err(TestPatternError::Input(_))
    ));
    assert_eq!(test_pattern("a", "a"), Ok(true));
}
