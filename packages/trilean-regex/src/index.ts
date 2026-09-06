export type {
  AlternationNode,
  AnchorEndNode,
  AnchorStartNode,
  AnyCharNode,
  CharClassNode,
  CharRange,
  ConcatNode,
  LiteralNode,
  OptionalNode,
  PlusNode,
  RegexNode,
  RepeatNode,
  StarNode,
} from "./ast";
export { charClassMatches, rangeContains } from "./ast";

export { RegexParseError } from "./errors";

export { parseRegex } from "./parser";

export type { ShorthandClassLetter } from "./shorthand-classes";
export { expandShorthandClass } from "./shorthand-classes";

export type { CompiledPattern } from "./matcher";
export { compilePattern, testPattern } from "./matcher";

export type { CompiledNfa, NfaState } from "./nfa";
export { compileToNfa } from "./nfa";

export { matchesNfa } from "./matcher";
