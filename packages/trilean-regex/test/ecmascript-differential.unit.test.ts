import { describe, expect, it } from "vitest";
import {
  RegexParseError,
  UnsupportedConstructError,
  compileEcmascriptSubset,
} from "../dist/index.js";

/**
 * `compileEcmascriptSubset` accepts a pattern only when every construct in it means the same as in an unflagged ECMAScript `RegExp`. This test holds it to that over the whole grammar: patterns are generated from a fixed seed, the ones the function accepts are kept, and each is run beside `new RegExp(pattern)` over subjects that include every white-space and line-terminator code unit, the surrogates and the characters at the edge of each range. A pattern accepted that the host's engine refuses, or answers differently for any subject, fails the test and names the pattern and the subject.
 *
 * It runs against the built package, so it covers the wasm boundary and the native code at once, in the Node runtime.
 */

const SEED = 20261114;
const PATTERNS = 30000;
const MAX_DEPTH = 3;

const U32 = 4294967296;
const MIX_A = 0x6d2b79f5;
const SHIFT_A = 15;
const SHIFT_B = 7;
const SHIFT_C = 14;
const MIX_B = 61;

/** A small deterministic generator (mulberry32), so a failure reproduces from the seed. */
function generator(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + MIX_A) | 0;
    let mixed = Math.imul(state ^ (state >>> SHIFT_A), 1 | state);
    mixed =
      (mixed + Math.imul(mixed ^ (mixed >>> SHIFT_B), MIX_B | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> SHIFT_C)) >>> 0) / U32;
  };
}

type Random = () => number;

function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) {
    throw new Error("nothing to pick from");
  }

  return item;
}

const chance = (random: Random, probability: number): boolean =>
  random() < probability;

/** Characters that mean themselves in a pattern, white space and line terminators, surrogates and the unusual among them. */
const LITERALS: readonly string[] = [
  "a",
  "b",
  "c",
  "z",
  "0",
  "1",
  "9",
  "_",
  " ",
  "-",
  "]",
  "}",
  "{",
  ",",
  " ",
  " ",
  " ",
  "﻿",
  "　",
  "\u0000",
  "\u007f",
  "é",
  "\ud800",
  "\udc00",
  "😀",
  "\\n",
  "\\t",
  "\\r",
  "\\f",
  "\\v",
  "\\/",
  "\\.",
  "\\*",
  "\\+",
  "\\?",
  "\\(",
  "\\)",
  "\\[",
  "\\]",
  "\\{",
  "\\}",
  "\\|",
  "\\^",
  "\\$",
  "\\\\",
];

const SHORTHANDS: readonly string[] = ["\\d", "\\D", "\\w", "\\W", "\\s", "\\S"];

/** Characters a range may start or end at, in ascending order of code unit within each pair. */
const RANGES: readonly string[] = [
  "a-c",
  "a-z",
  "0-9",
  "A-Z",
  "0-z",
  "\u0000- ",
  "\t-\r",
  " -‏",
  " - ",
  "\u009f-¡",
  "\ud800-\udfff",
  "\u0000-￿",
  "\\n-\\r",
  "--0",
  "!--",
];

function genClass(random: Random): string {
  const items: string[] = [];
  const count = 1 + Math.floor(random() * 5);
  for (let index = 0; index < count; index += 1) {
    const kind = random();
    if (kind < 0.35) {
      items.push(pick(random, SHORTHANDS));
    } else if (kind < 0.55) {
      items.push(pick(random, RANGES));
    } else if (kind < 0.7) {
      items.push("-");
    } else {
      items.push(pick(random, LITERALS.filter((text) => text !== "]")));
    }
  }

  return `[${chance(random, 0.3) ? "^" : ""}${items.join("")}]`;
}

const QUANTIFIERS: readonly string[] = [
  "*",
  "+",
  "?",
  "{0}",
  "{1}",
  "{2}",
  "{0,}",
  "{1,}",
  "{0,1}",
  "{1,3}",
  "{2,2}",
];

function genAtom(random: Random, depth: number): string {
  const kind = random();
  if (kind < 0.25) {
    return pick(random, LITERALS);
  }
  if (kind < 0.4) {
    return pick(random, SHORTHANDS);
  }
  if (kind < 0.6) {
    return genClass(random);
  }
  if (kind < 0.67) {
    return ".";
  }
  if (kind < 0.75) {
    return pick(random, ["^", "$"]);
  }
  if (depth > 0) {
    return `(?:${genAlternation(random, depth - 1)})`;
  }

  return pick(random, LITERALS);
}

function genSequence(random: Random, depth: number): string {
  const length = Math.floor(random() * 4);
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const atom = genAtom(random, depth);
    const quantifiable = atom !== "^" && atom !== "$";
    text += atom;
    if (quantifiable && chance(random, 0.3)) {
      text += pick(random, QUANTIFIERS);
    }
  }

  return text;
}

function genAlternation(random: Random, depth: number): string {
  const branches = chance(random, 0.25) ? 2 + Math.floor(random() * 2) : 1;

  return Array.from({ length: branches }, () =>
    genSequence(random, depth),
  ).join("|");
}

/** Every character ECMAScript reads as white space or a line terminator, the ones either side of each, the surrogates and a few others. */
function subjects(): readonly string[] {
  const spaces = [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x180e, 0x2000,
    0x2001, 0x2005, 0x200a, 0x200b, 0x2027, 0x2028, 0x2029, 0x202a, 0x202f,
    0x205f, 0x2060, 0x3000, 0xfeff, 0xfffe,
  ];
  const others = [
    0x00, 0x01, 0x08, 0x0e, 0x1f, 0x21, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x39,
    0x3a, 0x40, 0x41, 0x5a, 0x5b, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x7a, 0x7b,
    0x7f, 0x9f, 0xe9, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff,
  ];
  const characters = [...spaces, ...others].map((unit) =>
    String.fromCharCode(unit),
  );
  const singles = ["", ...characters, "😀", "a😀b"];
  const framed = characters.map((character) => `a${character}b`);
  const pairs = ["ab", "aa", "a-b", "a b", "a\nb", "\n\n", "  ", "𐀀"];

  return [...singles, ...framed, ...pairs];
}

interface Difference {
  readonly pattern: string;
  readonly detail: string;
}

describe("compileEcmascriptSubset against the host's RegExp", () => {
  it("answers as an unflagged RegExp does for every pattern it accepts", () => {
    const random = generator(SEED);
    const texts = subjects();
    const differences: Difference[] = [];
    let accepted = 0;
    let unsupported = 0;
    for (let count = 0; count < PATTERNS; count += 1) {
      const pattern = genAlternation(random, MAX_DEPTH);
      let compiled;
      try {
        compiled = compileEcmascriptSubset(pattern);
      } catch (error) {
        if (error instanceof UnsupportedConstructError) {
          unsupported += 1;
        } else if (!(error instanceof RegexParseError)) {
          throw error;
        }
        continue;
      }
      accepted += 1;
      let expression: RegExp;
      try {
        expression = new RegExp(pattern);
      } catch (error) {
        differences.push({
          pattern,
          detail: `accepted, and RegExp refuses it: ${String(error)}`,
        });
        continue;
      }
      for (const text of texts) {
        if (compiled.test(text) !== expression.test(text)) {
          differences.push({
            pattern,
            detail: `subject ${JSON.stringify(text)}: the package says ${String(compiled.test(text))}, RegExp says ${String(expression.test(text))}`,
          });
          break;
        }
      }
    }
    expect(differences.slice(0, 5)).toEqual([]);
    // The comparison is not vacuous: patterns were accepted, and the refusals the function exists for were met.
    expect(accepted).toBeGreaterThan(PATTERNS / 10);
    expect(unsupported).toBeGreaterThan(PATTERNS / 100);
  });

  it.each([
    "[\\S \\t\\n\\r\\f\\v]",
    "[^\\S \\t\\n\\r\\f\\v]",
    "[\\d-a-z]",
    "[^\\W-\u0000-9]",
    "[a\\d-b-d]",
    "a.b",
    "x\\sy",
    "[\\s]",
    "{2}",
  ])("refuses %j, which means something else in ECMAScript", (pattern) => {
    expect(() => compileEcmascriptSubset(pattern)).toThrow(
      UnsupportedConstructError,
    );
  });

  it.each(["[\\s\\S]", "[\\S\\s]", "[^\\s\\S]", "[\\d-a]", "[\\S \\s]"])(
    "accepts %j, which means the same",
    (pattern) => {
      const compiled = compileEcmascriptSubset(pattern);
      const expression = new RegExp(pattern);
      for (const text of subjects()) {
        expect(compiled.test(text), JSON.stringify(text)).toBe(
          expression.test(text),
        );
      }
    },
  );
});
