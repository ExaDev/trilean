import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GENERATED_CORPUS_FILES,
  generatedCorpus,
  generatedDerived,
} from "./test-support/generated-corpus";
import { readJson } from "./test-support/read-json";
import { validateManifest } from "./test-support/validate";

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);

/** The time budget of the tests that regenerate everything, per generated file: the generator derives and validates one file at a time, so the work of the run is the number of files, and the budget is that number times this allowance, which is several times what a slow runner takes for one file. */
const MILLISECONDS_PER_GENERATED_FILE = 25;

/** The files under the generated fixture directories, the measure of the work. */
function generatedFileCount(): number {
  return ["invalid-cases", "repaired-cases"].reduce(
    (sum, directory) =>
      sum +
      readdirSync(join(CORPUS_ROOT, "fixtures", "generated", directory)).length,
    0,
  );
}

/**
 * Everything the generator writes (`pnpm exec tsx scripts/generate-corpus.ts`) is regenerated and compared, byte for byte, with what is committed, so a change to the implementation that alters a recorded answer, a change to the corpus or the schema that the fixtures and the index do not follow, and an edit by hand all fail here until the files are regenerated and the change reviewed.
 */
describe("the generated files", () => {
  it(
    "are exactly what the generator writes",
    () => {
      const expected = new Map([
        ...generatedCorpus(),
        ...generatedDerived(CORPUS_ROOT),
      ]);
      expect(expected.size).toBeGreaterThan(GENERATED_CORPUS_FILES.length);
      const differing = [...expected]
        .filter(
          ([path, content]) =>
            readFileSync(join(CORPUS_ROOT, path), "utf8") !== content,
        )
        .map(([path]) => path);
      expect(differing).toEqual([]);
    },
    generatedFileCount() * MILLISECONDS_PER_GENERATED_FILE,
  );

  it(
    "include every file under the generated fixture directories, and no other",
    () => {
      const expected = [...generatedDerived(CORPUS_ROOT).keys()]
        .filter((path) => path.startsWith("fixtures/generated/"))
        .sort();
      const present = ["invalid-cases", "repaired-cases"].flatMap((directory) =>
        readdirSync(join(CORPUS_ROOT, "fixtures", "generated", directory)).map(
          (name) => `fixtures/generated/${directory}/${name}`,
        ),
      );
      expect(present.sort()).toEqual(expected);
    },
    generatedFileCount() * MILLISECONDS_PER_GENERATED_FILE,
  );

  it("are the files the manifest marks as generated, and no others", () => {
    const manifest = validateManifest(
      readJson(join(CORPUS_ROOT, "manifest.json")),
    );
    if (!manifest.ok) {
      throw new Error(manifest.problems.join("\n"));
    }
    const marked = Object.entries(manifest.value.files)
      .filter(([, entry]) => entry.generated === true)
      .map(([name]) => name)
      .sort();
    expect(marked).toEqual([...GENERATED_CORPUS_FILES].sort());
  });
});
