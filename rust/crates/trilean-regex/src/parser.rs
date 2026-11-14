//! A recursive-descent parser for the grammar over UTF-16 code units.
//!
//! A character's meaning (metacharacter, literal, escape) is decided in the context that reads it: at the start of an atom, inside a class, right after a backslash. There is no token stream and no separate lexer pass. Nothing backtracks except the two lookaheads over a braced quantifier, and both leave the cursor where they found it.

use crate::ast::{CharClassNode, CharRange, RegexNode};
use crate::error::RegexParseError;
use crate::matcher::{MAX_STATES, states_of};
use crate::shorthand::{
    ShorthandClassLetter, class_member_ranges, ecmascript_member_ranges, expand_shorthand_class,
    normalise,
};

/// How deeply groups may nest. A deeper pattern is a parse error rather than a stack overflow, which would be a trap in the wasm build and an abort natively. The parser, the compiler and the destructor of the tree each recurse once per level.
pub const MAX_NESTING_DEPTH: usize = 128;

/// A construct whose meaning here differs from its meaning in an unflagged ECMAScript `RegExp`, found while parsing, so that `compile_ecmascript_subset` can name where it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Hazard {
    pub index: usize,
    pub construct: &'static str,
}

const BACKSLASH: u16 = b'\\' as u16;
const OPEN_BRACE: u16 = b'{' as u16;
const CLOSE_BRACE: u16 = b'}' as u16;
const CLOSE_BRACKET: u16 = b']' as u16;
const COMMA: u16 = b',' as u16;
const HYPHEN: u16 = b'-' as u16;

/// The character an escape stands for, for every escape other than the shorthand classes.
fn simple_escape(unit: u16) -> Option<u16> {
    let byte = u8::try_from(unit).ok()?;
    Some(u16::from(match byte {
        b'.' | b'*' | b'+' | b'?' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'|' | b'^'
        | b'$' | b'\\' | b'/' => byte,
        b'n' => b'\n',
        b't' => b'\t',
        b'r' => b'\r',
        b'f' => 0x0C,
        b'v' => 0x0B,
        _ => return None,
    }))
}

/// A message built from text and code units, since a reason may quote a code unit that is half of a pair.
#[derive(Default)]
struct Reason(Vec<u16>);

impl Reason {
    fn text(mut self, text: &str) -> Self {
        self.0.extend(text.encode_utf16());
        self
    }

    fn unit(mut self, unit: u16) -> Self {
        self.0.push(unit);
        self
    }

    fn units(mut self, units: &[u16]) -> Self {
        self.0.extend_from_slice(units);
        self
    }
}

impl From<&str> for Reason {
    fn from(text: &str) -> Self {
        Reason::default().text(text)
    }
}

/// One item of a class in source order, a range written `a-z` counting as the three items `a`, `-` and `z`, which is how ECMAScript reads a class before it decides what is a range.
struct ClassAtom {
    index: usize,
    kind: AtomKind,
}

enum AtomKind {
    Literal(u16),
    Shorthand(ShorthandClassLetter),
}

impl ClassAtom {
    fn literal(index: usize, unit: u16) -> Self {
        Self {
            index,
            kind: AtomKind::Literal(unit),
        }
    }

    fn is_hyphen(&self) -> bool {
        matches!(self.kind, AtomKind::Literal(HYPHEN))
    }

    fn ecmascript_ranges(&self) -> Vec<CharRange> {
        match self.kind {
            AtomKind::Literal(unit) => vec![CharRange {
                from: unit,
                to: unit,
            }],
            AtomKind::Shorthand(letter) => ecmascript_member_ranges(letter),
        }
    }
}

/// The code units an unflagged ECMAScript `RegExp` reads the same class source as, or `None` when it refuses the class. It reads an item, and when a hyphen and a further item follow, a range from one to the other, except that a range with a shorthand class at either end is no range: it is the two ends and the hyphen, each as itself (Annex B of the specification). A range whose end is below its start is a syntax error there.
fn ecmascript_class_ranges(atoms: &[ClassAtom]) -> Option<Vec<CharRange>> {
    let mut ranges = Vec::new();
    let mut at = 0;
    while at < atoms.len() {
        let first = &atoms[at];
        let chained = atoms.get(at + 1).is_some_and(ClassAtom::is_hyphen) && at + 2 < atoms.len();
        if !chained {
            ranges.extend(first.ecmascript_ranges());
            at += 1;
            continue;
        }
        let (hyphen, last) = (&atoms[at + 1], &atoms[at + 2]);
        match (&first.kind, &last.kind) {
            (AtomKind::Literal(from), AtomKind::Literal(to)) if from <= to => {
                ranges.push(CharRange {
                    from: *from,
                    to: *to,
                });
            }
            (AtomKind::Literal(_), AtomKind::Literal(_)) => return None,
            _ => {
                ranges.extend(first.ecmascript_ranges());
                ranges.extend(hyphen.ecmascript_ranges());
                ranges.extend(last.ecmascript_ranges());
            }
        }
        at += 3;
    }
    Some(ranges)
}

/// Whether the class means something else in ECMAScript: the set of code units it holds here differs from the set the same source holds there. The set is compared, not the spelling, so `[\s\S]` is the same in both, and `[\S \t\n\r\f\v]` is not, though neither is judged by which shorthand it contains. The hazard names the construct that causes the difference: a `\s` or `\S`, else a shorthand class chained to a range by a hyphen, else the class.
fn class_hazard(start: usize, ranges: &[CharRange], atoms: &[ClassAtom]) -> Option<Hazard> {
    if ecmascript_class_ranges(atoms).is_some_and(|there| normalise(ranges) == normalise(&there)) {
        return None;
    }
    let space = atoms.iter().find_map(|atom| match atom.kind {
        AtomKind::Shorthand(letter) => space_construct(letter).map(|construct| Hazard {
            index: atom.index,
            construct,
        }),
        AtomKind::Literal(_) => None,
    });
    let chained = || {
        atoms
            .windows(3)
            .find_map(|window| match (&window[0].kind, &window[1]) {
                (AtomKind::Shorthand(_), hyphen) if hyphen.is_hyphen() => Some(Hazard {
                    index: hyphen.index,
                    construct: "-",
                }),
                _ => None,
            })
    };
    Some(space.or_else(chained).unwrap_or(Hazard {
        index: start,
        construct: "[",
    }))
}

enum Quantifier {
    Star,
    Plus,
    Optional,
    Repeat { min: u32, max: Option<u32> },
}

/// The shape `{min}`, `{min,}` or `{min,max}` at a position: where the digits are and where it ends.
struct BoundShape {
    min_digits: (usize, usize),
    comma: bool,
    max_digits: (usize, usize),
    end: usize,
}

struct Parser<'a> {
    pattern: &'a [u16],
    pos: usize,
    depth: usize,
    hazards: Vec<Hazard>,
}

type ParseResult<T> = Result<T, RegexParseError>;

fn is_terminator(unit: u16) -> bool {
    unit == u16::from(b'|') || unit == u16::from(b')')
}

fn is_digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

impl<'a> Parser<'a> {
    fn new(pattern: &'a [u16]) -> Self {
        Self {
            pattern,
            pos: 0,
            depth: 0,
            hazards: Vec::new(),
        }
    }

    fn fail<T>(&self, index: usize, reason: impl Into<Reason>) -> ParseResult<T> {
        Err(RegexParseError::new(self.pattern, index, reason.into().0))
    }

    fn at_end(&self) -> bool {
        self.pos >= self.pattern.len()
    }

    fn peek(&self) -> Option<u16> {
        self.peek_at(0)
    }

    fn peek_at(&self, offset: usize) -> Option<u16> {
        self.pattern.get(self.pos + offset).copied()
    }

    fn peek_is(&self, offset: usize, character: u8) -> bool {
        self.peek_at(offset) == Some(u16::from(character))
    }

    fn advance(&mut self) -> ParseResult<u16> {
        match self.peek() {
            Some(unit) => {
                self.pos += 1;
                Ok(unit)
            }
            None => self.fail(self.pos, "unexpected end of pattern"),
        }
    }

    fn parse_alternation(&mut self) -> ParseResult<RegexNode> {
        let mut branches = vec![self.parse_sequence()?];
        while self.peek_is(0, b'|') {
            self.pos += 1;
            branches.push(self.parse_sequence()?);
        }
        Ok(if branches.len() == 1 {
            branches.remove(0)
        } else {
            RegexNode::Alternation(branches)
        })
    }

    fn too_many_states() -> Reason {
        Reason::default().text(&format!(
            "the pattern needs more than {MAX_STATES} automaton states, a repetition count multiplying what it repeats"
        ))
    }

    fn at_sequence_end(&self) -> bool {
        self.peek().is_none_or(is_terminator)
    }

    fn parse_sequence(&mut self) -> ParseResult<RegexNode> {
        if self.at_sequence_end() {
            return Ok(RegexNode::Concat(Vec::new()));
        }
        let mut operands = vec![self.parse_quantified()?];
        while !self.at_sequence_end() {
            operands.push(self.parse_quantified()?);
        }
        Ok(if operands.len() == 1 {
            operands.remove(0)
        } else {
            RegexNode::Concat(operands)
        })
    }

    fn parse_quantified(&mut self) -> ParseResult<RegexNode> {
        let atom_start = self.pos;
        let atom = self.parse_atom()?;
        if matches!(atom, RegexNode::AnchorStart | RegexNode::AnchorEnd) {
            if self.peek_is_quantifier_start()? {
                let anchor = if atom == RegexNode::AnchorStart {
                    "^"
                } else {
                    "$"
                };
                return self.fail(
                    atom_start,
                    Reason::default()
                        .text("an anchor ('")
                        .text(anchor)
                        .text("') cannot be quantified"),
                );
            }
            return Ok(atom);
        }
        let quantifier_start = self.pos;
        let Some(quantifier) = self.try_parse_quantifier()? else {
            return Ok(atom);
        };
        if self.peek_is_quantifier_start()? {
            return self.fail(
                self.pos,
                "a quantifier cannot itself be quantified: this grammar has no lazy or possessive modifiers, since a pattern that only ever answers a yes/no match question has no notion for either to change",
            );
        }
        let operand = Box::new(atom);
        let repeated = match quantifier {
            Quantifier::Star => RegexNode::Star(operand),
            Quantifier::Plus => RegexNode::Plus(operand),
            Quantifier::Optional => RegexNode::Optional(operand),
            Quantifier::Repeat { min, max } => RegexNode::Repeat { operand, min, max },
        };
        // A count multiplies the states of what it repeats, so it is checked here, where the tree is still small, and not when the automaton is built.
        if states_of(&repeated) >= MAX_STATES as u64 {
            return self.fail(quantifier_start, Self::too_many_states());
        }
        Ok(repeated)
    }

    /// A pure lookahead: whether a second quantifier immediately follows the one just applied, which is always a parse error. It leaves the cursor where it was, and a backwards bound is still an error.
    fn peek_is_quantifier_start(&mut self) -> ParseResult<bool> {
        match self.peek() {
            Some(unit) if u8::try_from(unit).is_ok_and(|byte| b"*+?".contains(&byte)) => Ok(true),
            Some(OPEN_BRACE) => {
                let saved = self.pos;
                let bound = self.try_parse_bound();
                self.pos = saved;
                Ok(bound?.is_some())
            }
            _ => Ok(false),
        }
    }

    fn try_parse_quantifier(&mut self) -> ParseResult<Option<Quantifier>> {
        for (character, quantifier) in [
            (b'*', Quantifier::Star),
            (b'+', Quantifier::Plus),
            (b'?', Quantifier::Optional),
        ] {
            if self.peek_is(0, character) {
                self.pos += 1;
                return Ok(Some(quantifier));
            }
        }
        if self.peek() == Some(OPEN_BRACE) {
            return Ok(self
                .try_parse_bound()?
                .map(|(min, max)| Quantifier::Repeat { min, max }));
        }
        Ok(None)
    }

    fn digits_from(&self, from: usize) -> usize {
        let mut end = from;
        while self.pattern.get(end).copied().is_some_and(is_digit) {
            end += 1;
        }
        end
    }

    /// The shape of a braced quantifier at the cursor, which must be at a `{`. Nothing is consumed, and a `{` that is not exactly one of the three shapes (`{}`, `{,5}`, a `{` with no closing brace) has none.
    fn bound_shape(&self) -> Option<BoundShape> {
        let min_start = self.pos + 1;
        let min_end = self.digits_from(min_start);
        if min_end == min_start {
            return None;
        }
        let mut end = min_end;
        let comma = self.pattern.get(end).copied() == Some(COMMA);
        let mut max_digits = (end, end);
        if comma {
            end += 1;
            let max_end = self.digits_from(end);
            max_digits = (end, max_end);
            end = max_end;
        }
        (self.pattern.get(end).copied() == Some(CLOSE_BRACE)).then_some(BoundShape {
            min_digits: (min_start, min_end),
            comma,
            max_digits,
            end: end + 1,
        })
    }

    fn number(&self, (from, to): (usize, usize), at: usize) -> ParseResult<u32> {
        let mut value: u32 = 0;
        for unit in &self.pattern[from..to] {
            let digit = u32::from(*unit - u16::from(b'0'));
            value = match value.checked_mul(10).and_then(|v| v.checked_add(digit)) {
                Some(value) => value,
                None => {
                    return self.fail(at, "quantifier bound is too large for a repetition count");
                }
            };
        }
        Ok(value)
    }

    /// Parses `{min}`, `{min,}` or `{min,max}` at the cursor, or returns `None` and consumes nothing for anything that is not exactly one of those, so that such a `{` is read as a literal character.
    ///
    /// A backwards bound (`{5,2}`) is an error rather than a fall back to a literal: the syntax is unmistakably a quantifier.
    fn try_parse_bound(&mut self) -> ParseResult<Option<(u32, Option<u32>)>> {
        let saved = self.pos;
        let Some(shape) = self.bound_shape() else {
            return Ok(None);
        };
        let min = self.number(shape.min_digits, saved)?;
        let max = if !shape.comma {
            Some(min)
        } else if shape.max_digits.0 == shape.max_digits.1 {
            None
        } else {
            Some(self.number(shape.max_digits, saved)?)
        };
        if let Some(max) = max
            && max < min
        {
            let digits = |(from, to): (usize, usize)| &self.pattern[from..to];
            let reason = Reason::default()
                .text("quantifier range is backwards: {")
                .units(digits(shape.min_digits));
            let reason = if shape.comma {
                reason.text(",").units(digits(shape.max_digits))
            } else {
                reason
            };
            return self.fail(
                saved,
                reason.text(&format!(
                    "}} would require between {min} and {max} repetitions"
                )),
            );
        }
        self.pos = shape.end;
        Ok(Some((min, max)))
    }

    fn parse_atom(&mut self) -> ParseResult<RegexNode> {
        let start = self.pos;
        let unit = self.advance()?;
        match u8::try_from(unit).ok() {
            Some(b'^') => Ok(RegexNode::AnchorStart),
            Some(b'$') => Ok(RegexNode::AnchorEnd),
            Some(b'.') => {
                self.hazards.push(Hazard {
                    index: start,
                    construct: ".",
                });
                Ok(RegexNode::AnyChar)
            }
            Some(b'(') => {
                self.pos = start;
                self.parse_group()
            }
            Some(b'[') => {
                self.pos = start;
                self.parse_char_class()
            }
            Some(b'\\') => {
                self.pos = start;
                self.parse_escaped_atom()
            }
            Some(quantifier @ (b'*' | b'+' | b'?')) => self.fail(
                start,
                Reason::default()
                    .text("quantifier '")
                    .unit(u16::from(quantifier))
                    .text("' with nothing to repeat"),
            ),
            _ => {
                if unit == OPEN_BRACE {
                    self.pos = start;
                    if self.bound_shape().is_some() {
                        // ECMAScript reads a braced quantifier with nothing before it as a syntax error, where this grammar reads the brace as a literal.
                        self.hazards.push(Hazard {
                            index: start,
                            construct: "{",
                        });
                    }
                    self.pos = start + 1;
                }
                Ok(RegexNode::Literal { code_unit: unit })
            }
        }
    }

    fn parse_group(&mut self) -> ParseResult<RegexNode> {
        let start = self.pos;
        // '('
        self.advance()?;
        if self.peek_is(0, b'?') && self.peek_is(1, b':') {
            self.pos += 2;
        } else {
            return self.fail(
                start,
                "capturing groups are not supported in this grammar: there is nothing to capture, since a pattern only ever answers whether it matches. Use '(?:...)' for grouping.",
            );
        }
        if self.depth >= MAX_NESTING_DEPTH {
            return self.fail(start, "groups are nested too deeply");
        }
        self.depth += 1;
        let inner = self.parse_alternation()?;
        self.depth -= 1;
        if !self.peek_is(0, b')') {
            return self.fail(self.pos, "expected ')' to close '(?:'");
        }
        self.pos += 1;
        Ok(inner)
    }

    /// Reads the escape after a backslash that the cursor is on: the backslash's position and the unit after.
    fn read_escape(&mut self) -> ParseResult<(usize, u16)> {
        let backslash = self.pos;
        self.pos += 1;
        if self.at_end() {
            return self.fail(backslash, "trailing backslash with nothing to escape");
        }
        Ok((backslash, self.advance()?))
    }

    fn unknown_escape<T>(&self, backslash: usize, unit: u16) -> ParseResult<T> {
        self.fail(
            backslash,
            Reason::default()
                .text("unknown escape sequence '\\")
                .unit(unit)
                .text("'"),
        )
    }

    fn parse_escaped_atom(&mut self) -> ParseResult<RegexNode> {
        let (backslash, unit) = self.read_escape()?;
        if let Some(letter) = ShorthandClassLetter::from_unit(unit) {
            self.note_space_shorthand(backslash, letter);
            return Ok(RegexNode::CharClass(expand_shorthand_class(letter)));
        }
        match simple_escape(unit) {
            Some(code_unit) => Ok(RegexNode::Literal { code_unit }),
            None => self.unknown_escape(backslash, unit),
        }
    }

    /// A `\s` or `\S` outside a class means something else in ECMAScript. Inside a class the decision waits for the whole class (see `parse_char_class`).
    fn note_space_shorthand(&mut self, index: usize, letter: ShorthandClassLetter) {
        if let Some(construct) = space_construct(letter) {
            self.hazards.push(Hazard { index, construct });
        }
    }

    fn parse_char_class(&mut self) -> ParseResult<RegexNode> {
        let start = self.pos;
        // '['
        self.advance()?;
        let negated = self.peek_is(0, b'^');
        if negated {
            self.pos += 1;
        }
        let mut ranges: Vec<CharRange> = Vec::new();
        let mut atoms: Vec<ClassAtom> = Vec::new();
        loop {
            if self.at_end() {
                return self.fail(start, "unterminated character class: missing closing ']'");
            }
            if self.peek() == Some(CLOSE_BRACKET) {
                if ranges.is_empty() {
                    return self.fail(
                        self.pos,
                        "a character class must contain at least one item: ']' immediately, or immediately after '[^', is not the empty class here (escape it as '\\]' to match a literal ']')",
                    );
                }
                self.pos += 1;
                break;
            }
            ranges.extend(self.parse_class_item(&mut atoms)?);
        }
        if let Some(hazard) = class_hazard(start, &ranges, &atoms) {
            self.hazards.push(hazard);
        }
        Ok(RegexNode::CharClass(CharClassNode { negated, ranges }))
    }

    fn parse_class_item(&mut self, atoms: &mut Vec<ClassAtom>) -> ParseResult<Vec<CharRange>> {
        if self.peek() == Some(BACKSLASH) {
            let (backslash, escaped) = self.read_escape()?;
            if let Some(letter) = ShorthandClassLetter::from_unit(escaped) {
                atoms.push(ClassAtom {
                    index: backslash,
                    kind: AtomKind::Shorthand(letter),
                });
                return Ok(class_member_ranges(letter));
            }
            return match simple_escape(escaped) {
                Some(code_unit) => {
                    atoms.push(ClassAtom::literal(backslash, code_unit));
                    self.parse_optional_range_from(code_unit, atoms)
                }
                None => self.unknown_escape(backslash, escaped),
            };
        }
        let index = self.pos;
        let unit = self.advance()?;
        atoms.push(ClassAtom::literal(index, unit));
        self.parse_optional_range_from(unit, atoms)
    }

    fn parse_optional_range_from(
        &mut self,
        from: u16,
        atoms: &mut Vec<ClassAtom>,
    ) -> ParseResult<Vec<CharRange>> {
        let has_endpoint = self.peek() == Some(HYPHEN)
            && self.peek_at(1).is_some_and(|unit| unit != CLOSE_BRACKET);
        if !has_endpoint {
            return Ok(vec![CharRange { from, to: from }]);
        }
        let hyphen = self.pos;
        atoms.push(ClassAtom::literal(hyphen, HYPHEN));
        // '-'
        self.pos += 1;
        let endpoint = self.pos;
        let to = self.parse_class_range_endpoint()?;
        atoms.push(ClassAtom::literal(endpoint, to));
        if to < from {
            return self.fail(
                hyphen,
                Reason::default()
                    .text("invalid range in character class: '")
                    .unit(from)
                    .text("-")
                    .unit(to)
                    .text("' is reversed"),
            );
        }
        Ok(vec![CharRange { from, to }])
    }

    fn parse_class_range_endpoint(&mut self) -> ParseResult<u16> {
        if self.peek() != Some(BACKSLASH) {
            return self.advance();
        }
        let (backslash, escaped) = self.read_escape()?;
        if ShorthandClassLetter::from_unit(escaped).is_some() {
            return self.fail(
                backslash,
                Reason::default()
                    .text("a shorthand class ('\\")
                    .unit(escaped)
                    .text("') cannot be a range endpoint"),
            );
        }
        match simple_escape(escaped) {
            Some(code_unit) => Ok(code_unit),
            None => self.unknown_escape(backslash, escaped),
        }
    }
}

/// How a `\s` or `\S` is reported as a construct that differs from ECMAScript's; the other shorthand letters mean the same in both.
fn space_construct(letter: ShorthandClassLetter) -> Option<&'static str> {
    match letter {
        ShorthandClassLetter::S => Some("\\s"),
        ShorthandClassLetter::UpperS => Some("\\S"),
        _ => None,
    }
}

/// Parses `pattern` completely, with the constructs it holds whose meaning differs from ECMAScript's.
pub(crate) fn parse_with_hazards(
    pattern: &[u16],
) -> Result<(RegexNode, Vec<Hazard>), RegexParseError> {
    let mut parser = Parser::new(pattern);
    let node = parser.parse_alternation()?;
    if !parser.at_end() {
        return parser.fail(
            parser.pos,
            "unexpected character: if this was meant literally, escape it with a backslash",
        );
    }
    if states_of(&node) >= MAX_STATES as u64 {
        return parser.fail(0, Parser::too_many_states());
    }
    Ok((node, parser.hazards))
}

/// Parses a pattern given as UTF-16 code units, which may hold an unpaired surrogate, into its syntax tree.
///
/// Never returns a partial result: a pattern parses completely, with nothing left over, or the error names where parsing could not proceed.
pub fn parse_regex_utf16(pattern: &[u16]) -> Result<RegexNode, RegexParseError> {
    parse_with_hazards(pattern).map(|(node, _)| node)
}

/// Parses a pattern into its syntax tree. Offsets in an error are in UTF-16 code units, as the grammar defines them, so a character outside the Basic Multilingual Plane counts as two.
pub fn parse_regex(pattern: &str) -> Result<RegexNode, RegexParseError> {
    parse_regex_utf16(&pattern.encode_utf16().collect::<Vec<u16>>())
}
