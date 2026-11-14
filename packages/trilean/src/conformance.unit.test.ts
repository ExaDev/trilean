import { readdirSync } from "node:fs";
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
  EXECUTED_KINDS,
  FOREIGN_KINDS,
  SKIP_VALUES,
} from "./test-support/corpus-types";
import { runBuildCase } from "./test-support/run-build";
import { runCallCase } from "./test-support/run-call";
import { runEvaluateCase } from "./test-support/run-evaluate";
import { runValidateCase } from "./test-support/run-validate";
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

// What this run registers, computed while the tests are collected, so the completeness check below holds whatever the run does with them afterwards: a name filter, a bail, a retry or a shuffled order changes which registered tests run, never which are registered.
const { registered, skipped } = collect(corpus);
const registeredIds = new Set(registered);

for (const { name, file } of corpus) {
  describe(`conformance ${name}`, () => {
    for (const testCase of file.cases) {
      it.skipIf(!registeredIds.has(testCase.id))(
        `${testCase.id} (${testCase.from})`,
        async () => {
          if (testCase.kind === "validate") {
            runValidateCase(testCase);
          } else if (testCase.kind === "evaluate") {
            await runEvaluateCase(testCase);
          } else if (testCase.kind === "build") {
            runBuildCase(testCase);
          } else if (testCase.kind === "call") {
            runCallCase(testCase);
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
  const manifest = validateManifest(
    readJson(join(CORPUS_ROOT, "manifest.json")),
  );

  it("registers and skips cases so that they add up to the manifest's share for this package", () => {
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
        entries.reduce((sum, entry) => sum + entry.cases, 0),
        new Set(entries.flatMap((entry) => entry.skip)),
        registered,
        skipped,
      ),
    ).toEqual([]);
  });
});
