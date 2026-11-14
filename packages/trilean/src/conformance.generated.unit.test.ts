import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  generatedCorpus,
  writeGeneratedCorpus,
} from "./test-support/generated-corpus";

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);

/**
 * The generated corpus files (`pnpm exec tsx scripts/generate-corpus.ts` writes them) are regenerated into a temporary directory and compared, byte for byte, with the committed ones, so a change to the implementation that alters a recorded answer, or an edit by hand, fails here until the files are regenerated and the change reviewed.
 */
describe("the generated corpus files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "trilean-corpus-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("are exactly what the generator writes", () => {
    writeGeneratedCorpus(scratch);
    const paths = [...generatedCorpus().keys()];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(
        readFileSync(join(scratch, path), "utf8"),
        `${path} was regenerated`,
      ).toBe(readFileSync(join(CORPUS_ROOT, path), "utf8"));
    }
  });
});
