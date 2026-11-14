//! The regular expressions a `pattern` constraint may use: the subset of ECMAScript patterns whose meaning is the
//! same in JSON Schema validators, so the validator here and one written for the emitted schema agree. A pattern is
//! unanchored unless it says `^` and `$`, and is matched over UTF-16 code units, as ECMAScript does without the `u`
//! flag.
//!
//! Supported: literal characters of the Basic Multilingual Plane, `.` (any code unit except a line terminator),
//! escaped punctuation (`\.`, `\\`, `\/` and the other syntax characters), classes with ranges and negation
//! (`[a-z0-9._-]`, `[^/]`), groups (`(...)` and `(?:...)`), alternation, the greedy quantifiers `*`, `+` and `?`, and
//! the anchors `^` and `$`. Anything else (counted repetition, lazy quantifiers, `\d`-style classes, lookaround,
//! characters outside the Basic Multilingual Plane) is refused, so a pattern that would mean something else in
//! another engine does not compile.

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
    Unit(u16),
    AnyUnit,
    Class {
        negated: bool,
        ranges: Vec<(u16, u16)>,
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

/// A compiled pattern.
#[derive(Clone, Debug)]
pub struct Pattern {
    alternatives: Vec<Vec<Item>>,
}

struct Parser<'a> {
    pattern: &'a str,
    units: Vec<u16>,
    position: usize,
}

impl Parser<'_> {
    fn fail<T>(&self, reason: &str) -> Result<T, PatternError> {
        Err(PatternError {
            pattern: self.pattern.to_owned(),
            reason: format!("{reason} (at code unit {})", self.position),
        })
    }

    fn peek(&self) -> Option<u16> {
        self.units.get(self.position).copied()
    }

    fn eat(&mut self, unit: char) -> bool {
        if self.peek() == Some(unit as u16) {
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
        if nested && self.peek() != Some(')' as u16) {
            return self.fail("a group is not closed");
        }
        Ok(alternatives)
    }

    fn sequence(&mut self) -> Result<Vec<Item>, PatternError> {
        let mut items = Vec::new();
        while let Some(unit) = self.peek() {
            if unit == '|' as u16 || unit == ')' as u16 {
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
            if matches!(self.peek(), Some(next) if next == '*' as u16 || next == '+' as u16 || next == '?' as u16 || next == '{' as u16)
            {
                return self.fail("a second quantifier, a lazy quantifier and counted repetition are not supported");
            }
            if matches!(atom, Atom::Start | Atom::End) && (min, max) != (1, Some(1)) {
                return self.fail("an anchor cannot be quantified");
            }
            items.push(Item { atom, min, max });
        }
        Ok(items)
    }

    fn escaped(&mut self) -> Result<u16, PatternError> {
        let Some(unit) = self.peek() else {
            return self.fail("a pattern ends with a backslash");
        };
        self.position += 1;
        match char::from_u32(u32::from(unit)) {
            Some(
                '^' | '$' | '\\' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
                | '/' | '-',
            ) => Ok(unit),
            _ => self.fail("only escaped punctuation is supported"),
        }
    }

    fn atom(&mut self) -> Result<Atom, PatternError> {
        let Some(unit) = self.peek() else {
            return self.fail("a pattern ends where an atom is expected");
        };
        self.position += 1;
        match char::from_u32(u32::from(unit)) {
            Some('.') => Ok(Atom::AnyUnit),
            Some('^') => Ok(Atom::Start),
            Some('$') => Ok(Atom::End),
            Some('\\') => self.escaped().map(Atom::Unit),
            Some('(') => {
                if self.eat('?') && !self.eat(':') {
                    return self.fail("only the (?: group form is supported");
                }
                let alternatives = self.alternatives(true)?;
                self.position += 1;
                Ok(Atom::Group(alternatives))
            }
            Some('[') => self.class(),
            Some('*' | '+' | '?' | '{' | '}' | ']') => {
                self.fail("a quantifier or bracket has nothing to apply to")
            }
            Some(_) => Ok(Atom::Unit(unit)),
            None => self.fail("characters outside the Basic Multilingual Plane are not supported"),
        }
    }

    fn class_unit(&mut self) -> Result<u16, PatternError> {
        let Some(unit) = self.peek() else {
            return self.fail("a class is not closed");
        };
        self.position += 1;
        if unit == '\\' as u16 {
            return self.escaped();
        }
        if (0xD800..=0xDFFF).contains(&unit) {
            return self.fail("characters outside the Basic Multilingual Plane are not supported");
        }
        Ok(unit)
    }

    fn class(&mut self) -> Result<Atom, PatternError> {
        let negated = self.eat('^');
        let mut ranges = Vec::new();
        loop {
            match self.peek() {
                None => return self.fail("a class is not closed"),
                Some(unit) if unit == ']' as u16 => {
                    self.position += 1;
                    break;
                }
                Some(_) => {}
            }
            let from = self.class_unit()?;
            let is_range = self.peek() == Some('-' as u16)
                && self
                    .units
                    .get(self.position + 1)
                    .is_some_and(|next| *next != ']' as u16);
            if is_range {
                self.position += 1;
                let to = self.class_unit()?;
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

impl Pattern {
    /// Compiles `pattern`, or says which part of it is outside the supported subset.
    pub fn new(pattern: &str) -> Result<Pattern, PatternError> {
        let mut parser = Parser {
            pattern,
            units: pattern.encode_utf16().collect(),
            position: 0,
        };
        let alternatives = parser.alternatives(false)?;
        if parser.position != parser.units.len() {
            return parser.fail("an unmatched closing parenthesis");
        }
        Ok(Pattern { alternatives })
    }

    /// Whether the pattern matches anywhere in `text`, as `new RegExp(pattern).test(text)` does.
    pub fn is_match(&self, text: &str) -> bool {
        let input: Vec<u16> = text.encode_utf16().collect();
        let matcher = Matcher { input: &input };
        (0..=input.len()).any(|start| matcher.alternatives(&self.alternatives, start, &|_| true))
    }
}

struct Matcher<'a> {
    input: &'a [u16],
}

impl Matcher<'_> {
    fn alternatives(
        &self,
        alternatives: &[Vec<Item>],
        at: usize,
        then: &dyn Fn(usize) -> bool,
    ) -> bool {
        alternatives
            .iter()
            .any(|sequence| self.sequence(sequence, at, then))
    }

    fn sequence(&self, items: &[Item], at: usize, then: &dyn Fn(usize) -> bool) -> bool {
        match items.split_first() {
            None => then(at),
            Some((item, rest)) => self.repeat(item, 0, at, &|next| self.sequence(rest, next, then)),
        }
    }

    fn repeat(&self, item: &Item, count: usize, at: usize, then: &dyn Fn(usize) -> bool) -> bool {
        if item.max.is_none_or(|max| count < max) {
            let advanced = self.atom(&item.atom, at, &|next| {
                // An iteration that consumed nothing cannot lead anywhere new once the minimum is met.
                (next != at || count < item.min) && self.repeat(item, count + 1, next, then)
            });
            if advanced {
                return true;
            }
        }
        count >= item.min && then(at)
    }

    fn atom(&self, atom: &Atom, at: usize, then: &dyn Fn(usize) -> bool) -> bool {
        let unit = self.input.get(at).copied();
        match atom {
            Atom::Unit(expected) => unit == Some(*expected) && then(at + 1),
            Atom::AnyUnit => {
                unit.is_some_and(|unit| !matches!(unit, 0x0A | 0x0D | 0x2028 | 0x2029))
                    && then(at + 1)
            }
            Atom::Class { negated, ranges } => {
                unit.is_some_and(|unit| {
                    ranges
                        .iter()
                        .any(|(from, to)| (*from..=*to).contains(&unit))
                        != *negated
                }) && then(at + 1)
            }
            Atom::Group(alternatives) => self.alternatives(alternatives, at, then),
            Atom::Start => at == 0 && then(at),
            Atom::End => at == self.input.len() && then(at),
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
    fn dot_stops_at_a_line_terminator_and_counts_code_units() {
        assert!(!matches("^.$", "\n"));
        assert!(!matches("^.$", "\u{2028}"));
        assert!(matches("^..$", "\u{1F600}"));
        assert!(!matches("^.$", "\u{1F600}"));
    }

    #[test]
    fn unsupported_syntax_is_refused() {
        for source in [
            "a{2}",
            "a*?",
            r"\d",
            "(?=a)",
            "(a",
            "a)",
            "[",
            "[]",
            "\u{1F600}",
            "[z-a]",
            "*",
            "^*",
        ] {
            assert!(Pattern::new(source).is_err(), "{source} must be refused");
        }
    }

    #[test]
    fn nested_empty_loops_terminate() {
        assert!(matches("^(?:a*)*$", "aaa"));
        assert!(!matches("^(?:a*)*b$", "aaa"));
    }
}
