import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { format, isRecord } from "./generated-format";
import { generatedFixtures } from "./generated-fixtures";
import { readmeWithIndex } from "./generated-index";
import { ComputedValueSchema } from "../computed-value";
import {
  hierarchicalGlobPattern,
  prefixPattern,
  wildcardPattern,
} from "../derived-patterns";
import { ExpressionNodeSchema, PredicateNodeSchema } from "../tree";
import type { ExpressionNode } from "../tree";

/**
 * The corpus files that are generated from the TypeScript implementation instead of extracted from a test, written the way the repository's lint writes a corpus file (keys sorted, two-space indent, one element per line) so that regenerating changes no byte of what is committed. `conformance.generated.unit.test.ts` regenerates them into a temporary directory and compares them with the committed files; `scripts/generate-corpus.ts` writes them into `conformance/`. Everything here is deterministic: the inputs are the lists below and the answers are the host's own.
 */

/** An argument as a label: JSON text, with the two line separators a schema's `.` does not match escaped. */
const HEX_RADIX = 16;

function label(value: string): string {
  return JSON.stringify(value).replace(
    /[\u2028\u2029]/gu,
    (separator) => `\\u${separator.charCodeAt(0).toString(HEX_RADIX)}`,
  );
}

/** A corpus text: a JSON string when it is well-formed Unicode, else its code units. */
function text(
  value: string,
): string | { readonly codeUnits: readonly number[] } {
  return value.isWellFormed()
    ? value
    : {
        codeUnits: Array.from({ length: value.length }, (_, index) =>
          value.charCodeAt(index),
        ),
      };
}

/** The pattern each builder gives for a set of arguments: the patterns the derived-pattern cases cover. */
function patternSources(): {
  readonly source: string;
  readonly built: string;
}[] {
  const subject: ExpressionNode = { kind: "reference", key: "subject" };
  const metacharacters = [
    ".",
    "*",
    "+",
    "?",
    "^",
    "$",
    "{",
    "}",
    "(",
    ")",
    "|",
    "[",
    "]",
    "\\",
    "/",
    "-",
  ];
  const prefixes = [
    "",
    "ls",
    "git commit",
    "a.b",
    "run*",
    "a b",
    "a\\b",
    " ",
    "😀",
    ...metacharacters,
  ];
  const wildcards = [
    "",
    "*",
    "**",
    "a*",
    "*a",
    "a*c",
    "git *",
    "git * *",
    " git * ",
    "git*",
    "*.ts",
    "npm run *",
    "\\*",
    "\\**",
    "a\\*b",
    "a\\\\b",
    "a\\",
    "v1.0 (*)",
    "a\nb",
    "😀*",
    ...metacharacters,
  ];
  const globs = [
    "",
    "*",
    "**",
    "***",
    "?",
    "v?",
    "a/*",
    "a/**",
    "**/*.ts",
    "src/**/x",
    "a/***",
    "*/?",
    "docs/readme.md",
    "a\\b",
    "a.b/**/c?",
    "😀/*",
    ...metacharacters,
  ];
  const found: { source: string; built: string }[] = [];
  const add = (built: string, node: unknown): void => {
    if (
      isRecord(node) &&
      isRecord(node.right) &&
      typeof node.right.value === "string"
    ) {
      found.push({ source: node.right.value, built });
    }
  };
  for (const prefix of prefixes)
    add(`prefixPattern ${label(prefix)}`, prefixPattern(subject, prefix));
  for (const pattern of wildcards)
    add(`wildcardPattern ${label(pattern)}`, wildcardPattern(subject, pattern));
  for (const pattern of globs)
    add(
      `hierarchicalGlobPattern ${label(pattern)}`,
      hierarchicalGlobPattern(subject, pattern),
    );

  return found;
}

/** Subjects that exercise the places an ECMAScript pattern and a port can differ: line terminators, the separator, astral characters and unpaired surrogates. */
const SUBJECTS = [
  "",
  "a",
  "ab",
  "abc",
  "a\nb",
  "a\r\nb",
  " ",
  "x y",
  "a/b",
  "a/b/c",
  "/",
  "src/",
  "src/index.ts",
  "docs/readme.md",
  "git",
  "git status",
  "git commit -m message",
  "ls -la",
  "*",
  "a*b",
  "a\\b",
  "\\",
  "😀",
  "a😀b",
  "😀😀",
  "\ud83d",
  "\ude00",
  "a\ud83d",
  "\ude00b",
  "v1",
  "v12",
  "v1.0 (beta)",
  "run*",
  "ls\n",
];

function derivedPatterns(): unknown {
  const seen = new Set<string>();
  const cases: unknown[] = [];
  for (const { source, built } of patternSources()) {
    if (seen.has(source)) {
      continue;
    }
    seen.add(source);
    const expression = new RegExp(source);
    const subjects = [
      ...new Set([...SUBJECTS, source.replace(/^\^|\$$/gu, "")]),
    ];
    cases.push({
      from: `recorded: trilean src/derived-patterns.ts (the pattern ${built} gives, with each result recorded from an unflagged ECMAScript RegExp)`,
      id: `ecmascript.derived-patterns.${String(cases.length + 1)}`,
      inputs: subjects.map((subject) => ({
        input: text(subject),
        matches: expression.test(subject),
      })),
      dialect: "ecmascript",
      kind: "regex-match",
      pattern: text(source),
    });
  }

  return { cases };
}

/** The values `Number.prototype.toString` is recorded for, as text so that each is exactly the double it names: either side of every boundary between its notations, the extremes, the doubles next to a power of two and negative zero. */
const NUMBERS = [
  "0 1 -1 0.1 0.5 1.5 100 123456789 1e-6 1e-7 1.5e-7 123e-20 0.000001 0.0000001",
  "1e20 1e21 1e22 123456789012345680000 999999999999999900000 9007199254740992",
  "9007199254740994 -9007199254740992 9007199254740991 1.7976931348623157e308",
  "-1.7976931348623157e308 5e-324 -5e-324 2.2250738585072014e-308 1e-323 4.35",
  "0.30000000000000004 0.3333333333333333 123.456 1e300 -1e21 -1e-7",
]
  .join(" ")
  .split(" ")
  .map(Number);

function numberFormat(): unknown {
  return {
    cases: [
      -0,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      ...NUMBERS,
    ].map((value, index) => ({
      expect: String(value),
      from: "recorded: trilean src/evaluator-operations.ts (Number.prototype.toString at the boundaries between its notations)",
      id: `number-format.${String(index + 1)}`,
      kind: "number-format",
      value,
    })),
  };
}

/** The same value with the members of every object in the reverse of their order, so the text a case parses is not in the order the type serialises. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => reversed(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reversed(item)]),
    );
  }

  return value;
}

const N1: ExpressionNode = { kind: "numberLiteral", value: 1 };
const EXISTS = { kind: "exists", operand: N1 };
const PREDICATES: readonly unknown[] = [
  { kind: "not", operand: EXISTS },
  { kind: "and", left: EXISTS, right: EXISTS },
  { kind: "or", left: EXISTS, right: EXISTS },
  { kind: "allOf", operands: [EXISTS] },
  { kind: "anyOf", operands: [] },
  {
    kind: "compare",
    op: "gte",
    left: N1,
    right: { kind: "numberLiteral", value: 2, unit: { s: -1, m: 1, kg: 2 } },
  },
  {
    kind: "textCompare",
    op: "portableMatches",
    left: { kind: "textLiteral", value: "a" },
    right: { kind: "textLiteral", value: "^a$" },
  },
  { kind: "memberOf", op: "notIn", operand: N1, candidates: [N1] },
  EXISTS,
  {
    kind: "some",
    collection: { zeta: 1, alpha: [2, { y: 1, x: 2 }] },
    item: EXISTS,
    filter: EXISTS,
  },
  { kind: "every", collection: "items", item: EXISTS },
  { kind: "treeReference", key: "eligibility-rule" },
];
const EXPRESSIONS: readonly unknown[] = [
  { kind: "numberLiteral", value: 1e21, unit: { s: -1, m: 1 } },
  { kind: "numberLiteral", value: -0 },
  { kind: "numberLiteral", value: 1e-7 },
  { kind: "textLiteral", value: "a" },
  { kind: "booleanLiteral", value: false },
  { kind: "instantLiteral", value: "2026-08-30T00:00:00Z" },
  { kind: "durationLiteral", value: 5, unit: "min" },
  { kind: "complexLiteral", re: 1, im: -1, unit: { V: 1, A: -1 } },
  { kind: "complexLiteral", magnitude: 2, phase: 0.5 },
  { kind: "reference", key: "x", unit: { s: 1, m: -1 } },
  { kind: "arithmetic", op: "power", left: N1, right: N1 },
  { kind: "negate", operand: N1 },
  {
    kind: "call",
    fn: "squareRoot",
    args: [N1, { kind: "textLiteral", value: "a" }],
  },
  { kind: "lookup", table: { z: 1, a: { d: 4, b: 2 } }, keys: [N1] },
  {
    kind: "conditional",
    hitPolicy: "unique",
    cases: [{ when: EXISTS, then: N1 }],
    fallback: N1,
  },
  {
    kind: "fold",
    collection: "items",
    filter: EXISTS,
    combiner: { mode: "reduce", initial: N1, combine: { kind: "accumulator" } },
  },
  { kind: "fold", collection: "items", combiner: { mode: "max", item: N1 } },
  { kind: "accumulator" },
  {
    kind: "delegate",
    system: "symbolic-math",
    payload: { z: [{ c: 3 }, { b: 1, a: 2 }], a: null, m: "x" },
  },
  { kind: "treeReference", key: "pricing-formula" },
];
const COMPUTED: readonly unknown[] = [
  { kind: "number", value: 3, unit: { s: -1, m: 1 } },
  { kind: "text", value: "a" },
  { kind: "boolean", value: true },
  { kind: "instant", value: "2026-01-01T00:00:00.000Z" },
  { kind: "duration", value: 5, unit: "min" },
  { kind: "complex", re: 3, im: 4, unit: { V: 1, A: -1 } },
];

/** JSON text for a value, a negative zero written as `-0`, which `JSON.stringify` would write as `0`. */
function jsonText(value: unknown): string {
  if (Object.is(value, -0)) {
    return "-0";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => jsonText(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${jsonText(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function serialise(): unknown {
  const parsers: readonly (readonly [
    string,
    (input: unknown) => unknown,
    readonly unknown[],
  ])[] = [
    [
      "PredicateNodeSchema",
      (input) => PredicateNodeSchema.parse(input),
      PREDICATES,
    ],
    [
      "ExpressionNodeSchema",
      (input) => ExpressionNodeSchema.parse(input),
      EXPRESSIONS,
    ],
    [
      "ComputedValueSchema",
      (input) => ComputedValueSchema.parse(input),
      COMPUTED,
    ],
  ];
  const cases: unknown[] = [];
  for (const [schema, parse, trees] of parsers) {
    for (const tree of trees) {
      const input = jsonText(reversed(tree));
      cases.push({
        expect: JSON.stringify(parse(JSON.parse(input))),
        from: `recorded: trilean src/tree.ts (a ${schema.replace("Schema", "")} written in reverse member order, parsed and serialised again, byte for byte)`,
        id: `serialise.${schema.replace("Schema", "").toLowerCase()}.${String(cases.length + 1)}`,
        input,
        kind: "serialise",
        schema,
      });
    }
  }

  return { cases };
}

/** The generated corpus files, by path relative to the corpus root. */
export const GENERATED_CORPUS_FILES: readonly string[] = [
  "trilean-regex/ecmascript/derived-patterns.json",
  "trilean/number-format/number-format.json",
  "trilean/serialise/serialise.json",
];

/** The generated corpus files by path relative to the corpus root, with their exact text. */
export function generatedCorpus(): ReadonlyMap<string, string> {
  const documents = new Map<string, unknown>([
    ["trilean-regex/ecmascript/derived-patterns.json", derivedPatterns()],
    ["trilean/number-format/number-format.json", numberFormat()],
    ["trilean/serialise/serialise.json", serialise()],
  ]);

  return new Map(
    GENERATED_CORPUS_FILES.map((path) => [
      path,
      `${format(documents.get(path), "")}\n`,
    ]),
  );
}

/** What is derived from the corpus as it stands under `root`: the fixtures that cover every constraint of the schema and the README with its generated index. */
export function generatedDerived(root: string): ReadonlyMap<string, string> {
  return new Map([
    ...generatedFixtures(root),
    ["README.md", readmeWithIndex(root)],
  ]);
}

/** Writes the generated corpus files under `root`, then what is derived from them and the rest of the corpus. */
export function writeGeneratedCorpus(root: string): void {
  rmSync(join(root, "fixtures", "generated"), { recursive: true, force: true });
  for (const [path, content] of generatedCorpus()) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const [path, content] of generatedDerived(root)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
