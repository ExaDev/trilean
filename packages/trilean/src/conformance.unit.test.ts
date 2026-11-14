import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkCorpus,
  completenessProblems,
  createRunRecord,
  registerCases,
  type RunRecord,
} from "./test-support/corpus";
import { selectCorpusFiles } from "./test-support/corpus-files";
import {
  EXECUTED_KINDS,
  FOREIGN_KINDS,
  SKIP_VALUES,
} from "./test-support/corpus-types";
import { runBuildCase } from "./test-support/run-build";
import { runCallCase } from "./test-support/run-call";
import { runCliCase } from "./test-support/run-cli";
import { runDocumentCase, runInputsCase } from "./test-support/run-document";
import {
  runNumberFormatCase,
  runSerialiseCase,
} from "./test-support/run-serialise";
import { runEvaluateCase } from "./test-support/run-evaluate";
import { runValidateCase } from "./test-support/run-validate";
import { keyProblems } from "./test-support/canonical-keys";
import { readJson } from "./test-support/read-json";
import { textToCodeUnits, textToString } from "./test-support/text";
import { validateCorpusFile, validateManifest } from "./test-support/validate";

/**
 * Runs this package's share of the language-neutral conformance corpus (`conformance/` at the repository root, the files under `trilean/`) against the TypeScript implementation. The format, the file selection rule and the comparison rules are in `conformance/README.md`; `conformance/case.schema.json` is the schema every file is validated against before anything runs.
 *
 * Nothing about the corpus is trusted: a file that does not match the format, an unexpected entry in the tree, a corpus that differs from `conformance/manifest.json` and a case this package cannot execute all fail the run rather than being skipped, since a skipped case reads as a case that passes.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);
const FIXTURES = join(CORPUS_ROOT, "fixtures");
/** The corpus directory this package executes; the other packages' directories belong to their own runners. */
const PACKAGE_DIRECTORY = "trilean/";

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
    expectPairs(
      "refused-kinds/invalid",
      "refused-kinds/repaired",
      validateCorpusFile,
    );
    expectPairs(
      "schema-only/invalid-cases",
      "schema-only/repaired-cases",
      validateCorpusFile,
    );
    expectPairs(
      "generated/invalid-cases",
      "generated/repaired-cases",
      validateCorpusFile,
    );
  });

  it("rejects every file whose keys are not canonical, each for its one defect", () => {
    expectPairs("canonical-keys/invalid", "canonical-keys/repaired", () => ({
      ok: true,
    }));
    for (const name of fixtureNames("canonical-keys/invalid")) {
      expect(
        () => readJson(join(FIXTURES, "canonical-keys", "invalid", name)),
        `readJson refuses invalid/${name}`,
      ).toThrow();
      expect(
        readJson(join(FIXTURES, "canonical-keys", "repaired", name)),
        `readJson reads repaired/${name}`,
      ).toBeDefined();
      for (const side of ["invalid", "repaired"]) {
        const text = readFileSync(
          join(FIXTURES, "canonical-keys", side, name),
          "utf8",
        );
        expect(keyProblems(text).length > 0, `${side}/${name}`).toBe(
          side === "invalid",
        );
      }
    }
  });

  it("finds in every generated document the number of problems the file records", () => {
    const document = readJson(
      join(FIXTURES, "canonical-keys", "differential.json"),
    );
    const documents: unknown = isRecord(document)
      ? document.documents
      : undefined;
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new Error("differential.json must hold a non-empty list");
    }
    const differing = documents.flatMap((entry: unknown, position: number) =>
      isRecord(entry) &&
      typeof entry.text === "string" &&
      keyProblems(entry.text).length === entry.problems
        ? []
        : [position],
    );
    expect(differing).toEqual([]);
    expect(
      documents.some(
        (entry: unknown) => isRecord(entry) && entry.problems !== 0,
      ),
      "the documents include some that break the rule",
    ).toBe(true);
    expect(
      documents.some(
        (entry: unknown) => isRecord(entry) && entry.problems === 0,
      ),
      "the documents include some that keep the rule",
    ).toBe(true);
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
    for (const directory of ["valid-cases", "schema-only/valid-cases"]) {
      for (const name of fixtureNames(directory)) {
        const result = validateCorpusFile(
          readJson(join(FIXTURES, directory, name)),
        );
        expect(
          result.ok ? [] : result.problems,
          `${directory}/${name}`,
        ).toEqual([]);
      }
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
      [...EXECUTED_KINDS, ...FOREIGN_KINDS].sort(),
    );
    expect(dig(schema, "$defs", "skip", "enum")).toEqual([...SKIP_VALUES]);
  });
});

const checked = checkCorpus(CORPUS_ROOT);
if (checked.problems.length > 0) {
  throw new Error(`the corpus is malformed:\n${checked.problems.join("\n")}`);
}
const corpus = checked.files.filter(({ name }) =>
  name.startsWith(PACKAGE_DIRECTORY),
);

// What this run does, written by the registration loop and the test bodies below and never computed from the parsed corpus: the completeness check at the end compares it with the manifest, so a loop that drops or filters cases, skips more than the manifest allows, or registers a body that never runs fails it.
const record = createRunRecord();

/** Runs one case of this package's share of the corpus. */
async function runCase(
  testCase: (typeof corpus)[number]["file"]["cases"][number],
): Promise<void> {
  if (testCase.kind === "validate") {
    runValidateCase(testCase);
  } else if (testCase.kind === "evaluate") {
    await runEvaluateCase(testCase);
  } else if (testCase.kind === "cli") {
    runCliCase(testCase);
  } else if (testCase.kind === "serialise") {
    runSerialiseCase(testCase);
  } else if (testCase.kind === "number-format") {
    runNumberFormatCase(testCase);
  } else if (testCase.kind === "inputs") {
    runInputsCase(testCase);
  } else if (testCase.kind === "document") {
    runDocumentCase(testCase);
  } else if (testCase.kind === "build") {
    runBuildCase(testCase);
  } else if (testCase.kind === "call") {
    runCallCase(testCase);
  } else {
    throw new Error(
      `no executor for the ${testCase.kind} kind in this package`,
    );
  }
}

for (const { name, file } of corpus) {
  describe(`conformance ${name}`, () => {
    registerCases(
      file.cases,
      record,
      (title, skipped, body) => {
        (skipped ? it.skip : it)(title, body);
      },
      runCase,
    );
  });
}

describe("the completeness check", () => {
  const manifest = { total: 3, skip: ["c"] };
  const run = (changes: Partial<RunRecord> = {}): RunRecord => ({
    registered: ["a", "b", "c"],
    skipped: ["c"],
    started: ["a", "b"],
    ...changes,
  });

  it("accepts a run that registered, skipped and started what the manifest says", () => {
    expect(completenessProblems(manifest, run())).toEqual([]);
  });

  it("registers every case, skips those marked for this implementation and starts the rest", async () => {
    const cases = [
      { id: "a", from: "x.test.ts: a" },
      { id: "b", from: "x.test.ts: b", skip: "ts" },
      { id: "c", from: "x.test.ts: c", skip: "rust" },
    ];
    const recorded = createRunRecord();
    const defined: {
      title: string;
      skipped: boolean;
      body: () => Promise<void>;
    }[] = [];
    registerCases(
      cases,
      recorded,
      (title, skipped, body) => {
        defined.push({ title, skipped, body });
      },
      () => undefined,
    );
    await Promise.all(
      defined.filter(({ skipped }) => !skipped).map(async ({ body }) => body()),
    );
    expect(defined.map(({ skipped }) => skipped)).toEqual([false, true, false]);
    expect(completenessProblems({ total: 3, skip: ["b"] }, recorded)).toEqual(
      [],
    );
  });

  it("leaves a body that is registered and never run to fail the check", () => {
    const recorded = createRunRecord();
    registerCases(
      [{ id: "a", from: "x.test.ts: a" }],
      recorded,
      () => undefined,
      () => undefined,
    );
    expect(completenessProblems({ total: 1, skip: [] }, recorded)).not.toEqual(
      [],
    );
  });

  it("refuses a run that skips every case", () => {
    expect(
      completenessProblems(
        manifest,
        run({ skipped: ["a", "b", "c"], started: [] }),
      ),
    ).not.toEqual([]);
  });

  it("refuses a registration loop that leaves cases out", () => {
    expect(
      completenessProblems(
        manifest,
        run({ registered: ["a", "c"], started: ["a"] }),
      ),
    ).not.toEqual([]);
  });

  it("refuses a registered case whose body never starts", () => {
    expect(completenessProblems(manifest, run({ started: ["a"] }))).not.toEqual(
      [],
    );
  });

  it("refuses a case registered twice, started twice or started after being skipped", () => {
    expect(
      completenessProblems(
        { total: 3, skip: ["c"] },
        run({ registered: ["a", "a", "c"], started: ["a"] }),
      ),
    ).not.toEqual([]);
    expect(
      completenessProblems(manifest, run({ started: ["a", "b", "b"] })),
    ).not.toEqual([]);
    expect(
      completenessProblems(manifest, run({ started: ["a", "b", "c"] })),
    ).not.toEqual([]);
  });

  it("refuses a skip the manifest does not list, and a listed skip that is not made", () => {
    expect(
      completenessProblems(
        manifest,
        run({ skipped: ["b", "c"], started: ["a"] }),
      ),
    ).not.toEqual([]);
    expect(
      completenessProblems(
        manifest,
        run({ skipped: [], started: ["a", "b", "c"] }),
      ),
    ).not.toEqual([]);
  });
});

describe("corpus completeness", () => {
  const manifest = validateManifest(
    readJson(join(CORPUS_ROOT, "manifest.json")),
  );

  // Runs after every test above it, which holds for the file order vitest uses unless it is told to shuffle; a run that filters tests by name leaves this test out or, run by itself, finds no body started.
  it("registers, skips and runs cases as the manifest says for this implementation", () => {
    if (!manifest.ok) {
      throw new Error(manifest.problems.join("\n"));
    }
    const entries = Object.entries(manifest.value.files)
      .filter(([name]) => name.startsWith(PACKAGE_DIRECTORY))
      .map(([, entry]) => entry);
    expect(
      entries.length,
      "the manifest lists no file for this package",
    ).toBeGreaterThan(0);
    expect(
      completenessProblems(
        {
          total: entries.reduce((sum, entry) => sum + entry.cases, 0),
          skip: entries.flatMap((entry) => entry.skip.ts),
        },
        record,
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

/** The tests of the corpus machinery itself, which the README table does not list: they test how the corpus is read and not a behaviour of the package. */
const RUNNER_TESTS: ReadonlySet<string> = new Set([
  "conformance.unit.test.ts",
  "conformance.generated.unit.test.ts",
  "conformance.compare.unit.test.ts",
  "conformance.schema.unit.test.ts",
]);

/** The test files under a directory, other than the runners' own. */
function testFiles(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        !RUNNER_TESTS.has(entry.name) &&
        !(entry.name === "conformance.unit.test.ts"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

const ROW = /^\| (\S+\.test\.ts) \| (.+) \| (T\d+) \|$/u;
const LEGEND = /^\| (T\d+) \| ([^|]+) \| ([^|]+) \|$/u;

describe("the tests that stay outside the corpus", () => {
  const readme = readFileSync(join(CORPUS_ROOT, "README.md"), "utf8");
  const section = readme
    .slice(
      readme.indexOf("## Tests that stay outside the corpus"),
      readme.indexOf("## Adding a case"),
    )
    .split("\n");
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const files = [
    ...testFiles(join(packages, "trilean")),
    ...testFiles(join(packages, "trilean-regex")),
  ].filter((file) => !file.includes("node_modules"));
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

  it("has only well formed rows, each with a code the legend defines", () => {
    expect(rowLines.filter((line) => !ROW.test(line))).toEqual([]);
    const legend = section.filter((line) => /^\| T\d+ \|/u.test(line));
    expect(legend.filter((line) => !LEGEND.test(line))).toEqual([]);
    const codes = legend.map((line) => LEGEND.exec(line)?.[1] ?? "");
    expect(codes).toEqual(
      [...codes].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    );
    expect(rows.filter(({ code }) => !codes.includes(code))).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("lists every test under its exact title", () => {
    expect(files.length).toBeGreaterThan(0);
    const listed = rows.map(({ name, title }) => `${name} | ${title}`);
    expect(present.filter((key) => !listed.includes(key))).toEqual([]);
  });

  it("lists no test that is not there", () => {
    const listed = rows.map(({ name, title }) => `${name} | ${title}`);
    expect(listed.filter((key) => !present.includes(key))).toEqual([]);
    expect([...listed].sort()).toEqual([...present].sort());
  });
});

/** The loader files the three packages' runners copy from each other. All are removed with the TypeScript they test, and a change to one is made in the others. */
describe("the loader files copied between the runners", () => {
  const copied = [
    "canonical-keys",
    "corpus-files",
    "corpus",
    "text",
    "read-json",
    "validate",
  ];
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  /** A file without the line that names the other copy, the one place the copies differ. */
  const withoutHeaderLine = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !line.includes("This file is a copy of"))
      .join("\n");

  it.each(
    copied.flatMap((name) =>
      ["trilean-regex", "trilean-sql"].map((other) => [name, other] as const),
    ),
  )(
    "%s is the same file here and in %s, but for the line naming the other",
    (name, other) => {
      const here = readFileSync(
        join(packages, "trilean", "src", "test-support", `${name}.ts`),
        "utf8",
      );
      const there = readFileSync(
        join(packages, other, "src", "test-support", `${name}.ts`),
        "utf8",
      );
      expect(here).toContain("This file is a copy of");
      expect(withoutHeaderLine(here)).toBe(withoutHeaderLine(there));
    },
  );
});
