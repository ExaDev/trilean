import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "./evaluator";
import {
  goldenExampleData,
  goldenExampleDataEmptyItems,
  goldenExampleDataMissingX,
  goldenExampleResolvers,
  goldenExampleTree,
} from "./test-support/golden-example";

/**
 * The gate for Phase 7: the exact worked example from README.md's "Worked example" section, exercised end to end through the public `evaluatePredicate` entry point. Every `PredicateNode`/`ExpressionNode` kind the tree touches -- `and`, `compare`, `reference`, `numberLiteral`, `fold` (reduce mode), `accumulator`, `arithmetic` -- must already be fully implemented in evaluator.ts for these three assertions to pass.
 */
describe("golden example (README.md worked example)", () => {
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
