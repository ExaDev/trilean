import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps the time limits of the tests that walk the corpus derived (ExaDev/trilean#167): a test file that calls a function walking the corpus imports the shared helper, so a new corpus-sized test cannot fall back to the runner's default of five seconds unnoticed.
 */
/** Functions whose call walks every file or case of the corpus or of its fixtures. */
const CORPUS_WALKERS = [
  "expect(checkCorpus(",
  "unusedForms(",
  "jsonFiles(",
  "readdirSync(CORPUS",
];

function testFiles(directory: string): readonly string[] {
  return readdirSync(join(import.meta.dirname, directory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        !entry.parentPath.includes("node_modules"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("the time limit of a test that walks the corpus", () => {
  it("is imported by every test file that calls a function walking the corpus", () => {
    const files = [
      join(import.meta.dirname, "shape-agreement.integration.test.ts"),
      ...testFiles("packages"),
    ];
    const without = files.filter((file) => {
      const text = readFileSync(file, "utf8");

      return (
        CORPUS_WALKERS.some((walker) => text.includes(walker)) &&
        !text.includes("corpus-time-limit")
      );
    });
    expect(without).toEqual([]);
  });

  it("is a file under no package, so no package ships or releases it", () => {
    expect(
      readdirSync(join(import.meta.dirname, "packages")).filter((name) =>
        readdirSync(join(import.meta.dirname, "packages", name)).includes(
          "corpus-time-limit.ts",
        ),
      ),
    ).toEqual([]);
  });
});
