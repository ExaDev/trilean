import { keyProblems } from "./canonical-keys";
import { format } from "./generated-format";

/**
 * The documents that keep the three implementations of the key rule equal (`canonical-keys.ts` in each package, `canonical.rs` in the Rust loader): a fixed number of small JSON documents drawn from a seeded generator, each with the number of problems the rule finds in it. Every loader scans every document and must find that number, so a divergence in an escape, a surrogate, a repeat spelled two ways or an integer-like key shows here whether or not a hand-written fixture covers it.
 *
 * The documents are written with ASCII only and spell every awkward character as an escape, so the text of a document is the same bytes in every language.
 */

const SEED = 0x2f6e2b1;
const DOCUMENTS = 400;
const WORD_BITS = 32;
const MODULUS = 2 ** WORD_BITS;
/** Multiplier and increment of a linear congruential generator over 32 bits (Numerical Recipes), which is all a fixed, reproducible choice needs. */
const MULTIPLIER = 1_664_525;
const INCREMENT = 1_013_904_223;
/** The deepest nesting a generated document gets, well inside the limit of the rule. */
const LEVELS = 3;
/** The most members a generated array or object holds. */
const MOST_MEMBERS = 4;
/** What share of values are scalars, and what share of the rest are arrays. */
const SCALAR_SHARE = 0.3;
const ARRAY_SHARE = 0.4;

/** A small deterministic generator, the same sequence for the same seed in every run. The high bits are used, as the low bits of a congruential generator repeat quickly. */
function generator(seed: number): () => number {
  let state = seed;

  return () => {
    state = (Math.imul(state, MULTIPLIER) + INCREMENT) % MODULUS;

    return (state >>> 0) / MODULUS;
  };
}

/** Spellings of keys: plain, integer-like, escaped alternatives of the same text, controls, quotes, a pair, a lone half of a pair and the characters either side of the surrogate range. */
const KEYS: readonly string[] = [
  "a",
  "b",
  "ab",
  "\\u0061",
  "\\u0062",
  "A",
  "1",
  "2",
  "10",
  "\\u0031\\u0030",
  "\\n",
  "\\t",
  "\\b",
  "\\f",
  "\\r",
  "\\u000a",
  "\\\\",
  '\\"',
  "\\/",
  "/",
  "\\ud83d\\ude00",
  "\\uD83D\\uDE00",
  "\\ud83d",
  "\\ude00",
  "\\ud83da",
  "\\ue000",
  "\\uffff",
  "\\u0000",
];

const SCALARS: readonly string[] = ["1", "true", "null", '"x"', "[]", "{}"];

/** One of the items, chosen by the generator. */
function pick(random: () => number, items: readonly string[]): string {
  const chosen = items[Math.floor(random() * items.length)];
  if (chosen === undefined) {
    throw new Error("nothing to pick from");
  }

  return chosen;
}

/** One value: a scalar, or an array or object with keys drawn from `KEYS`, nested up to `depth` levels. */
function value(random: () => number, depth: number): string {
  const choice = random();
  if (depth === 0 || choice < SCALAR_SHARE) {
    return pick(random, SCALARS);
  }
  const count = 1 + Math.floor(random() * MOST_MEMBERS);
  const members = Array.from({ length: count }, () =>
    choice < ARRAY_SHARE
      ? value(random, depth - 1)
      : `"${pick(random, KEYS)}": ${value(random, depth - 1)}`,
  );

  return choice < ARRAY_SHARE
    ? `[${members.join(", ")}]`
    : `{${members.join(", ")}}`;
}

/** The generated documents, in the form the corpus file holds them. */
export function keyDocuments(): readonly {
  readonly problems: number;
  readonly text: string;
}[] {
  const random = generator(SEED);

  return Array.from({ length: DOCUMENTS }, () => {
    const documentText = value(random, LEVELS);

    return { problems: keyProblems(documentText).length, text: documentText };
  });
}

/** `fixtures/canonical-keys/differential.json`, written the way the lint writes a corpus file. */
export function keyDocumentsFile(): string {
  return `${format({ documents: keyDocuments() }, "")}\n`;
}
