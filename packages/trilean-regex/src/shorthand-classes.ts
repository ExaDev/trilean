import type { CharClassNode, CharRange } from "./ast";

/** The letter each shorthand class is written with, case distinguishing the positive form (`d`, `w`, `s`) from its negation (`D`, `W`, `S`). */
export type ShorthandClassLetter = "d" | "D" | "w" | "W" | "s" | "S";

function codeOf(char: string): number {
  return char.charCodeAt(0);
}

function range(fromChar: string, toChar: string): CharRange {
  return { from: codeOf(fromChar), to: codeOf(toChar) };
}

function single(char: string): CharRange {
  const codeUnit = codeOf(char);
  return { from: codeUnit, to: codeUnit };
}

/** `\d` -- the ASCII digits `0`-`9`. Fixed, not locale- or engine-dependent: a shorthand's whole purpose here is to expand to the same ranges regardless of which dialect a `trilean-sql` compiler is targeting, so its expansion is a constant this package owns rather than a delegation to the host's own `RegExp` notion of "digit". */
const DIGIT_RANGES: readonly CharRange[] = [range("0", "9")];

/** `\w` -- ASCII letters, digits, and underscore. The ECMAScript definition of "word character" without the `u`/`unicode` flag, which is the one this grammar's non-Unicode-scalar code-unit model corresponds to. */
const WORD_RANGES: readonly CharRange[] = [
  range("A", "Z"),
  range("a", "z"),
  range("0", "9"),
  single("_"),
];

/** `\s` -- the ASCII whitespace characters ECMAScript's `\s` matches outside the `u` flag's extra Unicode space separators: space, tab, newline, carriage return, form feed, vertical tab. */
const SPACE_RANGES: readonly CharRange[] = [
  single(" "),
  single("\t"),
  single("\n"),
  single("\r"),
  single("\f"),
  single("\v"),
];

/** Expands a shorthand class letter (`d`/`D`/`w`/`W`/`s`/`S`) to the `CharClassNode` it stands for. Uppercase negates the corresponding lowercase letter's ranges rather than owning a separate range table, since a shorthand class and its negation are the same set by definition. */
export function expandShorthandClass(
  letter: ShorthandClassLetter,
): CharClassNode {
  switch (letter) {
    case "d":
      return { kind: "charClass", negated: false, ranges: DIGIT_RANGES };
    case "D":
      return { kind: "charClass", negated: true, ranges: DIGIT_RANGES };
    case "w":
      return { kind: "charClass", negated: false, ranges: WORD_RANGES };
    case "W":
      return { kind: "charClass", negated: true, ranges: WORD_RANGES };
    case "s":
      return { kind: "charClass", negated: false, ranges: SPACE_RANGES };
    case "S":
      return { kind: "charClass", negated: true, ranges: SPACE_RANGES };
    default:
      letter satisfies never;
      throw new Error("unreachable shorthand class letter");
  }
}
