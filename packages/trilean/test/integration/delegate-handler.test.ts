import { describe, expect, it } from "vitest";
import { evaluatePredicate, evaluateValue } from "../../src/index";
import type { ExpressionNode, PredicateNode, Resolvers } from "../../src/index";

/**
 * A `delegate` node stands in for a whole subtree without this package attempting to evaluate it itself (see the `delegate` section of README.md). These scenarios wire a realistic `resolveDelegate` handler -- an in-memory stand-in for an external rate-lookup service, not a bare stub -- into a larger composed tree, proving a delegate's resolved value flows correctly into surrounding arithmetic, a conditional branch, and (in the second scenario) a fold aggregation, rather than only being exercised as a standalone leaf.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

describe("delegate result flows through arithmetic and a conditional's fallback branch, into a comparison", () => {
  const taxRatesByRegion: Record<string, number> = {
    international: 0.2,
    remote: 0.15,
  };

  const resolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (
        !isPlainRecord(context) ||
        typeof key !== "string" ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      if (typeof value === "number") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value },
        });
      }
      if (typeof value === "string") {
        return Promise.resolve({ found: true, value: { kind: "text", value } });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async () => Promise.resolve([]),
    // Not a bare stub: this mirrors what a real "call out to an external tax-rate service" handler looks like -- the opaque `payload` names which ruleset to apply, and the live `context` supplies the region the rate actually depends on.
    resolveDelegate: async (system, _payload, context) => {
      if (
        system !== "taxEngine" ||
        !isPlainRecord(context) ||
        typeof context.region !== "string"
      ) {
        return Promise.resolve({ found: false });
      }
      const rate = taxRatesByRegion[context.region];
      return Promise.resolve(
        rate === undefined
          ? { found: false }
          : { found: true, value: { kind: "number", value: rate } },
      );
    },
  };

  const taxRate: ExpressionNode = {
    kind: "conditional",
    cases: [
      {
        when: {
          kind: "textCompare",
          op: "equals",
          left: { kind: "reference", key: "region" },
          right: { kind: "textLiteral", value: "domestic" },
        },
        then: { kind: "numberLiteral", value: 0.1 },
      },
    ],
    fallback: {
      kind: "delegate",
      system: "taxEngine",
      payload: { ruleset: "standard" },
    },
  };

  const totalWithTax: ExpressionNode = {
    kind: "arithmetic",
    op: "multiply",
    left: { kind: "reference", key: "subtotal" },
    right: {
      kind: "arithmetic",
      op: "add",
      left: { kind: "numberLiteral", value: 1 },
      right: taxRate,
    },
  };

  const exceedsThreshold: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: totalWithTax,
    right: { kind: "numberLiteral", value: 1100 },
  };

  it("a non-domestic region falls through the conditional to the delegate, and the resolved rate crosses the threshold", async () => {
    const result = await evaluatePredicate(
      exceedsThreshold,
      { subtotal: 1000, region: "international" },
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("a domestic region takes the conditional's own branch instead -- the delegate is never invoked, and the lower fixed rate stays under the threshold", async () => {
    const result = await evaluatePredicate(
      exceedsThreshold,
      { subtotal: 1000, region: "domestic" },
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });

  it("a region the delegate handler has no rate for is indeterminate, not silently treated as a zero rate", async () => {
    const result = await evaluatePredicate(
      exceedsThreshold,
      { subtotal: 1000, region: "unmapped" },
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });
});

describe("delegate result feeds into a fold aggregation, resolved per participating item", () => {
  const categoryRates: Record<string, number> = {
    standard: 0.05,
    premium: 0.15,
  };

  const resolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (
        !isPlainRecord(context) ||
        typeof key !== "string" ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      if (typeof value === "number") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value },
        });
      }
      if (typeof value === "string") {
        return Promise.resolve({ found: true, value: { kind: "text", value } });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection, context) => {
      if (collection !== "lineItems" || !isPlainRecord(context)) {
        return Promise.resolve([]);
      }
      const items = context.lineItems;
      return Promise.resolve(isUnknownArray(items) ? items : []);
    },
    // Resolved per participating item -- each fold step's own context is the line item itself (see the fold/reduce section of README.md), so this handler reads the item's own `category` rather than anything from the outer order.
    resolveDelegate: async (system, _payload, context) => {
      if (
        system !== "categoryMarkup" ||
        !isPlainRecord(context) ||
        typeof context.category !== "string"
      ) {
        return Promise.resolve({ found: false });
      }
      const rate = categoryRates[context.category];
      return Promise.resolve(
        rate === undefined
          ? { found: false }
          : { found: true, value: { kind: "number", value: rate } },
      );
    },
  };

  const markedUpTotal: ExpressionNode = {
    kind: "fold",
    collection: "lineItems",
    combiner: {
      mode: "reduce",
      initial: { kind: "numberLiteral", value: 0 },
      combine: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "accumulator" },
        right: {
          kind: "arithmetic",
          op: "multiply",
          left: { kind: "reference", key: "amount" },
          right: {
            kind: "arithmetic",
            op: "add",
            left: { kind: "numberLiteral", value: 1 },
            right: {
              kind: "delegate",
              system: "categoryMarkup",
              payload: {},
            },
          },
        },
      },
    },
  };

  it("every participating item's markup is resolved by delegate and accumulated into one total", async () => {
    const order = {
      lineItems: [
        { amount: 100, category: "standard" },
        { amount: 50, category: "premium" },
        { amount: 20, category: "standard" },
      ],
    };
    const result = await evaluateValue(markedUpTotal, order, resolvers);
    expect(result).toEqual({
      status: "definite",
      value: { kind: "number", value: 183.5 },
    });
  });

  it("one item with a category the delegate cannot rate makes the whole fold indeterminate -- unlike a quantifier, reduce has no absorbing value to rescue it", async () => {
    const order = {
      lineItems: [
        { amount: 100, category: "standard" },
        { amount: 10, category: "unmapped" },
      ],
    };
    const result = await evaluateValue(markedUpTotal, order, resolvers);
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });
});
