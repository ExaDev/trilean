import { describe, expect, it } from "vitest";
import { evaluateDocument } from "./evaluate-document";

/**
 * What a document evaluates to is in the conformance corpus (`conformance/trilean/document/`). That a missing list is raised as an exception, which has no value to compare, is a property of the TypeScript API.
 */
describe("evaluateDocument", () => {
  it("lets a collection error propagate for a tree that folds over a list the inputs do not hold", () => {
    expect(() =>
      evaluateDocument({
        tree: {
          kind: "fold",
          collection: "loads",
          combiner: { mode: "max", item: { kind: "numberLiteral", value: 1 } },
        },
      }),
    ).toThrow(/the inputs hold no list of items under that name/);
  });
});
