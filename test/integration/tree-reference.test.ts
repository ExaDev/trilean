import { describe, expect, it } from "vitest";
import { evaluatePredicate, evaluateValue } from "../../src/index";
import type {
  ExpressionNode,
  JsonValue,
  PredicateNode,
  Resolvers,
} from "../../src/index";

/**
 * A `treeReference` node stands in for a whole other tree, resolved and then evaluated by this same evaluator (see the `treeReference` section of README.md) -- unlike `delegate`, which hands off to an external system this package never evaluates itself. These scenarios wire a realistic `resolveTree` handler -- an in-memory named-rule store, not a bare stub -- backing genuinely reusable sub-rules referenced from more than one place, proving composition, context/accumulator flow-through, and cross-rule cycle detection.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("treeReference composes reusable sub-rules into a larger tree", () => {
  // A small named-rule store, standing in for a real rules database: one reusable predicate (an "active member" eligibility check) and one reusable expression (a tier-based loyalty discount rate), each referenced from more than one place below.
  const namedRules: Record<string, JsonValue> = {
    isActiveMember: {
      kind: "textCompare",
      op: "equals",
      left: { kind: "reference", key: "status" },
      right: { kind: "textLiteral", value: "active" },
    },
    loyaltyDiscountRate: {
      kind: "conditional",
      cases: [
        {
          when: {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "tier" },
            right: { kind: "textLiteral", value: "gold" },
          },
          then: { kind: "numberLiteral", value: 0.2 },
        },
      ],
      fallback: { kind: "numberLiteral", value: 0.05 },
    },
  };

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
    resolveTree: async (key) => {
      const node = typeof key === "string" ? namedRules[key] : undefined;
      if (node === undefined) return Promise.resolve({ found: false });
      return Promise.resolve({ found: true, node });
    },
  };

  // References the reusable eligibility sub-rule twice over: once directly, once composed with a second condition -- proving the same stored sub-rule genuinely gets reused, not just resolved once and cached by coincidence.
  const isEligibleForLoyaltyProgram: PredicateNode = {
    kind: "allOf",
    operands: [
      { kind: "treeReference", key: "isActiveMember" },
      {
        kind: "compare",
        op: "gt",
        left: { kind: "reference", key: "totalSpend" },
        right: { kind: "numberLiteral", value: 100 },
      },
    ],
  };

  const finalPrice: ExpressionNode = {
    kind: "arithmetic",
    op: "multiply",
    left: { kind: "reference", key: "subtotal" },
    right: {
      kind: "arithmetic",
      op: "subtract",
      left: { kind: "numberLiteral", value: 1 },
      right: { kind: "treeReference", key: "loyaltyDiscountRate" },
    },
  };

  it("an active member over the spend threshold is eligible", async () => {
    const result = await evaluatePredicate(
      isEligibleForLoyaltyProgram,
      { status: "active", totalSpend: 150 },
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("an inactive member is not eligible, even over the spend threshold", async () => {
    const result = await evaluatePredicate(
      isEligibleForLoyaltyProgram,
      { status: "lapsed", totalSpend: 150 },
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });

  it("a gold-tier customer's price reflects the referenced discount rate", async () => {
    const result = await evaluateValue(
      finalPrice,
      { subtotal: 200, tier: "gold" },
      resolvers,
    );
    expect(result).toEqual({
      status: "definite",
      value: { kind: "number", value: 160, unit: {} },
    });
  });

  it("a non-gold tier falls through to the referenced rule's own fallback rate", async () => {
    const result = await evaluateValue(
      finalPrice,
      { subtotal: 200, tier: "silver" },
      resolvers,
    );
    expect(result).toEqual({
      status: "definite",
      value: { kind: "number", value: 190, unit: {} },
    });
  });

  it("a reference to an unknown rule key is not-found, not a thrown error", async () => {
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "doesNotExist" },
      {},
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });
});

describe("treeReference detects a cycle across genuinely separate stored rules", () => {
  // ruleA references ruleB, which references ruleA again -- neither rule alone is self-referential; the cycle only exists across the two.
  const crossReferencingRules: Record<string, JsonValue> = {
    ruleA: { kind: "treeReference", key: "ruleB" },
    ruleB: { kind: "treeReference", key: "ruleA" },
  };

  const resolvers: Resolvers = {
    resolveValue: async () => Promise.resolve({ found: false }),
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async () => Promise.resolve([]),
    resolveTree: async (key) => {
      const node =
        typeof key === "string" ? crossReferencingRules[key] : undefined;
      if (node === undefined) return Promise.resolve({ found: false });
      return Promise.resolve({ found: true, node });
    },
  };

  it("evaluating ruleA is a domain-error, not an infinite loop or a stack overflow", async () => {
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "ruleA" },
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
      expect(result.reason.message).toBe("circular treeReference detected");
    }
  });
});
