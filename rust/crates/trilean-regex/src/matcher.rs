//! The automaton and its simulation.
//!
//! A pattern is compiled to a Thompson NFA and simulated, never run by backtracking, so the work done is bounded by the pattern and the input and not by how adversarial either is. The simulation reports the work it did, in NFA state visits, so a test can assert that bound rather than time a run.

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

/// A parsed and compiled pattern, ready to test any number of inputs without parsing or compiling again.
#[derive(Debug)]
pub struct CompiledPattern {
    states: Vec<State>,
    start: usize,
}

impl CompiledPattern {
    pub(crate) fn from_node(node: &RegexNode) -> Self {
        let mut compiler = Compiler { states: Vec::new() };
        let matched = compiler.add(State::Match);
        let start = compiler.compile(node, matched);
        Self {
            states: compiler.states,
            start,
        }
    }

    /// The number of states in the automaton, which is what bounds the work of one position of the input.
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
        let mut simulation = Simulation {
            states: &self.states,
            marks: vec![0; self.states.len()],
            epoch: 0,
            stack: Vec::new(),
            visits: 0,
        };
        let length = input.len();
        let mut current = Vec::new();
        let mut seeds = vec![self.start];
        let mut matched = simulation.close(&seeds, 0, length, &mut current);
        for (position, unit) in input.iter().enumerate() {
            if matched {
                break;
            }
            seeds.clear();
            seeds.extend(
                current
                    .iter()
                    .filter_map(|index| match &self.states[*index] {
                        State::Char { test, to } if test.accepts(*unit) => Some(*to),
                        _ => None,
                    }),
            );
            seeds.push(self.start);
            matched = simulation.close(&seeds, position + 1, length, &mut current);
        }
        (matched, simulation.visits)
    }
}

/// The scratch space of one simulation: the states each closure has reached, so a closure visits a state once.
struct Simulation<'a> {
    states: &'a [State],
    /// The epoch of the closure that last reached each state.
    marks: Vec<u64>,
    epoch: u64,
    stack: Vec<usize>,
    visits: usize,
}

impl Simulation<'_> {
    /// The epsilon closure of `seeds` at `position`, the boundary before the code unit at that index, so `position == length` is after the last one. It follows every split, and an anchor only when the position satisfies it. The consuming states it reaches replace `reached`, and the result is whether it reached the match state.
    fn close(
        &mut self,
        seeds: &[usize],
        position: usize,
        length: usize,
        reached: &mut Vec<usize>,
    ) -> bool {
        self.epoch += 1;
        reached.clear();
        self.stack.clear();
        self.stack.extend_from_slice(seeds);
        let mut matched = false;
        while let Some(index) = self.stack.pop() {
            if self.marks[index] == self.epoch {
                continue;
            }
            self.marks[index] = self.epoch;
            self.visits += 1;
            match &self.states[index] {
                State::Char { .. } => reached.push(index),
                State::Match => matched = true,
                State::Split { first, second } => self.stack.extend([*first, *second]),
                State::AnchorStart { to } if position == 0 => self.stack.push(*to),
                State::AnchorEnd { to } if position == length => self.stack.push(*to),
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
