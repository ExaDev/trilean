import { describe, expect, it } from "vitest";
import { average, count, sum } from "./derived-aggregates";
import { evaluateValue } from "./evaluator";
import type { Evaluation } from "./evaluation";
import type { ComputedValue } from "./computed-value";
import type { ExpressionNode, PredicateNode } from "./tree";
import type { Resolvers } from "./resolvers";

/**
 * `sum`/`count`/`average` never appear as their own `FoldCombiner` mode (see derived-aggregates.ts) -- every test below runs the builder's output through the genuine public `evaluateValue` entry point, exactly as if the builder were an opaque black box.
 */

function expectDefinite(
  evaluation: Evaluation<ComputedValue>,
  expected: ComputedValue,
): void {
  expect(evaluation).toEqual({ status: "definite", value: expected });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const itemsCollection = [{ amount: 1 }, { amount: 2 }, { amount: 3 }];
/** The second item deliberately has no `code` field, distinguishing a `filter`'s silent exclusion (see `count`'s "excluded" test below) from a `probe`'s indeterminate surfacing (see `count`'s "unresolvable" test below). */
const mixedCodeCollection = [{ amount: 1, code: "x" }, { amount: 2 }];

const resolvers: Resolvers = {
  resolveValue: async (key, context) => {
    if (
      typeof key !== "string" ||
      !isPlainRecord(context) ||
      !(key in context)
    ) {
      return Promise.resolve({ found: false });
    }
    const value = context[key];
    if (typeof value === "number") {
      return Promise.resolve({ found: true, value: { kind: "number", value } });
    }
    if (typeof value === "string") {
      return Promise.resolve({ found: true, value: { kind: "text", value } });
    }
    return Promise.resolve({ found: false });
  },
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async (collection) => {
    if (collection === "items") return Promise.resolve(itemsCollection);
    if (collection === "mixedCode") return Promise.resolve(mixedCodeCollection);
    return Promise.resolve([]); // "empty", and anything else unrecognised
  },
};

const amountRef: ExpressionNode = { kind: "reference", key: "amount" };
const codeRef: ExpressionNode = { kind: "reference", key: "code" };
const amountAboveOne: PredicateNode = {
  kind: "compare",
  op: "gt",
  left: amountRef,
  right: { kind: "numberLiteral", value: 1 },
};
const hasCode: PredicateNode = { kind: "exists", operand: codeRef };

describe("sum", () => {
  it("aggregates every participating item's projected value", async () => {
    const result = await evaluateValue(
      sum("items", amountRef),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 6 });
  });

  it("a filter excludes an item from the total, exactly as if it had never been in the collection", async () => {
    const result = await evaluateValue(
      sum("items", amountRef, amountAboveOne),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 5 });
  });

  it("over an empty collection, the reduce seed (0) is the identity -- no combine step is ever reached", async () => {
    const result = await evaluateValue(
      sum("empty", amountRef),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 0 });
  });
});

describe("count", () => {
  it("counts every participating item when no probe is supplied", async () => {
    const result = await evaluateValue(count("items"), undefined, resolvers);
    expectDefinite(result, { kind: "number", value: 3 });
  });

  it("a filter excludes an item silently -- the count reflects only what remains, with no indeterminacy", async () => {
    const result = await evaluateValue(
      count("items", amountAboveOne),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 2 });
  });

  it("over an empty collection, count is 0", async () => {
    const result = await evaluateValue(count("empty"), undefined, resolvers);
    expectDefinite(result, { kind: "number", value: 0 });
  });

  it("a probe that fails to resolve for a participating item makes the whole count indeterminate, unlike a filter's silent exclusion", async () => {
    const result = await evaluateValue(
      count("mixedCode", undefined, codeRef),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });

  it("the same item excluded by a filter never reaches the probe at all, so the count stays definite", async () => {
    const result = await evaluateValue(
      count("mixedCode", hasCode, codeRef),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 1 });
  });
});

describe("average", () => {
  it("is sum divided by count over the same collection", async () => {
    const result = await evaluateValue(
      average("items", amountRef),
      undefined,
      resolvers,
    );
    // divide's own unit-combination rule always produces a real (possibly empty) unit map, never `undefined` -- see combineUnitsForDivide in computed-value.ts.
    expectDefinite(result, { kind: "number", value: 2, unit: {} });
  });

  it("over an empty collection, division by count's own 0 is domain-error", async () => {
    const result = await evaluateValue(
      average("empty", amountRef),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
    }
  });
});
