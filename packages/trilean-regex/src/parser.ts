import type { CharRange, RegexNode } from "./ast";
import { RegexParseError } from "./errors";
import { expandShorthandClass } from "./shorthand-classes";

/** Characters that end the current alternation branch: the branch separator itself, and the group closer, at whichever level `parseSequence` is currently reading. Encountering either at the top level, with no matching opener, is the caller's job to reject -- `parseSequence` simply stops, leaving it for the enclosing `parseAlternation`/`parseGroup`/top-level `parseRegex` to notice. */
const SEQUENCE_TERMINATORS = new Set(["|", ")"]);

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  ".": ".",
  "*": "*",
  "+": "+",
  "?": "?",
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  "{": "{",
  "}": "}",
  "|": "|",
  "^": "^",
  $: "$",
  "\\": "\\",
  "/": "/",
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
  v: "\v",
};

type QuantifierSpec =
  | { readonly kind: "star" }
  | { readonly kind: "plus" }
  | { readonly kind: "optional" }
  | {
      readonly kind: "repeat";
      readonly min: number;
      readonly max: number | undefined;
    };

/**
 * Recursive-descent parser for the grammar documented in README.md. Each `parse*` method consumes exactly the construct it names and leaves `pos` positioned just past it; nothing here backtracks except the two speculative lookaheads (`tryParseBound`'s failure path, and `peekIsQuantifierStart`'s use of it), both of which restore `pos` themselves before returning.
 *
 * Holds no state beyond the source string and a cursor into it -- there is no token stream, no separate lexer pass. A character's meaning (metachar, literal, escape) is always decided in the context that is reading it (atom position, inside a class, right after a backslash), which is what a hand-written recursive-descent parser buys over a generic lexer/parser split for a grammar this size.
 */
class Parser {
  private readonly pattern: string;
  private pos = 0;

  constructor(pattern: string) {
    this.pattern = pattern;
  }

  get position(): number {
    return this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.pattern.length;
  }

  private peek(offset = 0): string | undefined {
    return this.pattern[this.pos + offset];
  }

  private advance(): string {
    const char = this.pattern[this.pos];
    if (char === undefined) {
      throw new RegexParseError(
        this.pattern,
        this.pos,
        "unexpected end of pattern",
      );
    }
    this.pos += 1;
    return char;
  }

  parseAlternation(): RegexNode {
    const firstBranch = this.parseSequence();
    const laterBranches: RegexNode[] = [];
    while (this.peek() === "|") {
      this.advance();
      laterBranches.push(this.parseSequence());
    }
    return laterBranches.length === 0
      ? firstBranch
      : { kind: "alternation", branches: [firstBranch, ...laterBranches] };
  }

  private parseSequence(): RegexNode {
    if (this.atEnd() || SEQUENCE_TERMINATORS.has(this.peek() ?? "")) {
      return { kind: "concat", operands: [] };
    }
    const firstOperand = this.parseQuantified();
    const laterOperands: RegexNode[] = [];
    while (!this.atEnd() && !SEQUENCE_TERMINATORS.has(this.peek() ?? "")) {
      laterOperands.push(this.parseQuantified());
    }
    return laterOperands.length === 0
      ? firstOperand
      : { kind: "concat", operands: [firstOperand, ...laterOperands] };
  }

  private parseQuantified(): RegexNode {
    const atomStart = this.pos;
    const atom = this.parseAtom();
    if (atom.kind === "anchorStart" || atom.kind === "anchorEnd") {
      if (this.peekIsQuantifierStart()) {
        throw new RegexParseError(
          this.pattern,
          atomStart,
          `an anchor ('${atom.kind === "anchorStart" ? "^" : "$"}') cannot be quantified`,
        );
      }
      return atom;
    }
    const quantifier = this.tryParseQuantifier();
    if (quantifier === undefined) return atom;
    if (this.peekIsQuantifierStart()) {
      throw new RegexParseError(
        this.pattern,
        this.pos,
        "a quantifier cannot itself be quantified -- this grammar has no lazy or possessive modifiers, since a pattern that only ever answers a yes/no match question has no notion for either to change",
      );
    }
    switch (quantifier.kind) {
      case "star":
        return { kind: "star", operand: atom };
      case "plus":
        return { kind: "plus", operand: atom };
      case "optional":
        return { kind: "optional", operand: atom };
      case "repeat":
        return {
          kind: "repeat",
          operand: atom,
          min: quantifier.min,
          max: quantifier.max,
        };
      default:
        quantifier satisfies never;
        throw new Error("unreachable quantifier kind");
    }
  }

  /** A pure lookahead: restores `pos` before returning in every case, including through `tryParseBound`'s own successful parse. Used only to decide whether a second quantifier immediately follows the one just applied, which is always a parse error (see `parseQuantified`). */
  private peekIsQuantifierStart(): boolean {
    const c = this.peek();
    if (c === "*" || c === "+" || c === "?") return true;
    if (c === "{") {
      const savedPos = this.pos;
      const bound = this.tryParseBound();
      this.pos = savedPos;
      return bound !== undefined;
    }
    return false;
  }

  private tryParseQuantifier(): QuantifierSpec | undefined {
    const c = this.peek();
    if (c === "*") {
      this.advance();
      return { kind: "star" };
    }
    if (c === "+") {
      this.advance();
      return { kind: "plus" };
    }
    if (c === "?") {
      this.advance();
      return { kind: "optional" };
    }
    if (c === "{") {
      const bound = this.tryParseBound();
      if (bound === undefined) return undefined;
      return { kind: "repeat", min: bound.min, max: bound.max };
    }
    return undefined;
  }

  /**
   * Attempts `{min}` / `{min,}` / `{min,max}` starting at the current `{`. Rewinds and returns `undefined` for anything that is not exactly one of those three shapes -- including `{}`, `{,5}`, and a `{` with no closing brace at all -- so that an unrecognised `{` falls back to being parsed as a literal character by the caller, matching how a bounded-repetition quantifier is conventionally the only special meaning `{` ever carries.
   *
   * A backwards bound (`{5,2}`) is a real error rather than a fallback-to-literal case: the syntax is unambiguously a quantifier attempt, so this throws instead of returning `undefined` for it.
   */
  private tryParseBound():
    { min: number; max: number | undefined } | undefined {
    const savedPos = this.pos;
    this.pos += 1; // consume '{' speculatively
    const minDigits = this.readDigits();
    if (minDigits === "") {
      this.pos = savedPos;
      return undefined;
    }
    let maxDigits: string | undefined;
    let hasComma = false;
    if (this.peek() === ",") {
      hasComma = true;
      this.pos += 1;
      maxDigits = this.readDigits();
    }
    if (this.peek() !== "}") {
      this.pos = savedPos;
      return undefined;
    }
    this.pos += 1; // consume '}'
    const min = Number.parseInt(minDigits, 10);
    const max = !hasComma
      ? min
      : maxDigits === ""
        ? undefined
        : Number.parseInt(maxDigits ?? "", 10);
    if (max !== undefined && max < min) {
      throw new RegexParseError(
        this.pattern,
        savedPos,
        `quantifier range is backwards: {${minDigits}${hasComma ? "," + (maxDigits ?? "") : ""}} would require between ${String(min)} and ${String(max)} repetitions`,
      );
    }
    return { min, max };
  }

  private readDigits(): string {
    let digits = "";
    for (;;) {
      const c = this.peek();
      if (c === undefined || c < "0" || c > "9") break;
      digits += c;
      this.pos += 1;
    }
    return digits;
  }

  private parseAtom(): RegexNode {
    const c = this.peek();
    if (c === undefined) {
      throw new RegexParseError(
        this.pattern,
        this.pos,
        "unexpected end of pattern",
      );
    }
    if (c === "^") {
      this.advance();
      return { kind: "anchorStart" };
    }
    if (c === "$") {
      this.advance();
      return { kind: "anchorEnd" };
    }
    if (c === ".") {
      this.advance();
      return { kind: "anyChar" };
    }
    if (c === "(") return this.parseGroup();
    if (c === "[") return this.parseCharClass();
    if (c === "\\") return this.parseEscapedAtom();
    if (c === "*" || c === "+" || c === "?") {
      throw new RegexParseError(
        this.pattern,
        this.pos,
        `quantifier '${c}' with nothing to repeat`,
      );
    }
    this.advance();
    return { kind: "literal", codeUnit: c.charCodeAt(0) };
  }

  private parseGroup(): RegexNode {
    const start = this.pos;
    this.advance(); // '('
    if (this.peek() === "?" && this.peek(1) === ":") {
      this.advance();
      this.advance();
    } else {
      throw new RegexParseError(
        this.pattern,
        start,
        "capturing groups are not supported in this grammar -- there is nothing to capture, since a pattern only ever answers whether it matches. Use '(?:...)' for grouping.",
      );
    }
    const inner = this.parseAlternation();
    if (this.peek() !== ")") {
      throw new RegexParseError(
        this.pattern,
        this.pos,
        "expected ')' to close '(?:'",
      );
    }
    this.advance();
    return inner;
  }

  private parseEscapedAtom(): RegexNode {
    const backslashPos = this.pos;
    this.advance(); // '\'
    if (this.atEnd()) {
      throw new RegexParseError(
        this.pattern,
        backslashPos,
        "trailing backslash with nothing to escape",
      );
    }
    const c = this.advance();
    if (
      c === "d" ||
      c === "D" ||
      c === "w" ||
      c === "W" ||
      c === "s" ||
      c === "S"
    ) {
      return expandShorthandClass(c);
    }
    const literal = SIMPLE_ESCAPES[c];
    if (literal !== undefined) {
      return { kind: "literal", codeUnit: literal.charCodeAt(0) };
    }
    throw new RegexParseError(
      this.pattern,
      backslashPos,
      `unknown escape sequence '\\${c}'`,
    );
  }

  private parseCharClass(): RegexNode {
    const start = this.pos;
    this.advance(); // '['
    let negated = false;
    if (this.peek() === "^") {
      this.advance();
      negated = true;
    }
    const ranges: CharRange[] = [];
    for (;;) {
      if (this.atEnd()) {
        throw new RegexParseError(
          this.pattern,
          start,
          "unterminated character class -- missing closing ']'",
        );
      }
      if (this.peek() === "]") {
        if (ranges.length === 0) {
          throw new RegexParseError(
            this.pattern,
            this.pos,
            "a character class must contain at least one item -- ']' immediately, or immediately after '[^', is not the empty class here (escape it as '\\]' to match a literal ']')",
          );
        }
        this.advance();
        break;
      }
      ranges.push(...this.parseClassItem());
    }
    return { kind: "charClass", negated, ranges };
  }

  private parseClassItem(): readonly CharRange[] {
    const c = this.peek();
    if (c === "\\") {
      const backslashPos = this.pos;
      this.advance();
      if (this.atEnd()) {
        throw new RegexParseError(
          this.pattern,
          backslashPos,
          "trailing backslash with nothing to escape",
        );
      }
      const escaped = this.advance();
      if (escaped === "d" || escaped === "w" || escaped === "s") {
        return expandShorthandClass(escaped).ranges;
      }
      if (escaped === "D" || escaped === "W" || escaped === "S") {
        throw new RegexParseError(
          this.pattern,
          backslashPos,
          `the negated shorthand class '\\${escaped}' cannot be embedded inside a character class, because its complement cannot be represented as a set of ranges to union with the class's other members -- use it as its own atom instead of embedding it here`,
        );
      }
      const literal = SIMPLE_ESCAPES[escaped];
      if (literal === undefined) {
        throw new RegexParseError(
          this.pattern,
          backslashPos,
          `unknown escape sequence '\\${escaped}'`,
        );
      }
      return this.parseOptionalRangeFrom(literal.charCodeAt(0));
    }
    if (c === undefined) {
      throw new RegexParseError(
        this.pattern,
        this.pos,
        "unterminated character class -- missing closing ']'",
      );
    }
    this.advance();
    return this.parseOptionalRangeFrom(c.charCodeAt(0));
  }

  private parseOptionalRangeFrom(fromCode: number): readonly CharRange[] {
    if (
      this.peek() === "-" &&
      this.peek(1) !== undefined &&
      this.peek(1) !== "]"
    ) {
      const hyphenPos = this.pos;
      this.advance(); // '-'
      const toCode = this.parseClassRangeEndpoint();
      if (toCode < fromCode) {
        throw new RegexParseError(
          this.pattern,
          hyphenPos,
          `invalid range in character class: '${String.fromCharCode(fromCode)}-${String.fromCharCode(toCode)}' is reversed`,
        );
      }
      return [{ from: fromCode, to: toCode }];
    }
    return [{ from: fromCode, to: fromCode }];
  }

  private parseClassRangeEndpoint(): number {
    const c = this.peek();
    if (c === "\\") {
      const backslashPos = this.pos;
      this.advance();
      if (this.atEnd()) {
        throw new RegexParseError(
          this.pattern,
          backslashPos,
          "trailing backslash with nothing to escape",
        );
      }
      const escaped = this.advance();
      if (
        escaped === "d" ||
        escaped === "D" ||
        escaped === "w" ||
        escaped === "W" ||
        escaped === "s" ||
        escaped === "S"
      ) {
        throw new RegexParseError(
          this.pattern,
          backslashPos,
          `a shorthand class ('\\${escaped}') cannot be a range endpoint`,
        );
      }
      const literal = SIMPLE_ESCAPES[escaped];
      if (literal === undefined) {
        throw new RegexParseError(
          this.pattern,
          backslashPos,
          `unknown escape sequence '\\${escaped}'`,
        );
      }
      return literal.charCodeAt(0);
    }
    if (c === undefined) {
      throw new RegexParseError(
        this.pattern,
        this.pos,
        "unterminated character class -- missing closing ']'",
      );
    }
    this.advance();
    return c.charCodeAt(0);
  }
}

/**
 * Parses a pattern in this package's grammar (see README.md) into a `RegexNode` AST.
 *
 * Never returns a partial result: a pattern either parses completely, with nothing left over, or this throws `RegexParseError` naming exactly where parsing could not proceed.
 *
 * @throws {RegexParseError} if `pattern` is not a complete, valid pattern in this grammar.
 */
export function parseRegex(pattern: string): RegexNode {
  const parser = new Parser(pattern);
  const node = parser.parseAlternation();
  if (!parser.atEnd()) {
    throw new RegexParseError(
      pattern,
      parser.position,
      "unexpected character -- if this was meant literally, escape it with a backslash",
    );
  }
  return node;
}
