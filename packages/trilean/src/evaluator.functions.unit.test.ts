import { describe, expect, it } from "vitest";
import { createEvaluator, createSyncEvaluator } from "./evaluator-factory";
import { resolvers } from "./evaluator-test-helpers";
import type { FunctionRegistry } from "./functions";
import type { ExpressionNode } from "./tree";

const functions: FunctionRegistry = {
  needsText: (args) =>
    args[0]?.kind === "text"
      ? { kind: "boolean", value: true }
      : { wrongType: "needsText requires a text argument" },
  needsPositive: (args) =>
    args[0]?.kind === "number" && args[0].value > 0
      ? args[0]
      : { domainError: "needsPositive requires a number above zero" },
};

function callNode(fn: string): ExpressionNode {
  return {
    kind: "call",
    fn,
    args: [{ kind: "numberLiteral", value: -1 }],
  };
}

describe("a registered function that returns wrongType", () => {
  it("is a wrong-type indeterminate result carrying its message", async () => {
    const { evaluateValue } = createEvaluator({ functions });

    expect(
      await evaluateValue(callNode("needsText"), undefined, resolvers),
    ).toEqual({
      status: "indeterminate",
      reason: {
        code: "wrong-type",
        message: "needsText requires a text argument",
      },
    });
  });

  it("is the same result from the synchronous evaluator", () => {
    const { evaluateValue } = createSyncEvaluator({ functions });

    expect(
      evaluateValue(callNode("needsText"), undefined, {
        resolveValue: () => ({ found: false }),
        resolveLookup: () => ({ found: false }),
        resolveCollection: () => [],
      }),
    ).toMatchObject({ reason: { code: "wrong-type" } });
  });

  it("stays distinct from a domainError, which is still a domain-error", async () => {
    const { evaluateValue } = createEvaluator({ functions });

    expect(
      await evaluateValue(callNode("needsPositive"), undefined, resolvers),
    ).toEqual({
      status: "indeterminate",
      reason: {
        code: "domain-error",
        message: "needsPositive requires a number above zero",
      },
    });
  });
});
