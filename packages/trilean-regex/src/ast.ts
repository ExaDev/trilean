/**
 * The abstract syntax this package's parser produces and its matcher and NFA compiler both consume.
 *
 * Every node kind here corresponds to a construct of a true regular language: no node kind exists for anything a finite automaton cannot express (a backreference, a lookaround assertion). That is what "portable" means for this grammar -- the AST is small enough, and restricted enough, that a `trilean-sql` dialect compiler can pattern-match over it directly instead of walking an open-ended ECMAScript pattern and hoping the subset it recognises is really the whole story.
 *
 * A code point is represented as its UTF-16 code unit value (what `String.prototype.charCodeAt` returns), matching non-`u`-flag ECMAScript `RegExp` semantics: a character outside the Basic Multilingual Plane is two code units, each matched independently, rather than one Unicode scalar value. This keeps the grammar's notion of "one character" identical to what `[a-z]`-style ranges and `.` mean in the engine most authors already carry a mental model of.
 */

/** A single literal character, matched by its UTF-16 code unit value. */
export interface LiteralNode {
  readonly kind: "literal";
  readonly codeUnit: number;
}

/** `.` -- matches exactly one character, of any value. Unlike ECMAScript's default mode, this grammar defines it to match a line terminator too: there is no multiline/dotAll mode to make that a meaningful distinction, so one unconditional rule is simpler than a flag nobody can set. */
export interface AnyCharNode {
  readonly kind: "anyChar";
}

/** An inclusive code-unit range within a character class, e.g. `a-z`. A single character `c` is represented as `{ from: c, to: c }`. */
export interface CharRange {
  readonly from: number;
  readonly to: number;
}

/** `[...]` / `[^...]`, and the standalone shorthand classes (`\d`, `\D`, `\w`, `\W`, `\s`, `\S`) once expanded -- see `shorthand-classes.ts` for the fixed range tables each shorthand expands to. `ranges` is the positive set; `negated` flips membership rather than the ranges themselves, so a negated class still reports the positive ranges it was written against (useful for tooling, and what the SQLite `GLOB` compiler in trilean-sql needs to render `[^...]` back out). */
export interface CharClassNode {
  readonly kind: "charClass";
  readonly negated: boolean;
  readonly ranges: readonly CharRange[];
}

/** `^` -- zero-width assertion that the current position is the very start of the input (absolute index 0), regardless of where in the pattern it appears. */
export interface AnchorStartNode {
  readonly kind: "anchorStart";
}

/** `$` -- zero-width assertion that the current position is the very end of the input (index equal to the input's length). */
export interface AnchorEndNode {
  readonly kind: "anchorEnd";
}

/** Sequencing: `operands` matched one after another with no characters skipped in between. An empty `operands` array is the empty pattern, matching the empty string. */
export interface ConcatNode {
  readonly kind: "concat";
  readonly operands: readonly RegexNode[];
}

/** `a|b|c` -- exactly one of `branches` matches. Always at least two branches; a single-branch alternation has no reason to exist and the parser never produces one. */
export interface AlternationNode {
  readonly kind: "alternation";
  readonly branches: readonly RegexNode[];
}

/** `a*` -- zero or more repetitions of `operand`. */
export interface StarNode {
  readonly kind: "star";
  readonly operand: RegexNode;
}

/** `a+` -- one or more repetitions of `operand`. */
export interface PlusNode {
  readonly kind: "plus";
  readonly operand: RegexNode;
}

/** `a?` -- zero or one repetition of `operand`. */
export interface OptionalNode {
  readonly kind: "optional";
  readonly operand: RegexNode;
}

/** `a{min,max}` -- between `min` and `max` repetitions of `operand`, inclusive. `max: undefined` means unbounded (`a{min,}`). `a{n}` parses to `min: n, max: n`. The parser never produces `min > max` (a bounded form with `max < min` is a parse error) and never produces the forms already covered by `StarNode`/`PlusNode`/`OptionalNode` -- those three are their own node kinds precisely so a matcher or compiler can special-case the common shapes without reading repetition bounds at all. */
export interface RepeatNode {
  readonly kind: "repeat";
  readonly operand: RegexNode;
  readonly min: number;
  readonly max: number | undefined;
}

export type RegexNode =
  | LiteralNode
  | AnyCharNode
  | CharClassNode
  | AnchorStartNode
  | AnchorEndNode
  | ConcatNode
  | AlternationNode
  | StarNode
  | PlusNode
  | OptionalNode
  | RepeatNode;

/** Whether `unit` falls inside an inclusive range. */
export function rangeContains(range: CharRange, unit: number): boolean {
  return unit >= range.from && unit <= range.to;
}

/** Whether `unit` is a member of a character class, honouring `negated`. */
export function charClassMatches(node: CharClassNode, unit: number): boolean {
  const inRanges = node.ranges.some((range) => rangeContains(range, unit));
  return node.negated ? !inRanges : inRanges;
}
