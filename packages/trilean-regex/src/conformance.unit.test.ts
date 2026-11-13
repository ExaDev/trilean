import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RegexParseError } from "./errors";
import { compilePattern, testPattern } from "./matcher";
import { parseRegex } from "./parser";

/**
 * Runs this package's share of the language-neutral conformance corpus (`conformance/trilean-regex/` at the repository root) against the TypeScript implementation. The format, and the rules a case is matched by, are in `conformance/README.md`; `conformance/case.schema.json` is its schema.
 *
 * Every file is validated before anything runs, and a file that does not match the format fails the run rather than being skipped: a typo in a case would otherwise read as a case that passes.
 */

const CORPUS_DIRECTORY = fileURLToPath(
  new URL("../../../conformance/trilean-regex/", import.meta.url),
);

type RegexParseExpectation =
  | { readonly ast: unknown }
  | { readonly astSubset: unknown }
  | {
      readonly error: {
        readonly index: number | undefined;
        readonly message: string | undefined;
      };
    };

interface CaseBase {
  readonly id: string;
  readonly from: string;
  readonly only: "js" | "native" | undefined;
}

interface RegexParseCase extends CaseBase {
  readonly kind: "regex-parse";
  readonly pattern: string;
  readonly expect: RegexParseExpectation;
}

interface RegexMatchCase extends CaseBase {
  readonly kind: "regex-match";
  readonly pattern: string;
  readonly inputs: readonly {
    readonly input: string;
    readonly matches: boolean;
  }[];
}

interface CorpusFile {
  readonly name: string;
  readonly cases: readonly (RegexParseCase | RegexMatchCase)[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, problem: string): never {
  throw new Error(`${where}: ${problem}`);
}

/** The record at `where`, holding exactly the keys in `required` and `optional` and no others. */
function exactRecord(
  value: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    return fail(where, "expected an object");
  }
  for (const key of required) {
    if (!(key in value)) {
      fail(where, `missing "${key}"`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(where, `unexpected "${key}"`);
    }
  }

  return value;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    return fail(where, `"${key}" must be a string`);
  }

  return value;
}

function nonEmptyStringField(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = stringField(record, key, where);
  if (value === "") {
    return fail(where, `"${key}" must not be empty`);
  }

  return value;
}

function integerField(
  record: Record<string, unknown>,
  key: string,
  where: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fail(where, `"${key}" must be a non-negative integer`);
  }

  return value;
}

function arrayOf(value: unknown, where: string, what: string): unknown[] {
  if (!Array.isArray(value)) {
    return fail(where, `${what} must be an array`);
  }

  return value;
}

function checkRegexNode(value: unknown, where: string): void {
  if (!isRecord(value)) {
    return fail(where, "a regex node must be an object");
  }
  const kind = value.kind;
  switch (kind) {
    case "literal":
      exactRecord(value, where, ["kind", "codeUnit"], []);
      integerField(value, "codeUnit", where);

      return;
    case "anyChar":
    case "anchorStart":
    case "anchorEnd":
      exactRecord(value, where, ["kind"], []);

      return;
    case "charClass": {
      exactRecord(value, where, ["kind", "negated", "ranges"], []);
      if (typeof value.negated !== "boolean") {
        fail(where, '"negated" must be a boolean');
      }
      for (const range of arrayOf(value.ranges, where, '"ranges"')) {
        const record = exactRecord(
          range,
          `${where}.ranges`,
          ["from", "to"],
          [],
        );
        integerField(record, "from", `${where}.ranges`);
        integerField(record, "to", `${where}.ranges`);
      }

      return;
    }
    case "concat":
    case "alternation": {
      const key = kind === "concat" ? "operands" : "branches";
      exactRecord(value, where, ["kind", key], []);
      for (const child of arrayOf(value[key], where, `"${key}"`)) {
        checkRegexNode(child, `${where}.${key}`);
      }

      return;
    }
    case "star":
    case "plus":
    case "optional":
      exactRecord(value, where, ["kind", "operand"], []);
      checkRegexNode(value.operand, `${where}.operand`);

      return;
    case "repeat":
      exactRecord(value, where, ["kind", "operand", "min"], ["max"]);
      checkRegexNode(value.operand, `${where}.operand`);
      integerField(value, "min", where);
      if ("max" in value) {
        integerField(value, "max", where);
      }

      return;
    default:
      return fail(where, `unknown regex node kind ${JSON.stringify(kind)}`);
  }
}

function parseExpectation(
  value: unknown,
  where: string,
): RegexParseExpectation {
  if (!isRecord(value)) {
    return fail(where, '"expect" must be an object');
  }
  if ("ast" in value) {
    exactRecord(value, where, ["ast"], []);
    checkRegexNode(value.ast, `${where}.ast`);

    return { ast: value.ast };
  }
  if ("astSubset" in value) {
    exactRecord(value, where, ["astSubset"], []);

    return { astSubset: value.astSubset };
  }
  const outer = exactRecord(value, where, ["error"], []);
  const error = exactRecord(
    outer.error,
    `${where}.error`,
    [],
    ["index", "message"],
  );

  return {
    error: {
      index: "index" in error ? integerField(error, "index", where) : undefined,
      message:
        "message" in error
          ? nonEmptyStringField(error, "message", where)
          : undefined,
    },
  };
}

function parseCase(
  value: unknown,
  where: string,
): RegexParseCase | RegexMatchCase {
  if (!isRecord(value)) {
    return fail(where, "a case must be an object");
  }
  const kind = value.kind;
  const common = ["id", "from", "kind"];
  const optional = ["only", "tolerance"];
  const only = value.only;
  if (only !== undefined && only !== "js" && only !== "native") {
    fail(where, '"only" must be "js" or "native"');
  }
  if (kind === "regex-parse") {
    const record = exactRecord(
      value,
      where,
      [...common, "pattern", "expect"],
      optional,
    );

    return {
      kind,
      id: nonEmptyStringField(record, "id", where),
      from: nonEmptyStringField(record, "from", where),
      only,
      pattern: stringField(record, "pattern", where),
      expect: parseExpectation(record.expect, where),
    };
  }
  if (kind === "regex-match") {
    const record = exactRecord(
      value,
      where,
      [...common, "pattern", "inputs"],
      optional,
    );
    const inputs = arrayOf(record.inputs, where, '"inputs"');
    if (inputs.length === 0) {
      return fail(where, '"inputs" must not be empty');
    }

    return {
      kind,
      id: nonEmptyStringField(record, "id", where),
      from: nonEmptyStringField(record, "from", where),
      only,
      pattern: stringField(record, "pattern", where),
      inputs: inputs.map((entry) => {
        const item = exactRecord(
          entry,
          `${where}.inputs`,
          ["input", "matches"],
          [],
        );
        const matches = item.matches;
        if (typeof matches !== "boolean") {
          return fail(where, '"matches" must be a boolean');
        }

        return { input: stringField(item, "input", where), matches };
      }),
    };
  }

  return fail(where, `unknown case kind ${JSON.stringify(kind)}`);
}

function loadCorpus(): readonly CorpusFile[] {
  const files: CorpusFile[] = [];
  const ids = new Set<string>();
  for (const area of readdirSync(CORPUS_DIRECTORY).sort()) {
    const areaDirectory = join(CORPUS_DIRECTORY, area);
    for (const file of readdirSync(areaDirectory).sort()) {
      const name = `${area}/${file}`;
      const parsed: unknown = JSON.parse(
        readFileSync(join(areaDirectory, file), "utf8"),
      );
      const record = exactRecord(parsed, name, ["cases"], []);
      const cases = arrayOf(record.cases, name, '"cases"').map(
        (entry, position) => {
          const parsedCase = parseCase(
            entry,
            `${name} case ${String(position)}`,
          );
          if (ids.has(parsedCase.id)) {
            fail(name, `duplicate case id ${parsedCase.id}`);
          }
          ids.add(parsedCase.id);

          return parsedCase;
        },
      );
      files.push({ name, cases });
    }
  }

  return files;
}

/** The error `parseRegex` throws for `pattern`; fails the case if it parses. */
function parseFailure(pattern: string): RegexParseError {
  try {
    parseRegex(pattern);
  } catch (error) {
    if (error instanceof RegexParseError) {
      return error;
    }
    throw error;
  }
  throw new Error(
    `${JSON.stringify(pattern)} parsed, but the case expects an error`,
  );
}

/** An object matches when every key `expected` gives matches; an array matches element by element at the same length; any other value must be equal. */
function subsetMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item: unknown, position) =>
        subsetMatches(actual[position], item),
      )
    );
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) =>
        subsetMatches(actual[key], value),
      )
    );
  }

  return Object.is(actual, expected);
}

function runParseCase(testCase: RegexParseCase): void {
  const { expect: expectation } = testCase;
  if ("ast" in expectation) {
    expect(parseRegex(testCase.pattern)).toEqual(expectation.ast);
  } else if ("astSubset" in expectation) {
    expect(
      subsetMatches(parseRegex(testCase.pattern), expectation.astSubset),
    ).toBe(true);
  } else {
    const error = parseFailure(testCase.pattern);
    const { index, message } = expectation.error;
    if (index !== undefined) {
      expect(error.index).toBe(index);
    }
    if (message !== undefined) {
      expect(error.message).toContain(message);
    }
  }
}

function runMatchCase(testCase: RegexMatchCase): void {
  const compiled = compilePattern(testCase.pattern);
  for (const { input, matches } of testCase.inputs) {
    expect(
      compiled.test(input),
      `compiled, input ${JSON.stringify(input)}`,
    ).toBe(matches);
    expect(
      testPattern(testCase.pattern, input),
      `testPattern, input ${JSON.stringify(input)}`,
    ).toBe(matches);
  }
}

for (const file of loadCorpus()) {
  describe(`conformance ${file.name}`, () => {
    for (const testCase of file.cases) {
      it.skipIf(testCase.only === "native")(
        `${testCase.id} (${testCase.from})`,
        () => {
          if (testCase.kind === "regex-parse") {
            runParseCase(testCase);
          } else {
            runMatchCase(testCase);
          }
        },
      );
    }
  });
}
