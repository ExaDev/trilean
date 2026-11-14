//! The shorthand classes `\d`, `\w` and `\s` and their negations.
//!
//! Each expansion is a constant this crate owns rather than a delegation to a host's notion of a digit, a word character or a space, so a pattern means the same wherever it is compiled to. `\d` is the ASCII digits, `\w` the ASCII letters, digits and underscore, and `\s` the six ASCII white-space characters. ECMAScript's `\s` is wider (it includes U+00A0, U+FEFF, U+2028 and the `Zs` space separators, with or without the `u` flag), which is why a pattern using it does not compile through `compile_ecmascript_subset`.

use crate::ast::{CharClassNode, CharRange};

/// The letter a shorthand class is written with: upper case negates the class of the lower case.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShorthandClassLetter {
    /// `\d`, the ASCII digits.
    D,
    /// `\D`, everything but the ASCII digits.
    UpperD,
    /// `\w`, the ASCII letters, digits and underscore.
    W,
    /// `\W`, everything but those.
    UpperW,
    /// `\s`, the six ASCII white-space characters.
    S,
    /// `\S`, everything but those.
    UpperS,
}

impl ShorthandClassLetter {
    /// The class for the character after a backslash, if it is one of `d`, `D`, `w`, `W`, `s` and `S`.
    pub fn from_unit(unit: u16) -> Option<Self> {
        match u8::try_from(unit).ok()? {
            b'd' => Some(Self::D),
            b'D' => Some(Self::UpperD),
            b'w' => Some(Self::W),
            b'W' => Some(Self::UpperW),
            b's' => Some(Self::S),
            b'S' => Some(Self::UpperS),
            _ => None,
        }
    }

    /// The letter as written.
    pub fn letter(self) -> char {
        match self {
            Self::D => 'd',
            Self::UpperD => 'D',
            Self::W => 'w',
            Self::UpperW => 'W',
            Self::S => 's',
            Self::UpperS => 'S',
        }
    }

    fn negated(self) -> bool {
        matches!(self, Self::UpperD | Self::UpperW | Self::UpperS)
    }

    fn positive_ranges(self) -> Vec<CharRange> {
        match self {
            Self::D | Self::UpperD => vec![range(b'0', b'9')],
            Self::W | Self::UpperW => vec![
                range(b'A', b'Z'),
                range(b'a', b'z'),
                range(b'0', b'9'),
                single(b'_'),
            ],
            Self::S | Self::UpperS => vec![
                single(b' '),
                single(b'\t'),
                single(b'\n'),
                single(b'\r'),
                single(0x0C),
                single(0x0B),
            ],
        }
    }
}

fn range(from: u8, to: u8) -> CharRange {
    CharRange {
        from: u16::from(from),
        to: u16::from(to),
    }
}

fn single(unit: u8) -> CharRange {
    range(unit, unit)
}

/// The class a shorthand letter stands for, as a standalone atom: the negated letters keep the positive ranges and set `negated`, rather than owning a second range table.
pub fn expand_shorthand_class(letter: ShorthandClassLetter) -> CharClassNode {
    CharClassNode {
        negated: letter.negated(),
        ranges: letter.positive_ranges(),
    }
}

/// The ranges a shorthand letter contributes inside a bracketed class. A negated letter cannot flip the whole class, which may hold other members, so its ranges are the complement of the positive set over every code unit.
pub(crate) fn class_member_ranges(letter: ShorthandClassLetter) -> Vec<CharRange> {
    let positive = letter.positive_ranges();
    if letter.negated() {
        complement(&positive)
    } else {
        positive
    }
}

/// The ranges in ascending order with overlapping and adjacent ranges merged.
pub(crate) fn normalise(ranges: &[CharRange]) -> Vec<CharRange> {
    let mut sorted = ranges.to_vec();
    sorted.sort_by_key(|range| range.from);
    let mut merged: Vec<CharRange> = Vec::with_capacity(sorted.len());
    for range in sorted {
        match merged.last_mut() {
            Some(last) if u32::from(range.from) <= u32::from(last.to) + 1 => {
                last.to = last.to.max(range.to);
            }
            _ => merged.push(range),
        }
    }
    merged
}

/// Every code unit the ranges do not hold, as ascending merged ranges.
pub(crate) fn complement(ranges: &[CharRange]) -> Vec<CharRange> {
    let mut gaps = Vec::new();
    // The first code unit not yet accounted for, or `None` once a range has reached the top of the space.
    let mut next = Some(0u16);
    for range in normalise(ranges) {
        if let Some(start) = next
            && start < range.from
        {
            gaps.push(CharRange {
                from: start,
                to: range.from - 1,
            });
        }
        next = range.to.checked_add(1);
    }
    if let Some(start) = next {
        gaps.push(CharRange {
            from: start,
            to: u16::MAX,
        });
    }
    gaps
}

/// The ranges a shorthand letter holds in an unflagged ECMAScript `RegExp`, where it differs from this grammar's only for `\s` and `\S`: ECMAScript's `\s` is every white-space and line-terminator code point, which includes U+00A0, U+FEFF, U+2028, U+2029 and the `Zs` separators, with or without the `u` flag.
pub(crate) fn ecmascript_member_ranges(letter: ShorthandClassLetter) -> Vec<CharRange> {
    let spaces = || {
        let unit = |unit: u16| CharRange {
            from: unit,
            to: unit,
        };
        vec![
            CharRange {
                from: 0x09,
                to: 0x0D,
            },
            unit(0x20),
            unit(0xA0),
            unit(0x1680),
            CharRange {
                from: 0x2000,
                to: 0x200A,
            },
            CharRange {
                from: 0x2028,
                to: 0x2029,
            },
            unit(0x202F),
            unit(0x205F),
            unit(0x3000),
            unit(0xFEFF),
        ]
    };
    match letter {
        ShorthandClassLetter::S => spaces(),
        ShorthandClassLetter::UpperS => complement(&spaces()),
        other => class_member_ranges(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::char_class_matches;

    fn members(letter: ShorthandClassLetter) -> Vec<u16> {
        let class = expand_shorthand_class(letter);
        (0..=u16::MAX)
            .filter(|unit| char_class_matches(&class, *unit))
            .collect()
    }

    #[test]
    fn d_is_the_ascii_digits() {
        assert_eq!(
            members(ShorthandClassLetter::D),
            (u16::from(b'0')..=u16::from(b'9')).collect::<Vec<_>>()
        );
    }

    #[test]
    fn w_is_ascii_letters_digits_and_underscore_only() {
        let word = members(ShorthandClassLetter::W);
        assert_eq!(word.len(), 26 + 26 + 10 + 1);
        assert!(word.contains(&u16::from(b'_')));
        assert!(!word.contains(&0xE9));
    }

    #[test]
    fn s_is_the_six_ascii_white_space_characters_and_nothing_wider() {
        assert_eq!(
            members(ShorthandClassLetter::S),
            vec![9, 10, 11, 12, 13, 32]
        );
    }

    #[test]
    fn a_negated_letter_keeps_the_positive_ranges_and_flips_membership() {
        for (positive, negated) in [
            (ShorthandClassLetter::D, ShorthandClassLetter::UpperD),
            (ShorthandClassLetter::W, ShorthandClassLetter::UpperW),
            (ShorthandClassLetter::S, ShorthandClassLetter::UpperS),
        ] {
            let negative = expand_shorthand_class(negated);
            assert!(negative.negated);
            assert_eq!(negative.ranges, expand_shorthand_class(positive).ranges);
            assert_eq!(
                members(positive).len() + members(negated).len(),
                usize::from(u16::MAX) + 1
            );
        }
    }

    #[test]
    fn inside_a_class_a_negated_letter_is_the_ranges_of_its_complement() {
        for (positive, negated) in [
            (ShorthandClassLetter::D, ShorthandClassLetter::UpperD),
            (ShorthandClassLetter::W, ShorthandClassLetter::UpperW),
            (ShorthandClassLetter::S, ShorthandClassLetter::UpperS),
        ] {
            let inside = CharClassNode {
                negated: false,
                ranges: class_member_ranges(negated),
            };
            let outside = expand_shorthand_class(negated);
            for unit in 0..=u16::MAX {
                assert_eq!(
                    char_class_matches(&inside, unit),
                    char_class_matches(&outside, unit),
                    "{} at {unit}",
                    negated.letter()
                );
            }
            assert_eq!(
                class_member_ranges(positive),
                expand_shorthand_class(positive).ranges
            );
        }
    }

    #[test]
    fn the_complement_of_nothing_is_every_code_unit_and_of_everything_is_nothing() {
        let all = [CharRange {
            from: 0,
            to: u16::MAX,
        }];
        assert_eq!(complement(&[]), all);
        assert_eq!(complement(&all), []);
    }

    #[test]
    fn normalise_merges_overlapping_and_adjacent_ranges_and_sorts_them() {
        let merged = normalise(&[
            CharRange { from: 20, to: 30 },
            CharRange { from: 1, to: 5 },
            CharRange { from: 6, to: 8 },
            CharRange { from: 25, to: 40 },
        ]);
        assert_eq!(
            merged,
            [CharRange { from: 1, to: 8 }, CharRange { from: 20, to: 40 }]
        );
    }

    #[test]
    fn complement_handles_ranges_at_both_ends_of_the_code_unit_space() {
        let edges = [
            CharRange { from: 0, to: 0 },
            CharRange {
                from: u16::MAX,
                to: u16::MAX,
            },
        ];
        assert_eq!(
            complement(&edges),
            [CharRange {
                from: 1,
                to: u16::MAX - 1
            }]
        );
    }
}
