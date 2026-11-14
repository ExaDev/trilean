import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unusedForms } from "./test-support/schema-forms";

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);

/**
 * The schema must accept nothing that no case exercises: a form no case uses is a contract nobody has run, and a second implementation cannot tell what it should do with it.
 */
describe("the case schema", () => {
  it("accepts only forms that a case of the corpus, or a valid fixture, uses", () => {
    expect(unusedForms(CORPUS_ROOT)).toEqual([]);
  });
});
