//! Which patterns compile as ECMAScript-compatible ones, and where the refused ones are reported.

use trilean_regex::{EcmaSubsetError, compile_ecmascript_subset};

fn unsupported(pattern: &str) -> (usize, &'static str) {
    match compile_ecmascript_subset(pattern) {
        Err(EcmaSubsetError::Unsupported { index, construct }) => (index, construct),
        other => panic!("{pattern} gave {other:?}, expected an unsupported construct"),
    }
}

#[test]
fn the_patterns_the_derived_builders_write_compile() {
    for pattern in [
        "",
        "^$",
        r"^foo(?:\.[\s\S]*)?$",
        r"^a\*b[\s\S]*$",
        r"^[^\/]*$",
        r"^(?:[^\/]*\/)*[^\/]*$",
        r"^[\s\S]*x[\s\S]*$",
        r"^\^\$\\\.\*\+\?\(\)\[\]\{\}\|\/$",
        "^\u{1F600}[\\s\\S]*$",
    ] {
        assert!(compile_ecmascript_subset(pattern).is_ok(), "{pattern}");
    }
}

#[test]
fn a_dot_is_refused_with_its_index() {
    assert_eq!(unsupported("ab.c"), (2, "."));
    assert_eq!(unsupported("."), (0, "."));
    assert_eq!(unsupported("(?:x|.)"), (5, "."));
}

#[test]
fn a_dot_that_is_escaped_or_inside_a_class_is_a_literal_in_both_languages() {
    assert!(compile_ecmascript_subset(r"a\.b").is_ok());
    assert!(compile_ecmascript_subset("a[.]b").is_ok());
}

#[test]
fn a_space_shorthand_outside_a_class_is_refused() {
    assert_eq!(unsupported(r"a\s*"), (1, "\\s"));
    assert_eq!(unsupported(r"\S+"), (0, "\\S"));
}

#[test]
fn a_class_holding_a_space_shorthand_is_refused_unless_it_holds_every_code_unit() {
    assert_eq!(unsupported(r"[\s]"), (1, "\\s"));
    assert_eq!(unsupported(r"[a\S]"), (2, "\\S"));
    assert_eq!(unsupported(r"[^\s]"), (2, "\\s"));
    assert_eq!(unsupported(r"[\s\d]"), (1, "\\s"));
    for pattern in [r"[\s\S]", r"[\S\s]", r"[^\s\S]", r"[a\s\S]", r"[\s\Sx-z]"] {
        assert!(compile_ecmascript_subset(pattern).is_ok(), "{pattern}");
    }
}

#[test]
fn the_other_shorthands_mean_the_same_in_both_languages() {
    for pattern in [r"^\d+$", r"\w\W", r"[\D\w]", r"[^\d]"] {
        assert!(compile_ecmascript_subset(pattern).is_ok(), "{pattern}");
    }
}

#[test]
fn a_braced_quantifier_with_nothing_to_repeat_is_refused() {
    assert_eq!(unsupported("{2}"), (0, "{"));
    assert_eq!(unsupported("x|{1,3}"), (2, "{"));
    assert_eq!(unsupported("(?:{2,})"), (3, "{"));
}

#[test]
fn a_brace_that_is_a_literal_in_both_languages_compiles() {
    for pattern in ["a{2}", "a{", "{", "{,5}", "a{}", "x{1", "^{a}$"] {
        assert!(compile_ecmascript_subset(pattern).is_ok(), "{pattern}");
    }
}

#[test]
fn the_construct_at_the_lowest_index_is_reported() {
    assert_eq!(unsupported(r"[\s]x."), (1, "\\s"));
    assert_eq!(unsupported(r"x.[\s]"), (1, "."));
}

#[test]
fn a_pattern_outside_the_grammar_is_a_parse_error() {
    match compile_ecmascript_subset("a(b") {
        Err(EcmaSubsetError::Parse(error)) => assert_eq!(error.index(), 1),
        other => panic!("expected a parse error, got {other:?}"),
    }
}

#[test]
fn a_compiled_subset_pattern_matches_as_the_grammar_does() {
    let compiled = compile_ecmascript_subset(r"^[^\/]*\/[\s\S]*$").expect("pattern");
    assert!(compiled.test("a/b\nc"));
    assert!(!compiled.test("a"));
}

#[test]
fn the_error_names_the_construct_and_the_index() {
    let error = compile_ecmascript_subset("a.").expect_err("dot");
    assert_eq!(
        error.to_string(),
        "the construct '.' at index 1 does not mean the same in an ECMAScript regular expression"
    );
}

#[test]
fn a_class_holding_s_and_the_six_white_space_characters_is_not_every_code_unit_in_ecmascript() {
    assert_eq!(unsupported(r"[\S \t\n\r\f\v]"), (1, "\\S"));
    assert_eq!(unsupported(r"[^\S \t\n\r\f\v]"), (2, "\\S"));
}

#[test]
fn a_class_is_judged_by_the_set_it_holds_not_by_its_spelling() {
    for pattern in [
        r"[\s\S]",
        r"[\S\s]",
        r"[^\s\S]",
        "[\\s\\S\u{a0}]",
        r"[\d-a]",
        r"[\w-\d]",
        "[a-\u{7f}\\d-]",
        "[\\S\u{a0}\\s]",
        r"[a\w-b-d]",
    ] {
        assert!(compile_ecmascript_subset(pattern).is_ok(), "{pattern}");
    }
}

#[test]
fn a_shorthand_class_chained_to_a_range_by_a_hyphen_is_a_union_in_ecmascript() {
    assert_eq!(unsupported(r"[\d-a-z]"), (3, "-"));
    assert_eq!(unsupported("[^\\W-\u{0}-9]"), (4, "-"));
    assert_eq!(unsupported(r"[a\d-b-d]"), (4, "-"));
}

#[test]
fn the_pattern_is_refused_for_the_one_construct_that_differs_and_accepted_when_none_does() {
    assert!(compile_ecmascript_subset(r"[\d-]").is_ok());
    assert!(compile_ecmascript_subset(r"[\d-\w]").is_ok());
    assert!(compile_ecmascript_subset(r"[a-z\d]").is_ok());
}

#[test]
fn a_class_ecmascript_refuses_as_a_syntax_error_is_refused_not_read_as_another_set() {
    // ECMAScript reads `\D-!` as a union and then `--\t` as a range from `-` down to a tab, which is out of order there.
    assert_eq!(unsupported(r"[^\/\D-!--\t]"), (6, "-"));
}
