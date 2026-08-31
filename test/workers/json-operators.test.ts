import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "../../src/evaluator";
import {
  goldenExampleData,
  goldenExampleDataEmptyItems,
  goldenExampleDataMissingX,
  goldenExampleResolvers,
  goldenExampleTree,
} from "../../src/test-support/golden-example";

/**
 * The same README.md "Worked example" fixture as src/golden-examples.test.ts (imported, not duplicated, so the two suites can never silently drift apart), re-run here inside the real Cloudflare Workers runtime (workerd) via the `workers` vitest project. Passing here turns "isomorphic" from an assertion into a runtime-checked fact for the evaluator itself, not merely for the Zod schemas.
 */
describe("golden example (README.md worked example) under workerd", () => {
  it("base case: isActive eq 1 AND sum(items.amount) via reduce fold > x + y -> definite true", async () => {
    const result = await evaluatePredicate(
      goldenExampleTree,
      goldenExampleData,
      goldenExampleResolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("items: [] variation -> definite false (the fold-over-empty identity feeds through to and's own absorbing false)", async () => {
    const result = await evaluatePredicate(
      goldenExampleTree,
      goldenExampleDataEmptyItems,
      goldenExampleResolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });

  it("x missing from data variation -> indeterminate not-found (and does NOT absorb here)", async () => {
    // Unlike the empty-items case above, the left operand (isActive eq 1) is definitely true here, and true is not an absorbing value for AND -- so the right operand's not-found propagates all the way to the top instead of being rescued.
    const result = await evaluatePredicate(
      goldenExampleTree,
      goldenExampleDataMissingX,
      goldenExampleResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });
});
