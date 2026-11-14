//! The regular expressions a `pattern` constraint may use: the subset of ECMAScript patterns whose meaning is the
//! same in every JSON Schema validator, so the validator here and one written for the emitted schema agree. A pattern
//! is unanchored unless it says `^` and `$`, and is matched over Unicode scalar values, as ECMAScript does with the
//! `u` flag, which is how Ajv compiles a schema's patterns.
//!
//! Supported: literal characters, `.` (any character except a line terminator), escaped punctuation (`\.`, `\\`,
//! `\/` and the other syntax characters, and `\-` inside a class), classes with ranges and negation (`[a-z0-9._-]`,
//! `[^/]`), groups (`(...)` and `(?:...)`), alternation, the greedy quantifiers `*`, `+` and `?`, and the anchors `^`
//! and `$`. Anything else (counted repetition, lazy quantifiers, `\d`-style classes, lookaround) is refused, so a
//! pattern that would mean something else in another engine does not compile.

use std::fmt;

/// Why a pattern is not in the supported subset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatternError {
    pub pattern: String,
    pub reason: String,
}

impl fmt::Display for PatternError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "pattern {:?} is not supported: {}",
            self.pattern, self.reason
        )
    }
}

impl std::error::Error for PatternError {}

#[derive(Clone, Debug)]
enum Atom {
    Char(char),
    AnyChar,
    Class {
        negated: bool,
        ranges: Vec<(char, char)>,
    },
    Group(Vec<Vec<Item>>),
    Start,
    End,
}

#[derive(Clone, Debug)]
struct Item {
    atom: Atom,
    min: usize,
    max: Option<usize>,
}

/// One state of the automaton a pattern compiles to. A state that consumes a character names the state to go to next.
#[derive(Clone, Debug)]
enum State {
    Char(char, usize),
    Any(usize),
    Class {
        negated: bool,
        ranges: Vec<(char, char)>,
        next: usize,
    },
    Split(usize, usize),
    Start(usize),
    End(usize),
    Match,
}

/// A compiled pattern, matched by simulating a Thompson automaton: no backtracking and no recursion over the text,
/// so matching costs time linear in the text times the size of the pattern, and constant stack, whatever the text.
#[derive(Clone, Debug)]
pub struct Pattern {
    states: Vec<State>,
    entry: usize,
}

struct Parser<'a> {
    pattern: &'a str,
    chars: Vec<char>,
    position: usize,
}

impl Parser<'_> {
    fn fail<T>(&self, reason: &str) -> Result<T, PatternError> {
        Err(PatternError {
            pattern: self.pattern.to_owned(),
            reason: format!("{reason} (at character {})", self.position),
        })
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn eat(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn alternatives(&mut self, nested: bool) -> Result<Vec<Vec<Item>>, PatternError> {
        let mut alternatives = vec![self.sequence()?];
        while self.eat('|') {
            alternatives.push(self.sequence()?);
        }
        if nested && self.peek() != Some(')') {
            return self.fail("a group is not closed");
        }
        Ok(alternatives)
    }

    fn sequence(&mut self) -> Result<Vec<Item>, PatternError> {
        let mut items = Vec::new();
        while let Some(next) = self.peek() {
            if next == '|' || next == ')' {
                break;
            }
            let atom = self.atom()?;
            let (min, max) = if self.eat('*') {
                (0, None)
            } else if self.eat('+') {
                (1, None)
            } else if self.eat('?') {
                (0, Some(1))
            } else {
                (1, Some(1))
            };
            if matches!(self.peek(), Some('*' | '+' | '?' | '{')) {
                return self.fail("a second quantifier, a lazy quantifier and counted repetition are not supported");
            }
            if matches!(atom, Atom::Start | Atom::End) && (min, max) != (1, Some(1)) {
                return self.fail("an anchor cannot be quantified");
            }
            items.push(Item { atom, min, max });
        }
        Ok(items)
    }

    /// The character an escape after a backslash stands for: punctuation only, and `-` only inside a class, as the
    /// `u` flag allows.
    fn escaped(&mut self, in_class: bool) -> Result<char, PatternError> {
        let Some(escaped) = self.peek() else {
            return self.fail("a pattern ends with a backslash");
        };
        self.position += 1;
        match escaped {
            '^' | '$' | '\\' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
            | '/' => Ok(escaped),
            '-' if in_class => Ok(escaped),
            _ => self.fail("only escaped punctuation is supported"),
        }
    }

    fn atom(&mut self) -> Result<Atom, PatternError> {
        let Some(next) = self.peek() else {
            return self.fail("a pattern ends where an atom is expected");
        };
        self.position += 1;
        match next {
            '.' => Ok(Atom::AnyChar),
            '^' => Ok(Atom::Start),
            '$' => Ok(Atom::End),
            '\\' => self.escaped(false).map(Atom::Char),
            '(' => {
                if self.eat('?') && !self.eat(':') {
                    return self.fail("only the (?: group form is supported");
                }
                let alternatives = self.alternatives(true)?;
                self.position += 1;
                Ok(Atom::Group(alternatives))
            }
            '[' => self.class(),
            '*' | '+' | '?' | '{' | '}' | ']' => {
                self.fail("a quantifier or bracket has nothing to apply to")
            }
            other => Ok(Atom::Char(other)),
        }
    }

    fn class_char(&mut self) -> Result<char, PatternError> {
        let Some(next) = self.peek() else {
            return self.fail("a class is not closed");
        };
        self.position += 1;
        if next == '\\' {
            return self.escaped(true);
        }
        Ok(next)
    }

    fn class(&mut self) -> Result<Atom, PatternError> {
        let negated = self.eat('^');
        let mut ranges = Vec::new();
        loop {
            match self.peek() {
                None => return self.fail("a class is not closed"),
                Some(']') => {
                    self.position += 1;
                    break;
                }
                Some(_) => {}
            }
            let from = self.class_char()?;
            let is_range = self.peek() == Some('-')
                && self
                    .chars
                    .get(self.position + 1)
                    .is_some_and(|next| *next != ']');
            if is_range {
                self.position += 1;
                let to = self.class_char()?;
                if from > to {
                    return self.fail("a class range runs backwards");
                }
                ranges.push((from, to));
            } else {
                ranges.push((from, from));
            }
        }
        if ranges.is_empty() {
            return self.fail("an empty class is not supported");
        }
        Ok(Atom::Class { negated, ranges })
    }
}

fn push(states: &mut Vec<State>, state: State) -> usize {
    states.push(state);
    states.len() - 1
}

fn compile_alternatives(alternatives: &[Vec<Item>], next: usize, states: &mut Vec<State>) -> usize {
    let mut entries: Vec<usize> = alternatives
        .iter()
        .map(|sequence| compile_sequence(sequence, next, states))
        .collect();
    let mut entry = entries.pop().unwrap_or(next);
    while let Some(earlier) = entries.pop() {
        entry = push(states, State::Split(earlier, entry));
    }
    entry
}

fn compile_sequence(items: &[Item], next: usize, states: &mut Vec<State>) -> usize {
    items.iter().rev().fold(next, |following, item| {
        compile_item(item, following, states)
    })
}

fn compile_item(item: &Item, next: usize, states: &mut Vec<State>) -> usize {
    match (item.min, item.max) {
        (0, Some(1)) => {
            let atom = compile_atom(&item.atom, next, states);
            push(states, State::Split(atom, next))
        }
        (0, None) => {
            let split = push(states, State::Split(next, next));
            let atom = compile_atom(&item.atom, split, states);
            states[split] = State::Split(atom, next);
            split
        }
        (1, None) => {
            let split = push(states, State::Split(next, next));
            let atom = compile_atom(&item.atom, split, states);
            states[split] = State::Split(atom, next);
            atom
        }
        _ => compile_atom(&item.atom, next, states),
    }
}

fn compile_atom(atom: &Atom, next: usize, states: &mut Vec<State>) -> usize {
    match atom {
        Atom::Char(expected) => push(states, State::Char(*expected, next)),
        Atom::AnyChar => push(states, State::Any(next)),
        Atom::Class { negated, ranges } => push(
            states,
            State::Class {
                negated: *negated,
                ranges: ranges.clone(),
                next,
            },
        ),
        Atom::Group(alternatives) => compile_alternatives(alternatives, next, states),
        Atom::Start => push(states, State::Start(next)),
        Atom::End => push(states, State::End(next)),
    }
}

/// The states reached so far at one position in the text.
struct Frontier {
    stamp: Vec<usize>,
    generation: usize,
    consuming: Vec<usize>,
    matched: bool,
}

impl Frontier {
    fn new(size: usize) -> Self {
        Frontier {
            stamp: vec![0; size],
            generation: 1,
            consuming: Vec::new(),
            matched: false,
        }
    }

    fn clear(&mut self) {
        self.generation += 1;
        self.consuming.clear();
        self.matched = false;
    }
}

impl Pattern {
    /// Compiles `pattern`, or says which part of it is outside the supported subset.
    pub fn new(pattern: &str) -> Result<Pattern, PatternError> {
        let mut parser = Parser {
            pattern,
            chars: pattern.chars().collect(),
            position: 0,
        };
        let alternatives = parser.alternatives(false)?;
        if parser.position != parser.chars.len() {
            return parser.fail("an unmatched closing parenthesis");
        }
        let mut states = vec![State::Match];
        let entry = compile_alternatives(&alternatives, 0, &mut states);
        Ok(Pattern { states, entry })
    }

    /// Whether the pattern matches anywhere in `text`, as `new RegExp(pattern, "u").test(text)` does.
    pub fn is_match(&self, text: &str) -> bool {
        self.is_match_with_work(text).0
    }

    /// [`Pattern::is_match`] and the number of automaton states it visited, which is at most a constant times the
    /// text's length plus one, times the number of states of the pattern.
    pub fn is_match_with_work(&self, text: &str) -> (bool, u64) {
        let input: Vec<char> = text.chars().collect();
        let mut work = 0;
        let mut stack = Vec::new();
        let mut current = Frontier::new(self.states.len());
        let mut following = Frontier::new(self.states.len());
        for position in 0..=input.len() {
            // A match may start at any position, so the start of the pattern joins the states already reached.
            self.close(
                self.entry,
                position,
                input.len(),
                &mut current,
                &mut stack,
                &mut work,
            );
            if current.matched {
                return (true, work);
            }
            let Some(&found) = input.get(position) else {
                break;
            };
            following.clear();
            for &state in &current.consuming {
                work += 1;
                let next = match &self.states[state] {
                    State::Char(expected, next) if *expected == found => Some(*next),
                    State::Any(next) if !matches!(found, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                        Some(*next)
                    }
                    State::Class {
                        negated,
                        ranges,
                        next,
                    } if ranges
                        .iter()
                        .any(|(from, to)| (*from..=*to).contains(&found))
                        != *negated =>
                    {
                        Some(*next)
                    }
                    _ => None,
                };
                if let Some(next) = next {
                    self.close(
                        next,
                        position + 1,
                        input.len(),
                        &mut following,
                        &mut stack,
                        &mut work,
                    );
                }
            }
            std::mem::swap(&mut current, &mut following);
        }
        (false, work)
    }

    /// Adds `entry` and every state reachable from it without consuming a character to `frontier`.
    fn close(
        &self,
        entry: usize,
        position: usize,
        length: usize,
        frontier: &mut Frontier,
        stack: &mut Vec<usize>,
        work: &mut u64,
    ) {
        stack.push(entry);
        while let Some(state) = stack.pop() {
            if frontier.stamp[state] == frontier.generation {
                continue;
            }
            frontier.stamp[state] = frontier.generation;
            *work += 1;
            match &self.states[state] {
                State::Split(first, second) => {
                    stack.push(*second);
                    stack.push(*first);
                }
                State::Start(next) if position == 0 => stack.push(*next),
                State::End(next) if position == length => stack.push(*next),
                State::Start(_) | State::End(_) => {}
                State::Match => frontier.matched = true,
                State::Char(..) | State::Any(_) | State::Class { .. } => {
                    frontier.consuming.push(state)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Pattern;

    fn matches(pattern: &str, text: &str) -> bool {
        Pattern::new(pattern)
            .expect("a supported pattern")
            .is_match(text)
    }

    #[test]
    fn anchors_and_classes() {
        assert!(matches("^[a-z0-9][a-z0-9._-]*$", "a.b_c-1"));
        assert!(!matches("^[a-z0-9][a-z0-9._-]*$", "A"));
        assert!(!matches("^[a-z0-9][a-z0-9._-]*$", "-a"));
        assert!(!matches("^[a-z0-9][a-z0-9._-]*$", "a\n"));
        assert!(matches("[0-9]", "x7y"));
    }

    #[test]
    fn groups_and_alternation() {
        let source = r"^(recorded: .+|[a-z0-9._-]+\.test\.ts: .+)$";
        assert!(matches(source, "recorded: x"));
        assert!(matches(source, "a.test.ts: a > b"));
        assert!(!matches(source, "a.test.ts:"));
        assert!(!matches(source, "recorded: "));
        assert!(matches("^(?:ab)+$", "abab"));
        assert!(!matches("^(?:ab)+$", "aba"));
    }

    #[test]
    fn dot_stops_at_a_line_terminator_and_counts_characters() {
        assert!(!matches("^.$", "\n"));
        assert!(!matches("^.$", "\u{2028}"));
        assert!(matches("^.$", "\u{1F600}"));
        assert!(!matches("^..$", "\u{1F600}"));
        assert!(matches("^[^/]$", "\u{1F600}"));
        assert!(matches("^\u{1F600}$", "\u{1F600}"));
    }

    #[test]
    fn unsupported_syntax_is_refused() {
        for source in [
            "a{2}", "a*?", r"\d", r"a\-b", "(?=a)", "(a", "a)", "[", "[]", "[z-a]", "*", "^*",
        ] {
            assert!(Pattern::new(source).is_err(), "{source} must be refused");
        }
        assert!(Pattern::new(r"[a\-z]").is_ok());
    }

    #[test]
    fn matching_is_linear_in_the_text_and_uses_no_stack_per_character() {
        let long = "a".repeat(200_000);
        assert!(matches("^[a-z]*$", &long));
        assert!(!matches("^[a-z]*$", &format!("{long}!")));
        let pattern = Pattern::new("^(?:a|a)*$").expect("a supported pattern");
        let (_, short) = pattern.is_match_with_work(&format!("{}b", "a".repeat(1_000)));
        let (_, double) = pattern.is_match_with_work(&format!("{}b", "a".repeat(2_000)));
        assert!(
            short <= 12 * 1_001,
            "{short} state visits for 1001 characters"
        );
        assert!(
            double <= 12 * 2_001,
            "{double} state visits for 2001 characters"
        );
        assert!(double < 3 * short, "{double} is not about twice {short}");
    }

    #[test]
    fn an_unanchored_search_is_linear_too() {
        let pattern = Pattern::new("[0-9]+x").expect("a supported pattern");
        let (_, short) = pattern.is_match_with_work(&"1".repeat(1_000));
        let (_, double) = pattern.is_match_with_work(&"1".repeat(2_000));
        assert!(double < 3 * short, "{double} is not about twice {short}");
    }

    #[test]
    fn nested_empty_loops_terminate() {
        assert!(matches("^(?:a*)*$", "aaa"));
        assert!(!matches("^(?:a*)*b$", "aaa"));
    }
}
