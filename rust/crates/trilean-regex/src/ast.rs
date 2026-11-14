//! The abstract syntax the parser produces and the matcher compiles.
//!
//! Every node kind is a construct of a true regular language: there is no node for anything a finite automaton cannot express (a backreference, a lookaround assertion). A character is a UTF-16 code unit, so a character outside the Basic Multilingual Plane is two nodes, each matched on its own, as a non-`u`-flag ECMAScript `RegExp` reads it.

/// An inclusive range of code units, `from <= to`. A single character `c` is `{ from: c, to: c }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CharRange {
    /// The first code unit of the range.
    pub from: u16,
    /// The last code unit of the range, never below `from`.
    pub to: u16,
}

/// `[...]` and `[^...]`, and the standalone shorthand classes once expanded. `ranges` is the positive set and `negated` flips membership, so a negated class still reports the ranges it was written against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CharClassNode {
    /// Whether the class holds the code units outside `ranges` instead of the ones inside.
    pub negated: bool,
    /// The positive set, in the order written.
    pub ranges: Vec<CharRange>,
}

/// A node of the syntax tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegexNode {
    /// One character, by its code unit.
    Literal {
        /// The code unit matched.
        code_unit: u16,
    },
    /// `.`: exactly one code unit of any value, a line terminator included.
    AnyChar,
    /// A bracketed class, or a shorthand class used as an atom.
    CharClass(CharClassNode),
    /// `^`: the position is the start of the input.
    AnchorStart,
    /// `$`: the position is the end of the input.
    AnchorEnd,
    /// The operands one after another. No operands is the empty pattern.
    Concat(Vec<RegexNode>),
    /// One of the branches. The parser never builds one with fewer than two.
    Alternation(Vec<RegexNode>),
    /// `a*`: zero or more repetitions.
    Star(Box<RegexNode>),
    /// `a+`: one or more repetitions.
    Plus(Box<RegexNode>),
    /// `a?`: zero or one repetition.
    Optional(Box<RegexNode>),
    /// Between `min` and `max` repetitions, `max: None` meaning no upper bound. The parser builds it for a braced count only, `{0,}`, `{1,}` and `{0,1}` included, and never with `min > max`. `*`, `+` and `?` are `Star`, `Plus` and `Optional`.
    Repeat {
        /// What is repeated.
        operand: Box<RegexNode>,
        /// The fewest repetitions.
        min: u32,
        /// The most repetitions, `None` for no limit.
        max: Option<u32>,
    },
}

/// Whether `unit` falls inside the inclusive range.
pub fn range_contains(range: &CharRange, unit: u16) -> bool {
    unit >= range.from && unit <= range.to
}

/// Whether `unit` is a member of the class, honouring `negated`.
pub fn char_class_matches(node: &CharClassNode, unit: u16) -> bool {
    let in_ranges = node.ranges.iter().any(|range| range_contains(range, unit));
    in_ranges != node.negated
}

#[cfg(test)]
mod tests {
    use super::*;

    const RANGE: CharRange = CharRange { from: 10, to: 20 };

    #[test]
    fn a_range_includes_both_endpoints_and_what_lies_between() {
        assert!(range_contains(&RANGE, 10));
        assert!(range_contains(&RANGE, 15));
        assert!(range_contains(&RANGE, 20));
    }

    #[test]
    fn a_range_excludes_the_units_either_side() {
        assert!(!range_contains(&RANGE, 9));
        assert!(!range_contains(&RANGE, 21));
    }

    #[test]
    fn a_class_unions_its_ranges_and_negation_inverts_membership() {
        let ranges = vec![RANGE, CharRange { from: 30, to: 30 }];
        let positive = CharClassNode {
            negated: false,
            ranges: ranges.clone(),
        };
        let negated = CharClassNode {
            negated: true,
            ranges,
        };
        for unit in [9, 10, 20, 21, 30, 31] {
            assert_eq!(
                char_class_matches(&positive, unit),
                !char_class_matches(&negated, unit)
            );
        }
        assert!(char_class_matches(&positive, 30));
        assert!(!char_class_matches(&positive, 25));
        assert!(char_class_matches(&negated, 25));
    }
}
