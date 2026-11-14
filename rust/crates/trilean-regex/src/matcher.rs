//! The automaton and its simulation.
//!
//! A pattern is compiled to a Thompson NFA and simulated, never run by backtracking, so the work done is bounded by the pattern and the input and not by how adversarial either is. The simulation reports the work it did, in NFA state visits, so a test can assert that bound rather than time a run.

use std::cell::RefCell;

use crate::ast::{CharClassNode, RegexNode, char_class_matches};
use crate::error::RegexParseError;
use crate::parser::parse_regex_utf16;

/// What a consuming state accepts.
#[derive(Debug)]
enum CharTest {
    Literal(u16),
    Any,
    Class(CharClassNode),
}

impl CharTest {
    fn accepts(&self, unit: u16) -> bool {
        match self {
            Self::Literal(expected) => *expected == unit,
            Self::Any => true,
            Self::Class(class) => char_class_matches(class, unit),
        }
    }
}

/// One state. `Char` is the only kind that consumes input; every other kind is resolved away by the epsilon closure before a position is tested against an input character. The anchors are epsilon transitions the closure gates on the absolute position, which is what lets `^` and `$` stand anywhere in a pattern.
#[derive(Debug)]
enum State {
    Char { test: CharTest, to: usize },
    Split { first: usize, second: usize },
    AnchorStart { to: usize },
    AnchorEnd { to: usize },
    Match,
}

/// Compiles a syntax tree to states, from the end of the pattern backwards: a node is compiled knowing the state that follows it, so a fragment is complete when it is built and never needs patching afterwards.
struct Compiler {
    states: Vec<State>,
}

impl Compiler {
    fn add(&mut self, state: State) -> usize {
        self.states.push(state);
        self.states.len() - 1
    }

    fn consume(&mut self, test: CharTest, next: usize) -> usize {
        self.add(State::Char { test, to: next })
    }

    /// `operand*`: a loop whose split either enters the operand, which returns to the split, or leaves.
    fn star(&mut self, operand: &RegexNode, next: usize) -> (usize, usize) {
        let split = self.add(State::Split {
            first: next,
            second: next,
        });
        let body = self.compile(operand, split);
        self.states[split] = State::Split {
            first: body,
            second: next,
        };
        (split, body)
    }

    fn optional(&mut self, operand: &RegexNode, next: usize) -> usize {
        let body = self.compile(operand, next);
        self.add(State::Split {
            first: body,
            second: next,
        })
    }

    /// The operands one after another. An empty sequence is `next` itself: it consumes nothing.
    fn sequence<'a>(
        &mut self,
        operands: impl DoubleEndedIterator<Item = &'a RegexNode>,
        next: usize,
    ) -> usize {
        operands
            .rev()
            .fold(next, |following, operand| self.compile(operand, following))
    }

    /// `{min,max}` as `min` mandatory copies followed by `max - min` independently optional ones, or, with no upper bound, `min - 1` copies and a `+`. Optional copies in sequence already give the counting language of zero to `max - min` repetitions: each consumes the operand or skips it, and the simulation follows every combination.
    fn repeat(&mut self, operand: &RegexNode, min: u32, max: Option<u32>, next: usize) -> usize {
        let (mandatory, tail) = match max {
            None if min == 0 => return self.star(operand, next).0,
            None => (min - 1, self.star(operand, next).1),
            Some(max) => {
                let mut tail = next;
                for _ in 0..max - min {
                    tail = self.optional(operand, tail);
                }
                (min, tail)
            }
        };
        (0..mandatory).fold(tail, |following, _| self.compile(operand, following))
    }

    /// Compiles `node` so that it continues at `next` once it has matched, and returns its entry state.
    fn compile(&mut self, node: &RegexNode, next: usize) -> usize {
        match node {
            RegexNode::Literal { code_unit } => self.consume(CharTest::Literal(*code_unit), next),
            RegexNode::AnyChar => self.consume(CharTest::Any, next),
            RegexNode::CharClass(class) => self.consume(CharTest::Class(class.clone()), next),
            RegexNode::AnchorStart => self.add(State::AnchorStart { to: next }),
            RegexNode::AnchorEnd => self.add(State::AnchorEnd { to: next }),
            RegexNode::Concat(operands) => self.sequence(operands.iter(), next),
            RegexNode::Alternation(branches) => {
                let mut entry: Option<usize> = None;
                for branch in branches.iter().rev() {
                    let branch_entry = self.compile(branch, next);
                    entry = Some(match entry {
                        None => branch_entry,
                        Some(rest) => self.add(State::Split {
                            first: branch_entry,
                            second: rest,
                        }),
                    });
                }
                entry.expect("the parser builds an alternation of at least two branches")
            }
            RegexNode::Star(operand) => self.star(operand, next).0,
            RegexNode::Plus(operand) => self.star(operand, next).1,
            RegexNode::Optional(operand) => self.optional(operand, next),
            RegexNode::Repeat { operand, min, max } => self.repeat(operand, *min, *max, next),
        }
    }
}

/// The most states a pattern may compile to, the final match state included. It bounds the memory a pattern can take before anything is allocated for it: `a{99999}` is within the limit and `a{100000}` is not, and so is `(?:a{1000}){1000}`, whose nested counts multiply. A pattern over it is a `RegexParseError` at the repetition that went over, or at index 0 when only the sum of several did.
pub const MAX_STATES: usize = 100_000;

/// The number of states `node` compiles to, not counting the final match state, as `Compiler` builds them. It is computed from the tree without building the automaton, with saturating arithmetic, so a pattern is refused before the memory it would need is asked for. A test keeps it equal to the compiler's own count.
pub(crate) fn states_of(node: &RegexNode) -> u64 {
    match node {
        RegexNode::Literal { .. }
        | RegexNode::AnyChar
        | RegexNode::CharClass(_)
        | RegexNode::AnchorStart
        | RegexNode::AnchorEnd => 1,
        RegexNode::Concat(operands) => operands
            .iter()
            .fold(0u64, |sum, operand| sum.saturating_add(states_of(operand))),
        RegexNode::Alternation(branches) => branches
            .iter()
            .fold(branches.len().saturating_sub(1) as u64, |sum, branch| {
                sum.saturating_add(states_of(branch))
            }),
        RegexNode::Star(operand) | RegexNode::Plus(operand) | RegexNode::Optional(operand) => {
            states_of(operand).saturating_add(1)
        }
        RegexNode::Repeat { operand, min, max } => {
            let copy = states_of(operand);
            let looped = copy.saturating_add(1);
            let (min, max) = (u64::from(*min), max.map(u64::from));
            match max {
                None if min == 0 => looped,
                None => (min - 1).saturating_mul(copy).saturating_add(looped),
                Some(max) => min
                    .saturating_mul(copy)
                    .saturating_add((max - min).saturating_mul(looped)),
            }
        }
    }
}

/// The scratch space of the simulation, kept between calls so that a call allocates nothing once the first has run: a state is marked reached by writing the closure's epoch beside it, so no mark is ever cleared, and the lists are emptied and refilled.
#[derive(Debug)]
struct Scratch {
    /// The epoch of the closure that last reached each state.
    marks: Vec<u64>,
    epoch: u64,
    stack: Vec<usize>,
    /// The consuming states the last closure reached.
    reached: Vec<usize>,
}

/// A parsed and compiled pattern, ready to test any number of inputs without parsing or compiling again.
///
/// It keeps the simulation's scratch space between calls, so it is not `Sync`: one pattern is tested from one thread at a time, and a pattern per thread costs only its states.
#[derive(Debug)]
pub struct CompiledPattern {
    states: Vec<State>,
    start: usize,
    scratch: RefCell<Scratch>,
}

impl CompiledPattern {
    pub(crate) fn from_node(node: &RegexNode) -> Self {
        let mut compiler = Compiler { states: Vec::new() };
        let matched = compiler.add(State::Match);
        let start = compiler.compile(node, matched);
        let marks = vec![0; compiler.states.len()];
        Self {
            states: compiler.states,
            start,
            scratch: RefCell::new(Scratch {
                marks,
                epoch: 0,
                stack: Vec::new(),
                reached: Vec::new(),
            }),
        }
    }

    /// The number of states in the automaton, which is what bounds the work of one position of the input. It is at most `MAX_STATES`.
    pub fn state_count(&self) -> usize {
        self.states.len()
    }

    /// Whether any substring of `input` matches: a search, as a bare `RegExp.prototype.test` is, with `^` and `$` ordinary states of the automaton and not a separate mode. `input` is read as UTF-16 code units.
    pub fn test(&self, input: &str) -> bool {
        self.test_counted(input).0
    }

    /// `test` for input that is already code units, which may hold an unpaired surrogate.
    pub fn test_utf16(&self, input: &[u16]) -> bool {
        self.test_utf16_counted(input).0
    }

    /// `test`, with the number of NFA state visits it took.
    pub fn test_counted(&self, input: &str) -> (bool, usize) {
        self.test_utf16_counted(&input.encode_utf16().collect::<Vec<u16>>())
    }

    /// `test_utf16`, with the number of NFA state visits it took.
    ///
    /// A visit is the epsilon closure expanding a state, at most once per state per input position, so the count is at most `state_count() * (input.len() + 1)`: it never depends on how the pattern is nested or on what the input contains. The simulation adds a fresh thread at every position, as if `.*?` preceded the pattern, without building that prefix (Cox, "Regular Expression Matching Can Be Simple And Fast").
    pub fn test_utf16_counted(&self, input: &[u16]) -> (bool, usize) {
        let mut scratch = self.scratch.borrow_mut();
        let mut simulation = Simulation {
            states: &self.states,
            scratch: &mut scratch,
            visits: 0,
        };
        simulation.scratch.stack.clear();
        simulation.scratch.stack.push(self.start);
        let length = input.len();
        let mut matched = simulation.close(0, length);
        for (position, unit) in input.iter().enumerate() {
            if matched {
                break;
            }
            simulation.scratch.stack.clear();
            for index in &simulation.scratch.reached {
                if let State::Char { test, to } = &self.states[*index]
                    && test.accepts(*unit)
                {
                    simulation.scratch.stack.push(*to);
                }
            }
            simulation.scratch.stack.push(self.start);
            matched = simulation.close(position + 1, length);
        }
        (matched, simulation.visits)
    }
}

/// One simulation over a pattern's scratch space.
struct Simulation<'a> {
    states: &'a [State],
    scratch: &'a mut Scratch,
    visits: usize,
}

impl Simulation<'_> {
    /// The epsilon closure of the states on the stack at `position`, the boundary before the code unit at that index, so `position == length` is after the last one. It follows every split, and an anchor only when the position satisfies it. The consuming states it reaches replace `reached`, and the result is whether it reached the match state.
    fn close(&mut self, position: usize, length: usize) -> bool {
        let scratch = &mut *self.scratch;
        scratch.epoch += 1;
        scratch.reached.clear();
        let mut matched = false;
        while let Some(index) = scratch.stack.pop() {
            if scratch.marks[index] == scratch.epoch {
                continue;
            }
            scratch.marks[index] = scratch.epoch;
            self.visits += 1;
            match &self.states[index] {
                State::Char { .. } => scratch.reached.push(index),
                State::Match => matched = true,
                State::Split { first, second } => scratch.stack.extend([*first, *second]),
                State::AnchorStart { to } if position == 0 => scratch.stack.push(*to),
                State::AnchorEnd { to } if position == length => scratch.stack.push(*to),
                State::AnchorStart { .. } | State::AnchorEnd { .. } => {}
            }
        }
        matched
    }
}

/// Parses and compiles a pattern given as UTF-16 code units, which may hold an unpaired surrogate.
pub fn compile_pattern_utf16(pattern: &[u16]) -> Result<CompiledPattern, RegexParseError> {
    parse_regex_utf16(pattern).map(|node| CompiledPattern::from_node(&node))
}

/// Parses and compiles a pattern, so that it is parsed once however many inputs are tested.
pub fn compile_pattern(pattern: &str) -> Result<CompiledPattern, RegexParseError> {
    compile_pattern_utf16(&pattern.encode_utf16().collect::<Vec<u16>>())
}

/// Parses `pattern` and tests it against `input` in one call, which costs what compiling and testing once cost.
pub fn test_pattern(pattern: &str, input: &str) -> Result<bool, RegexParseError> {
    compile_pattern(pattern).map(|compiled| compiled.test(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_regex;

    #[test]
    fn the_count_computed_from_the_tree_is_the_count_the_compiler_builds() {
        for pattern in [
            "",
            "a",
            "ab",
            "a|b|c",
            "a*",
            "a+",
            "a?",
            "a{0}",
            "a{3}",
            "a{2,5}",
            "a{0,}",
            "a{3,}",
            "^a$",
            "[a-z]",
            ".",
            "(?:a|bc)*d",
            "(?:a{2,3}){2,4}",
            "(?:a?){5}a{5}",
            "(?:|a)+",
            "x{0,0}y",
            "(?:a{0}){3}",
        ] {
            let node = parse_regex(pattern).expect(pattern);
            let compiled = CompiledPattern::from_node(&node);
            assert_eq!(
                states_of(&node) + 1,
                compiled.state_count() as u64,
                "{pattern}"
            );
        }
    }

    #[test]
    fn the_count_saturates_instead_of_overflowing() {
        let huge = RegexNode::Repeat {
            operand: Box::new(RegexNode::Repeat {
                operand: Box::new(RegexNode::Literal { code_unit: 97 }),
                min: u32::MAX,
                max: Some(u32::MAX),
            }),
            min: u32::MAX,
            max: Some(u32::MAX),
        };
        assert!(states_of(&huge) > MAX_STATES as u64);
    }

    #[test]
    fn a_pattern_tested_twice_gives_the_same_answer_and_the_same_work_without_a_new_allocation() {
        let compiled = crate::compile_pattern("^(?:a|ab)+c$").expect("pattern");
        let first = compiled.test_counted("aabac");
        let capacity = compiled.scratch.borrow().marks.capacity();
        assert_eq!(compiled.test_counted("aabac"), first);
        assert_eq!(compiled.scratch.borrow().marks.capacity(), capacity);
        assert_eq!(
            compiled.test_counted("aabax"),
            (false, compiled.test_counted("aabax").1)
        );
    }
}
