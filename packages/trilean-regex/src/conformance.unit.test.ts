import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RegexParseError } from "./errors";
import { compilePattern, testPattern } from "./matcher";
import { parseRegex } from "./parser";
import { selectCorpusFiles } from "./test-support/corpus-files";
import type {
  CorpusFile,
  RegexMatchCase,
  RegexParseCase,
} from "./test-support/corpus-types";
import { validateCorpusFile, validateManifest } from "./test-support/validate";

/**
 * Runs this package's share of the language-neutral conformance corpus (`conformance/` at the repository root) against the TypeScript implementation. The format, the file selection rule and the matching rules are in `conformance/README.md`; `conformance/case.schema.json` is the schema every file is validated against before anything runs.
 *
 * Nothing about the corpus is trusted: a file that does not match the format, an unexpected entry in the tree, a corpus that differs from `conformance/manifest.json` and a case this package cannot execute all fail the run rather than being skipped, since a skipped case reads as a case that passes.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);
const FIXTURES = join(CORPUS_ROOT, "fixtures");

// The length of the run of "a" in the nested-quantifier case the corpus pins and matcher.unit.test.ts bounds in time.
const NESTED_QUANTIFIER_RUN = 30;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where}: expected a list`);
  }

  return value.map((item: unknown) => {
    if (typeof item !== "string") {
      throw new Error(`${where}: expected a list of strings`);
    }

    return item;
  });
}

interface LoadedFile {
  readonly name: string;
  readonly file: CorpusFile;
}

/** Every corpus file under the root, validated; throws listing everything wrong with the tree. */
function loadCorpus(): readonly LoadedFile[] {
  const selection = selectCorpusFiles(CORPUS_ROOT);
  const failures = selection.problems.map(
    (path) => `${path}: not a corpus file and not a recognised root file`,
  );
  const loaded: LoadedFile[] = [];
  const ids = new Set<string>();
  for (const name of selection.selected) {
    const result = validateCorpusFile(readJson(join(CORPUS_ROOT, name)));
    if (!result.ok) {
      failures.push(...result.problems.map((problem) => `${name}: ${problem}`));
      continue;
    }
    for (const { id } of result.value.cases) {
      if (ids.has(id)) {
        failures.push(`${name}: case id ${id} is used by another file`);
      }
      ids.add(id);
    }
    loaded.push({ name, file: result.value });
  }
  if (failures.length > 0) {
    throw new Error(`the corpus is malformed:\n${failures.join("\n")}`);
  }

  return loaded;
}

/** The reason text of a parse error: the part of the message after the index and before the echoed pattern. */
function reasonOf(error: RegexParseError): string {
  const prefix = `invalid pattern at index ${String(error.index)}: `;
  if (!error.message.startsWith(prefix)) {
    throw new Error(`unexpected error message layout: ${error.message}`);
  }
  const lineEnd = error.message.indexOf("\n");

  return error.message.slice(
    prefix.length,
    lineEnd === -1 ? undefined : lineEnd,
  );
}

/** Whether every fragment occurs in `text`, each after the end of the one before. */
function containsInOrder(text: string, fragments: readonly string[]): boolean {
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    if (at === -1) {
      return false;
    }
    from = at + fragment.length;
  }

  return true;
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
      expect(
        containsInOrder(reasonOf(error), message),
        `reason ${JSON.stringify(reasonOf(error))} lacks, in order, ${JSON.stringify(message)}`,
      ).toBe(true);
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

describe("corpus loading", () => {
  it("selects the files the README's rule selects, over the shared fixture tree", () => {
    const expected = readJson(
      join(FIXTURES, "loader-selection", "expected.json"),
    );
    if (!isRecord(expected)) {
      throw new Error("expected.json must be an object");
    }
    const selection = selectCorpusFiles(
      join(FIXTURES, "loader-selection", "tree"),
    );
    expect({
      problems: selection.problems,
      selected: selection.selected,
    }).toEqual({
      problems: stringList(expected.problems, "problems"),
      selected: stringList(expected.selected, "selected"),
    });
  });

  it("finds nothing unexpected in the real corpus", () => {
    expect(selectCorpusFiles(CORPUS_ROOT).problems).toEqual([]);
  });

  const invalidDirectory = join(FIXTURES, "invalid-cases");
  const invalidFiles = readdirSync(invalidDirectory).sort();

  it("has invalid-case fixtures to reject", () => {
    expect(invalidFiles.length).toBeGreaterThan(0);
  });

  for (const file of invalidFiles) {
    it(`rejects the invalid-case fixture ${file}`, () => {
      const result = validateCorpusFile(readJson(join(invalidDirectory, file)));
      expect(result.ok, `${file} must not validate`).toBe(false);
    });
  }

  it("validates the manifest against its schema", () => {
    const result = validateManifest(
      readJson(join(CORPUS_ROOT, "manifest.json")),
    );
    expect(result.ok ? [] : result.problems).toEqual([]);
  });
});

const corpus = loadCorpus();
const counts = { executed: 0, skipped: 0 };

for (const { name, file } of corpus) {
  describe(`conformance ${name}`, () => {
    for (const testCase of file.cases) {
      if (testCase.only === "native") {
        counts.skipped += 1;
      }
      it.skipIf(testCase.only === "native")(
        `${testCase.id} (${testCase.from})`,
        () => {
          counts.executed += 1;
          if (testCase.kind === "regex-parse") {
            runParseCase(testCase);
          } else if (testCase.kind === "regex-match") {
            runMatchCase(testCase);
          } else {
            throw new Error(
              `no executor for the ${testCase.kind} kind in this package`,
            );
          }
        },
      );
    }
  });
}

describe("corpus completeness", () => {
  const manifestResult = validateManifest(
    readJson(join(CORPUS_ROOT, "manifest.json")),
  );
  const manifest = manifestResult.ok ? manifestResult.value.files : {};
  const actual = Object.fromEntries(
    corpus.map(({ name, file }) => [
      name,
      {
        cases: file.cases.length,
        only: file.cases
          .filter((testCase) => testCase.only !== undefined)
          .map((testCase) => testCase.id)
          .sort(),
      },
    ]),
  );

  it("matches the manifest, so no case is dropped or hidden unnoticed", () => {
    expect(actual).toEqual(manifest);
  });

  it("pins the answer for the nested-quantifier pattern the time-bound test uses", () => {
    const answers = corpus
      .flatMap(({ file }) => file.cases)
      .filter(
        (testCase): testCase is RegexMatchCase =>
          testCase.kind === "regex-match" && testCase.pattern === "^(?:a+)+b$",
      )
      .flatMap((testCase) => testCase.inputs);
    expect(answers.some(({ matches }) => matches)).toBe(true);
    expect(
      answers.some(
        ({ input, matches }) =>
          !matches && input === `${"a".repeat(NESTED_QUANTIFIER_RUN)}c`,
      ),
    ).toBe(true);
  });

  it("executes every case the manifest counts, but those marked for the other side", () => {
    const total = Object.values(manifest).reduce(
      (sum, entry) => sum + entry.cases,
      0,
    );
    expect(counts.executed + counts.skipped).toBe(total);
  });
});
