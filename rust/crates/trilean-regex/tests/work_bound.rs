//! The matcher's work is bounded by the pattern and the input, whatever the pattern is. These patterns make a backtracking engine take exponential time; here the number of NFA state visits stays at or under `state_count * (input length + 1)`, and doubling the input at most doubles it.

use trilean_regex::{CompiledPattern, compile_pattern};

const SUBJECT_LENGTH: usize = 10_000;

/// Pathological patterns, each of which ends in a character the all-`a` subject lacks, so no thread matches and every position is searched.
fn patterns() -> Vec<String> {
    vec![
        "(?:a*)*b".to_owned(),
        "(?:a|a)*b".to_owned(),
        "^(?:a+)+b$".to_owned(),
        "(?:a|aa)+b".to_owned(),
        "(?:a*)*(?:a*)*b".to_owned(),
        format!("(?:a?){{{n}}}a{{{n}}}b", n = 25),
    ]
}

fn visits(compiled: &CompiledPattern, subject: &str) -> usize {
    let (matched, visits) = compiled.test_counted(subject);
    assert!(!matched);
    visits
}

#[test]
fn visits_stay_within_the_states_times_the_positions() {
    let subject = "a".repeat(SUBJECT_LENGTH);
    for pattern in patterns() {
        let compiled = compile_pattern(&pattern).expect(&pattern);
        let count = visits(&compiled, &subject);
        let bound = (compiled.state_count() + 1) * (SUBJECT_LENGTH + 1);
        assert!(
            count <= bound,
            "{pattern}: {count} visits over {} states and {SUBJECT_LENGTH} code units",
            compiled.state_count()
        );
        assert!(
            count > SUBJECT_LENGTH,
            "{pattern} must do work at every position"
        );
        eprintln!(
            "{pattern}: {} states, {count} visits over {SUBJECT_LENGTH} code units",
            compiled.state_count()
        );
    }
}

#[test]
fn doubling_the_input_at_most_doubles_the_visits_plus_a_constant() {
    for pattern in patterns() {
        let compiled = compile_pattern(&pattern).expect(&pattern);
        let single = visits(&compiled, &"a".repeat(SUBJECT_LENGTH));
        let double = visits(&compiled, &"a".repeat(2 * SUBJECT_LENGTH));
        // Before the set of live states saturates, the first positions do less work than later ones: at most `state_count` positions, each short of the steady state by at most `state_count`.
        let ramp_up = compiled.state_count() * compiled.state_count();
        assert!(
            double <= 2 * single + ramp_up,
            "{pattern}: {single} visits for {SUBJECT_LENGTH} code units and {double} for twice as many"
        );
    }
}

#[test]
fn the_counted_and_uncounted_entry_points_agree() {
    let compiled = compile_pattern("^(?:a+)+b$").expect("pattern");
    for subject in ["aaab", "aaac", "", "b"] {
        assert_eq!(
            compiled.test(subject),
            compiled.test_counted(subject).0,
            "{subject}"
        );
    }
}

#[test]
fn a_match_found_early_stops_the_work() {
    let compiled = compile_pattern("^a").expect("pattern");
    let (matched, early) = compiled.test_counted(&"a".repeat(SUBJECT_LENGTH));
    assert!(matched);
    assert!(early < compiled.state_count() * 2);
}
