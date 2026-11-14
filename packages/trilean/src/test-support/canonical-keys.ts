/**
 * The key rule of canonical corpus files, checked on the text of a file because a parsed object has already lost the order of its keys (JavaScript lists integer-like keys first, in numeric order, whatever order the text gave them). In every object the keys are in strictly ascending UTF-16 code-unit order, which for an integer-like key is the order of the strings (`"10"` before `"2"`), and no key holds an unpaired surrogate. A key is compared as the text it stands for, so an escaped spelling is read first.
 *
 * The same scan states two more rules, so that every loader gives one verdict: a document does not begin with a byte order mark, and no array or object is nested deeper than `MAX_DEPTH`. The TypeScript and the Rust JSON parsers would otherwise differ on both (one strips a mark and the other refuses it; their recursion limits differ).
 
`conformance/README.md` states the rules, and each loader implements them over `conformance/fixtures/canonical-keys`.
 *
 * This file is a copy of `packages/trilean-regex/src/test-support/canonical-keys.ts`, kept as a copy because both are deleted with the TypeScript they test; a change here is made in that file too.
 */

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** The deepest nesting a corpus file may have, the same value in every loader. */
export const MAX_DEPTH = 64;

const HEX_DIGITS = 4;
const RADIX = 16;

interface ObjectFrame {
  readonly kind: "object";
  /** Whether the next string is a key of this object. */
  expectKey: boolean;
  /** The previous key of this object, if any. */
  last: string | undefined;
}

type Frame = ObjectFrame | { readonly kind: "array" };

/** The string literal that starts at `start` (a quote), read as the text it stands for, and the index after its closing quote. Unpaired surrogates survive, since `String.fromCharCode` keeps what an escape names. */
function readString(
  text: string,
  start: number,
): { readonly value: string; readonly end: number } {
  let value = "";
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    const character = text[index] ?? "";
    if (character !== "\\") {
      value += character;
      index += 1;
      continue;
    }
    const escape = text[index + 1] ?? "";
    if (escape === "u") {
      const digits = text.slice(index + 2, index + 2 + HEX_DIGITS);
      value += String.fromCharCode(Number.parseInt(digits, RADIX));
      index += 2 + HEX_DIGITS;
    } else {
      value += SIMPLE_ESCAPES[escape] ?? "";
      index += 2;
    }
  }

  return { value, end: index + 1 };
}

/**
 * Everything the key rule finds wrong with the text of a JSON document, in the order found; empty when the keys are canonical. The text must be valid JSON, which every loader checks by parsing it.
 */
export function keyProblems(text: string): readonly string[] {
  const problems: string[] = [];
  if (text.startsWith("\uFEFF")) {
    problems.push("the document begins with a byte order mark");
  }
  const stack: Frame[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const top = stack[stack.length - 1];
    if (character === '"') {
      const { value, end } = readString(text, index);
      index = end;
      if (top?.kind === "object" && top.expectKey) {
        top.expectKey = false;
        if (!value.isWellFormed()) {
          problems.push(
            `the key ${JSON.stringify(value)} holds an unpaired surrogate`,
          );
        }
        if (top.last !== undefined && value <= top.last) {
          problems.push(
            `the key ${JSON.stringify(value)} follows ${JSON.stringify(top.last)}: keys are in ascending UTF-16 code-unit order, without repeats`,
          );
        }
        top.last = value;
      }
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(
        character === "{"
          ? { kind: "object", expectKey: true, last: undefined }
          : { kind: "array" },
      );
      if (stack.length === MAX_DEPTH + 1) {
        problems.push(`nesting is deeper than ${String(MAX_DEPTH)} levels`);
      }
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === "," && top?.kind === "object") {
      top.expectKey = true;
    }
    index += 1;
  }

  return problems;
}
