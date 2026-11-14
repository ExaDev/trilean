import { readFileSync } from "node:fs";
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
 * Everything the generator writes (`pnpm exec tsx scripts/generate-corpus.ts`) is regenerated and compared, byte for byte, with what is committed, so a change to the implementation that alters a recorded answer, a change to the corpus or the schema that the fixtures and the index do not follow, and an edit by hand all fail here until the files are regenerated and the change reviewed.
 */
describe("the generated files", () => {
  it("are exactly what the generator writes", () => {
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
