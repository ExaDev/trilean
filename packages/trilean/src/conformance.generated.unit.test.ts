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

/**
 * The allowance of the run per generated file, in milliseconds. The work of the run is one derivation of each file the generator produces: its content is built and canonically written, and a fixture is validated once against the case schema, so the work is proportional to the number of files and the allowance is per file. It is a named ceiling and not a measurement: the run fails for a slowdown that grows with the number of files, and the failure message gives the number of files, the budget and the time taken, which are what to compare when the allowance needs to change.
 */
const MILLISECONDS_PER_GENERATED_FILE = 25;

// The generator runs once, here and not inside a test, so that its output and the time it took are what the tests below compare: the budget derives from the number of files it produced, never from the committed ones.
const started = performance.now();
const generated = new Map([
  ...generatedCorpus(),
  ...generatedDerived(CORPUS_ROOT),
]);
const generationMilliseconds = performance.now() - started;

/**
 * Everything the generator writes (`pnpm exec tsx scripts/generate-corpus.ts`) is regenerated and compared, byte for byte, with what is committed, so a change to the implementation that alters a recorded answer, a change to the corpus or the schema that the fixtures and the index do not follow, and an edit by hand all fail here until the files are regenerated and the change reviewed.
 */
describe("the generated files", () => {
  it("are produced within the budget the number of files sets", () => {
    const budget = generated.size * MILLISECONDS_PER_GENERATED_FILE;
    expect(
      generationMilliseconds,
      `${String(generated.size)} files generated, a budget of ${String(budget)} ms at ${String(MILLISECONDS_PER_GENERATED_FILE)} ms each, took ${String(Math.round(generationMilliseconds))} ms`,
    ).toBeLessThanOrEqual(budget);
  });

  it("are exactly what the generator writes", () => {
    expect(generated.size).toBeGreaterThan(GENERATED_CORPUS_FILES.length);
    const differing = [...generated]
      .filter(
        ([path, content]) =>
          readFileSync(join(CORPUS_ROOT, path), "utf8") !== content,
      )
      .map(([path]) => path);
    expect(differing).toEqual([]);
  });

  it("include every file under the generated fixture directories, and no other", () => {
    const expected = [...generated.keys()]
      .filter((path) => path.startsWith("fixtures/generated/"))
      .sort();
    const present = ["invalid-cases", "repaired-cases"].flatMap((directory) =>
      readdirSync(join(CORPUS_ROOT, "fixtures", "generated", directory)).map(
        (name) => `fixtures/generated/${directory}/${name}`,
      ),
    );
    expect(present.sort()).toEqual(expected);
  });

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
