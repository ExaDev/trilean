//! The number form of a canonical file is the text `JSON.stringify` writes for the double, which `json_shape` implements
//! by hand. `number-forms.txt` holds, for a spread of doubles (the edge values, every decade's boundaries, random bit
//! patterns, shortest-digit and tie cases), the bits of the double and the text a JavaScript engine writes for it, so
//! the routine is held to the engine itself and not to a handful of literals.

use corpus_format::{check_canonical, write_canonical};
use json_shape::Value;

const FORMS: &str = include_str!("number-forms.txt");

fn forms() -> Vec<(f64, &'static str)> {
    FORMS
        .lines()
        .map(|line| {
            let (bits, text) = line.split_once(' ').expect("a line is bits and text");
            let bits = u64::from_str_radix(bits, 16).expect("bits are hexadecimal");
            (f64::from_bits(bits), text)
        })
        .collect()
}

#[test]
fn the_table_is_large_and_spread() {
    let forms = forms();
    assert!(forms.len() > 5_000, "{}", forms.len());
    assert!(forms.iter().any(|(_, text)| text.contains("e+")));
    assert!(forms.iter().any(|(_, text)| text.contains("e-")));
    assert!(forms.iter().any(|(number, _)| number.is_subnormal()));
}

#[test]
fn a_double_is_written_as_the_engine_writes_it() {
    let mut wrong = Vec::new();
    for (number, text) in forms() {
        let written = Value::Number(number).to_string();
        if written != text {
            wrong.push(format!(
                "{:016x}: wrote {written}, the engine writes {text}",
                number.to_bits()
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} differ, the first: {:?}",
        wrong.len(),
        wrong.first()
    );
}

#[test]
fn the_engines_text_is_canonical_and_reads_back_as_the_double() {
    for (number, text) in forms() {
        let document = format!("{text}\n");
        assert_eq!(check_canonical(document.as_bytes()), Ok(()), "{text}");
        let value = json_shape::Value::Number(number);
        assert_eq!(
            write_canonical(&value).as_deref(),
            Ok(document.as_str()),
            "{text}"
        );
    }
}
