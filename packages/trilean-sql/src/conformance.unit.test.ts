import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkCorpus,
  collect,
  completenessProblems,
} from "./test-support/corpus";
import { selectCorpusFiles } from "./test-support/corpus-files";
import {
  ENGINE_KINDS,
  EXECUTED_KINDS,
  FOREIGN_KINDS,
  SKIP_VALUES,
} from "./test-support/corpus-types";
import { readJson } from "./test-support/read-json";
import {
  runCompileCase,
  runGuardCase,
  runPatternCase,
} from "./test-support/run-sql";
import { textToCodeUnits, textToString } from "./test-support/text";
import { validateFixture } from "./test-support/fixture";
import { validateCorpusFile, validateManifest } from "./test-support/validate";

/**
 * Runs this package's unit share of the language-neutral conformance corpus (`conformance/` at the repository root, the `compile`, `guard` and `pattern` directories under `trilean-sql/`) against the TypeScript implementation. The `execute` directory runs against real engines in `test/integration/conformance.integration.test.ts`. The format, the file selection rule and the comparison rules are in `conformance/README.md`; `conformance/case.schema.json` is the schema every file is validated against before anything runs.
 *
 * Nothing about the corpus is trusted: a file that does not match the format, an unexpected entry in the tree, a corpus that differs from `conformance/manifest.json` and a case this package cannot execute all fail the run rather than being skipped, since a skipped case reads as a case that passes.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);
const FIXTURES = join(CORPUS_ROOT, "fixtures");

/** The corpus directories this runner executes; `trilean-sql/execute/` belongs to the integration runner and the other packages' directories to theirs. */
const PACKAGE_DIRECTORIES = [
  "trilean-sql/compile/",
  "trilean-sql/guard/",
  "trilean-sql/pattern/",
];

function inShare(name: string): boolean {
  return PACKAGE_DIRECTORIES.some((directory) => name.startsWith(directory));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextPair(
  value: unknown,
): value is { text: string; codeUnits: readonly number[] } {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    Array.isArray(value.codeUnits) &&
    value.codeUnits.every((unit: unknown) => typeof unit === "number")
  );
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

/** The names of the entries in a fixture directory, which must hold at least one. */
function fixtureNames(directory: string): readonly string[] {
  const names = readdirSync(join(FIXTURES, directory)).sort();
  expect(names.length, `${directory} holds no fixtures`).toBeGreaterThan(0);

  return names;
}

/** Whether a loader rejects the file: a file that cannot be parsed is rejected too. */
function rejects(
  path: string,
  validate: (value: unknown) => { readonly ok: boolean },
): boolean {
  try {
    return !validate(readJson(path)).ok;
  } catch {
    return true;
  }
}

/**
 * A negative fixture must fail for the rule it exists for. Each file in `invalid` has a file of the same name in `repaired` that differs by that one defect and is valid, so the invalid one cannot stay rejected for another reason.
 */
function expectPairs(
  invalid: string,
  repaired: string,
  validate: (value: unknown) => {
    readonly ok: boolean;
    readonly problems?: readonly string[];
  },
): void {
  const names = fixtureNames(invalid);
  expect(fixtureNames(repaired), "every fixture has a repaired twin").toEqual(
    names,
  );
  const accepted = names.filter(
    (name) => !rejects(join(FIXTURES, invalid, name), validate),
  );
  expect(accepted, `${invalid} fixtures that validate`).toEqual([]);
  for (const name of names) {
    const result = validate(readJson(join(FIXTURES, repaired, name)));
    expect(result.ok ? [] : result.problems, `${repaired}/${name}`).toEqual([]);
  }
}

/** The value at a path of keys, or undefined. */
function dig(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
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

  it("finds nothing wrong with the real corpus", () => {
    expect(checkCorpus(CORPUS_ROOT).problems).toEqual([]);
  });

  it("rejects every invalid-case fixture, each for its one defect", () => {
    expectPairs("invalid-cases", "repaired-cases", validateCorpusFile);
  });

  it("rejects every invalid execute fixture, each for its one defect", () => {
    expectPairs(
      "execute-fixtures/invalid",
      "execute-fixtures/repaired",
      validateFixture,
    );
  });

  it("rejects every invalid manifest fixture, each for its one defect", () => {
    expectPairs("manifests/invalid", "manifests/repaired", validateManifest);
  });

  it("rejects every invalid corpus fixture, each for its one defect", () => {
    const names = fixtureNames("corpora/invalid");
    expect(fixtureNames("corpora/repaired")).toEqual(names);
    for (const name of names) {
      expect(
        checkCorpus(join(FIXTURES, "corpora", "invalid", name)).problems.length,
        `corpora/invalid/${name} must have a problem`,
      ).toBeGreaterThan(0);
      expect(
        checkCorpus(join(FIXTURES, "corpora", "repaired", name)).problems,
        `corpora/repaired/${name}`,
      ).toEqual([]);
    }
  });

  it("accepts every valid fixture", () => {
    for (const name of fixtureNames("valid-cases")) {
      const result = validateCorpusFile(
        readJson(join(FIXTURES, "valid-cases", name)),
      );
      expect(result.ok ? [] : result.problems, name).toEqual([]);
    }
    for (const name of fixtureNames("manifests/valid")) {
      const result = validateManifest(
        readJson(join(FIXTURES, "manifests", "valid", name)),
      );
      expect(result.ok ? [] : result.problems, name).toEqual([]);
    }
  });

  it("reads both forms of a text as the same UTF-16 code units", () => {
    const document = readJson(join(FIXTURES, "text-forms", "pairs.json"));
    const list: unknown = isRecord(document) ? document.pairs : undefined;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("pairs.json must hold a non-empty list of pairs");
    }
    for (const pair of list) {
      if (!isTextPair(pair)) {
        throw new Error("a pair holds a text and its code units");
      }
      expect(textToCodeUnits(pair.text)).toEqual(pair.codeUnits);
      expect(textToCodeUnits({ codeUnits: pair.codeUnits })).toEqual(
        pair.codeUnits,
      );
      expect(textToString({ codeUnits: pair.codeUnits })).toBe(pair.text);
    }
  });

  it("types the case kinds and the skip values the schema defines, and no others", () => {
    const schema = readJson(join(CORPUS_ROOT, "case.schema.json"));
    const refs = dig(schema, "$defs", "case", "oneOf");
    if (!Array.isArray(refs)) {
      throw new Error("the schema's $defs.case.oneOf must be a list");
    }
    const kinds = refs.map((reference: unknown) => {
      const target = dig(reference, "$ref");
      const name = typeof target === "string" ? target.split("/").pop() : "";
      const kind = dig(
        schema,
        "$defs",
        name ?? "",
        "properties",
        "kind",
        "const",
      );
      if (typeof kind !== "string") {
        throw new Error(`no kind constant behind ${JSON.stringify(target)}`);
      }

      return kind;
    });
    expect([...kinds].sort()).toEqual(
      [...EXECUTED_KINDS, ...ENGINE_KINDS, ...FOREIGN_KINDS].sort(),
    );
    expect(dig(schema, "$defs", "skip", "enum")).toEqual([...SKIP_VALUES]);
  });
});

const checked = checkCorpus(CORPUS_ROOT);
if (checked.problems.length > 0) {
  throw new Error(`the corpus is malformed:\n${checked.problems.join("\n")}`);
}
const corpus = checked.files.filter(({ name }) => inShare(name));

// What this run registers, computed while the tests are collected, so the completeness check below holds whatever the run does with them afterwards: a name filter, a bail, a retry or a shuffled order changes which registered tests run, never which are registered.
const { registered, skipped } = collect(corpus);
const registeredIds = new Set(registered);

for (const { name, file } of corpus) {
  describe(`conformance ${name}`, () => {
    for (const testCase of file.cases) {
      it.skipIf(!registeredIds.has(testCase.id))(
        `${testCase.id} (${testCase.from})`,
        () => {
          if (testCase.kind === "sql-compile") {
            runCompileCase(testCase);
          } else if (testCase.kind === "sql-guard") {
            runGuardCase(testCase);
          } else if (testCase.kind === "sql-pattern") {
            runPatternCase(testCase);
          } else {
            throw new Error(
              `no executor for the ${testCase.kind} kind in this runner`,
            );
          }
        },
      );
    }
  });
}

describe("corpus completeness", () => {
  const manifest = validateManifest(
    readJson(join(CORPUS_ROOT, "manifest.json")),
  );

  it("registers and skips cases so that they add up to the manifest's share for this runner", () => {
    if (!manifest.ok) {
      throw new Error(manifest.problems.join("\n"));
    }
    const entries = Object.entries(manifest.value.files)
      .filter(([name]) => inShare(name))
      .map(([, entry]) => entry);
    expect(
      entries.length,
      "the manifest lists no file for this runner",
    ).toBeGreaterThan(0);
    expect(
      completenessProblems(
        entries.reduce((sum, entry) => sum + entry.cases, 0),
        new Set(entries.flatMap((entry) => entry.skip)),
        registered,
        skipped,
      ),
    ).toEqual([]);
  });
});

/** The titles of the tests in a source file: the first string of each `it(` and of each `it.each(...)(`, with escapes read as the text they stand for, a template title as written. */
function testTitles(source: string): readonly string[] {
  const direct = /\b(?:it|test)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/gu;
  const each =
    /\)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1\s*,\s*(?:async\s*)?\(/gu;

  return [...source.matchAll(direct), ...source.matchAll(each)].map((found) =>
    (found[2] ?? "").replace(/\\(.)/gu, "$1"),
  );
}

/** The tests of the corpus machinery itself, which the README table does not list: they test how the corpus is read and not a behaviour. */
const RUNNER_TESTS: ReadonlySet<string> = new Set([
  "conformance.unit.test.ts",
  "conformance.integration.test.ts",
  "conformance.coverage.unit.test.ts",
]);

const ROW = /^\| (\S+\.test\.ts) \| (.+) \| (S\d+) \|$/u;
const LEGEND = /^\| (S\d+) \| ([^|]+) \| ([^|]+) \|$/u;

describe("the tests that stay outside the corpus", () => {
  const readme = readFileSync(join(CORPUS_ROOT, "README.md"), "utf8");
  const section = readme
    .slice(
      readme.indexOf("## Tests of trilean-sql that stay outside the corpus"),
    )
    .split("\n");
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const files = readdirSync(packageRoot, {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        !RUNNER_TESTS.has(entry.name) &&
        !entry.parentPath.includes("node_modules"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
  const rowLines = section.filter((line) => /^\| \S+\.test\.ts \|/u.test(line));
  const rows = rowLines.flatMap((line) => {
    const found = ROW.exec(line);

    return found === null
      ? []
      : [{ name: found[1] ?? "", title: found[2] ?? "", code: found[3] ?? "" }];
  });
  const present = files.flatMap((file) => {
    const name = file.slice(file.lastIndexOf("/") + 1);

    return testTitles(readFileSync(file, "utf8")).map(
      (title) => `${name} | ${title}`,
    );
  });
  const listed = rows.map(({ name, title }) => `${name} | ${title}`);

  it("has only well formed rows, each with a code the legend defines", () => {
    expect(rowLines.filter((line) => !ROW.test(line))).toEqual([]);
    const legend = section.filter((line) => /^\| S\d+ \|/u.test(line));
    expect(legend.filter((line) => !LEGEND.test(line))).toEqual([]);
    const codes = legend.map((line) => LEGEND.exec(line)?.[1] ?? "");
    expect(rows.filter(({ code }) => !codes.includes(code))).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("lists every test under its exact title, and no test that is not there", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(present.filter((key) => !listed.includes(key))).toEqual([]);
    expect(listed.filter((key) => !present.includes(key))).toEqual([]);
    expect([...listed].sort()).toEqual([...present].sort());
  });
});
