import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps the time limits of the tests that walk the corpus derived (ExaDev/trilean#167): a test file that reads the corpus imports the shared helper and sets no literal `timeout`, so a new corpus-sized test cannot fall back to the runner's default of five seconds unnoticed.
 *
 * The limit of this guard: it works per file, so a file that imports the helper passes whatever else it does, and a test left on the default inside such a file is not seen; a literal `testTimeout` in a vitest configuration is not seen either. The helper is a flake guard with a derived limit, not a detector of complexity.
 */
const ROOT = import.meta.dirname;

/** What a test file contains when it reads a path under `conformance/`, with the comments removed first so that a comment naming the corpus does not count. */
const READS_CORPUS =
  /CORPUS_ROOT|\bCORPUS\b|corpusRoot|\bAREA\b|["'`/]conformance["'`/]/u;

/** Test files that match `READS_CORPUS` and do not walk the corpus, each with its reason. A file named here that no longer matches fails, so the list cannot go stale. */
const NOT_A_WALK: Readonly<Record<string, string>> = {
  "time-limit.integration.test.ts":
    "is this guard, which names the corpus path in its own patterns and walks nothing",
  "release-workspace.integration.test.ts":
    "compares path strings with the release configuration and reads no corpus file",
  "packages/trilean/test/workers/reader.e2e.test.ts":
    "runs in the Workers runtime, which has no filesystem for the helper to count the corpus with, and checks the cases of four validate files that are imported into it as modules",
  "packages/trilean-regex/test/runner-budget.unit.test.ts":
    "lists the few files of conformance/runner, which is not corpus data",
};

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

function testFiles(directory: string): readonly string[] {
  return readdirSync(join(ROOT, directory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        !entry.parentPath.includes("node_modules"),
    )
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1));
}

const ALL = [
  ...readdirSync(ROOT).filter((name) => name.endsWith(".test.ts")),
  ...testFiles("packages"),
];

function code(file: string): string {
  return withoutComments(readFileSync(join(ROOT, file), "utf8"));
}

const WALKERS = ALL.filter((file) => READS_CORPUS.test(code(file)));

describe("the time limit of a test that walks the corpus", () => {
  it("is imported by every test file that reads the corpus, unless it is named as no walk", () => {
    const without = WALKERS.filter(
      (file) =>
        !(file in NOT_A_WALK) && !code(file).includes("corpus-time-limit"),
    );
    expect(without).toEqual([]);
  });

  it("is not set as a literal in a file that reads the corpus", () => {
    const literal = WALKERS.filter(
      (file) =>
        !(file in NOT_A_WALK) &&
        /\btimeout:\s*\d|\},\s*\d[\d_]{3,}\s*\)/u.test(code(file)),
    );
    expect(literal).toEqual([]);
  });

  it("names only files that still read the corpus", () => {
    expect(
      Object.keys(NOT_A_WALK).filter((file) => !WALKERS.includes(file)),
    ).toEqual([]);
  });

  it("is in no package: not as a file, not in a files list, not imported by code that is built", () => {
    const inPackages = readdirSync(join(ROOT, "packages"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.parentPath.includes("node_modules") &&
          entry.name === "corpus-time-limit.ts",
      )
      .map((entry) => entry.parentPath);
    expect(inPackages).toEqual([]);

    const manifests = readdirSync(join(ROOT, "packages")).map((name) =>
      readFileSync(join(ROOT, "packages", name, "package.json"), "utf8"),
    );
    expect(manifests.filter((text) => text.includes("time-limit"))).toEqual([]);

    const builtSources = readdirSync(join(ROOT, "packages"), {
      recursive: true,
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          entry.parentPath.split("/").includes("src") &&
          !entry.parentPath.includes("node_modules") &&
          !entry.parentPath.includes("test-support"),
      )
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) =>
        readFileSync(file, "utf8").includes("corpus-time-limit"),
      );
    expect(builtSources).toEqual([]);
  });
});
