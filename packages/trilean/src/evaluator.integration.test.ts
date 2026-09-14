import { describe, expect, it } from "vitest";
import { createEvaluator, evaluatePredicate, evaluateValue } from "./evaluator";
import type { Resolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";
import {
  expectDefinite,
  expectIndeterminate,
  isPlainRecord,
  isUnknownArray,
  resolvers,
} from "./evaluator-test-helpers";

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

  /** A wide-but-shallow `allOf` of `count` trivial `exists` leaves -- every leaf contributes to the total node-visit count while adding only two levels of nesting depth regardless of `count`, isolating the node-count cap from the nesting-depth cap below. */
  function wideAllOf(count: number): PredicateNode {
    return {
      kind: "allOf",
      operands: Array.from({ length: count }, () => ({
        kind: "exists" as const,
        operand: { kind: "numberLiteral" as const, value: 1 },
      })),
    };
  }

  /** The explicit `maxNodes` configured for the node-count-cap tests below, chosen only to be comfortably smaller than `wideOperandCountExceedingNodeCap`'s resulting node count -- its exact value carries no other significance. */
  const explicitNodeCap = 50;

  /** The explicit `maxNestingDepth` configured for the nesting-depth-cap tests below, chosen only to be comfortably smaller than `notDepthExceedingNestingCap` -- its exact value carries no other significance. */
  const explicitNestingDepthCap = 10;

  /** `allOf` operand count for the node-count-cap test: the allOf node itself plus this many two-node (`exists` + `numberLiteral`) operands comfortably exceeds `explicitNodeCap`, while the tree stays only two levels deep -- nowhere near any nesting-depth cap, isolating that assertion to the node-count cap alone. */
  const wideOperandCountExceedingNodeCap = 60;

  /** `not`-chain depth for the nesting-depth-cap test: comfortably exceeds `explicitNestingDepthCap`, while the resulting total node count stays nowhere near any default or explicit node-count cap, isolating that assertion to the nesting-depth cap alone. */
  const notDepthExceedingNestingCap = 50;

  /** `not`-chain depth for the "well within both caps" test: an odd number of negations flips a definitely-true `exists` leaf to false, comfortably inside both `explicitNodeCap` and `explicitNestingDepthCap`. */
  const notDepthWithinBothCaps = 5;

  /** `not`-chain depth used to prove `createEvaluator({})`'s own defaults catch an oversized tree: comfortably past `DEFAULT_MAX_NESTING_DEPTH` while staying well short of the depth at which this shape has been observed to exhaust the real call stack (see the issue this addresses for how that was measured). */
  const notDepthExceedingDefaultNestingCap = 1000;

  it("a node-count cap configured via createEvaluator rejects a wide-but-shallow tree that exceeds it, as indeterminate", async () => {
    const { evaluatePredicate: evaluate } = createEvaluator({
      maxNodes: explicitNodeCap,
    });
    const result = await evaluate(
      wideAllOf(wideOperandCountExceedingNodeCap),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
      expect(result.reason.message).toMatch(/node/i);
    }
  });

  it("a nesting-depth cap configured via createEvaluator rejects a narrow-but-deep tree that exceeds it, as indeterminate", async () => {
    const { evaluatePredicate: evaluate } = createEvaluator({
      maxNestingDepth: explicitNestingDepthCap,
    });
    const result = await evaluate(
      deeplyNestedNot(notDepthExceedingNestingCap),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
      expect(result.reason.message).toMatch(/depth/i);
    }
  });

  it("a tree well within both caps evaluates normally and correctly", async () => {
    const { evaluatePredicate: evaluate } = createEvaluator({
      maxNodes: explicitNodeCap,
      maxNestingDepth: explicitNestingDepthCap,
    });
    const result = await evaluate(
      deeplyNestedNot(notDepthWithinBothCaps),
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("MAX_TREE_REFERENCE_DEPTH's own chain-depth guard is unaffected by the nesting-depth cap", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve({
          found: true,
          node: {
            kind: "treeReference",
            key: `${typeof key === "string" ? key : "chain"}-next`,
          },
        }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "chain-0" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "domain-error");
    if (result.status === "indeterminate") {
      expect(result.reason.message).toBe(
        "treeReference chain exceeds the maximum depth of 100",
      );
    }
  });

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

/** README.md's own "Worked example" (§ Worked example), verbatim: `isActive equals 1` AND `sum(items.amount) > x + y`, where the sum is exactly the `fold` tree the `sum` derived-aggregate builder assembles. Both variations from the README are included, exercising the propagation rules the worked example is there to demonstrate -- absorption via `and`'s definitely-false right operand, versus a missing reference surfacing all the way to the top because `true` is not absorbing for `and`. */
describe("golden example (README Worked example)", () => {
  const goldenExampleResolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (
        typeof key !== "string" ||
        !isPlainRecord(context) ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      return Promise.resolve(
        typeof value === "number"
          ? { found: true, value: { kind: "number", value } }
          : { found: false },
      );
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection, context) => {
      if (collection !== "items" || !isPlainRecord(context)) {
        return Promise.resolve([]);
      }
      const items = context.items;
      return Promise.resolve(isUnknownArray(items) ? items : []);
    },
  };

  const node: PredicateNode = {
    kind: "and",
    left: {
      kind: "compare",
      op: "eq",
      left: { kind: "reference", key: "isActive" },
      right: { kind: "numberLiteral", value: 1 },
    },
    right: {
      kind: "compare",
      op: "gt",
      left: {
        kind: "fold",
        collection: "items",
        combiner: {
          mode: "reduce",
          initial: { kind: "numberLiteral", value: 0 },
          combine: {
            kind: "arithmetic",
            op: "add",
            left: { kind: "accumulator" },
            right: { kind: "reference", key: "amount" },
          },
        },
      },
      right: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "reference", key: "x" },
        right: { kind: "reference", key: "y" },
      },
    },
  };

  it("base case: isActive=1, sum(items.amount)=21 > x+y=15 => definitely true", async () => {
    const data = {
      isActive: 1,
      x: 10,
      y: 5,
      items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
    };
    const result = await evaluatePredicate(node, data, goldenExampleResolvers);
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("empty items: the sum-over-empty identity (0) is not > 15, and false absorbs regardless of the left branch", async () => {
    const data = { isActive: 1, x: 10, y: 5, items: [] as unknown[] };
    const result = await evaluatePredicate(node, data, goldenExampleResolvers);
    expect(result).toEqual({ status: "definite", value: false });
  });

  it("missing x: not-found surfaces to the top, since true is not absorbing for and", async () => {
    const data = {
      isActive: 1,
      y: 5,
      items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
    };
    const result = await evaluatePredicate(node, data, goldenExampleResolvers);
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });
});
