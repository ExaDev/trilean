import { describe, expect, it } from "vitest";
import { evaluatePredicate, evaluateValue } from "./evaluator-factory";
import type { ExpressionNode, PredicateNode } from "./tree";
import { resolvers } from "./evaluator-test-helpers";

/**
 * The default resource limits against trees a thousand levels deep. The conformance corpus holds the explicit limits (`conformance/trilean/evaluate/evaluator.integration.json`); a tree this deep is not written there, since its JSON would be mostly indentation.
 */
describe("evaluation resource limits", () => {
  /** A `depth`-deep chain of `not` wrapping a single leaf `exists` node, built iteratively (never recursively) so constructing the fixture itself never taxes the test runner's own call stack. No `treeReference` node appears anywhere in this tree, so `MAX_TREE_REFERENCE_DEPTH`'s chain-depth counter never advances while evaluating it -- this is deliberately the shape that guard cannot see, since it only checks depth across `treeReference` hops between separately-stored trees, never ordinary recursive descent within one self-contained tree. */
  function deeplyNestedNot(depth: number): PredicateNode {
    let node: PredicateNode = {
      kind: "exists",
      operand: { kind: "numberLiteral", value: 1 },
    };
    for (let level = 0; level < depth; level += 1) {
      node = { kind: "not", operand: node };
    }

    return node;
  }

  /** `not`-chain depth used to prove `createEvaluator({})`'s own defaults catch an oversized tree: comfortably past `DEFAULT_MAX_NESTING_DEPTH` while staying well short of the depth at which this shape has been observed to exhaust the real call stack (see the issue this addresses for how that was measured). */
  const notDepthExceedingDefaultNestingCap = 1000;

  it("createEvaluator({})'s defaults catch a real oversized tree without any explicit cap configuration", async () => {
    // A correct default catches this deterministically as indeterminate; the pre-fix evaluator instead resolved it to a (wrong, but not crashing) definite value at this particular depth.
    const result = await evaluatePredicate(
      deeplyNestedNot(notDepthExceedingDefaultNestingCap),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
      expect(result.reason.message).toMatch(/depth/i);
    }
  });

  it("createEvaluator({})'s defaults catch a real oversized tree via evaluateValue too, not only evaluatePredicate", async () => {
    let node: ExpressionNode = { kind: "numberLiteral", value: 1 };
    for (
      let level = 0;
      level < notDepthExceedingDefaultNestingCap;
      level += 1
    ) {
      node = { kind: "negate", operand: node };
    }
    const result = await evaluateValue(node, undefined, resolvers);
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
      expect(result.reason.message).toMatch(/depth/i);
    }
  });
});
