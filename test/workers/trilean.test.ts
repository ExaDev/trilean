import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "../../src/evaluator";
import {
  goldenExampleData,
  goldenExampleDataEmptyItems,
  goldenExampleDataMissingX,
  goldenExampleResolvers,
  goldenExampleTree,
} from "../../src/test-support/golden-example";
import type { PredicateNode } from "../../src/tree";
import type { Resolvers } from "../../src/resolvers";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

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

/**
 * Beyond the golden example's narrow AND + compare + reduce-fold path, this section runs a substantially broader composed tree -- allOf, anyOf, compare, textCompare, memberOf, some, every, fold (reduce), and conditional, all in one evaluation -- for real inside the same workerd isolate (adapted from test/integration/composed-rules.test.ts's own "membership eligibility" scenario), so the "isomorphic" guarantee is checked against genuinely more of the evaluator's surface, not only the one path the golden example covers. Duplicated inline, rather than imported from test/integration, to keep this file's dependency graph limited to src/ under the real workers runtime.
 */
describe("a substantially broader composed tree (allOf/anyOf/compare/textCompare/memberOf/some/every/fold/conditional) under workerd", () => {
  const approvedFilter: PredicateNode = {
    kind: "textCompare",
    op: "equals",
    left: { kind: "reference", key: "status" },
    right: { kind: "textLiteral", value: "approved" },
  };

  const eligibilityRule: PredicateNode = {
    kind: "allOf",
    operands: [
      {
        kind: "compare",
        op: "gte",
        left: { kind: "reference", key: "score" },
        right: { kind: "numberLiteral", value: 50 },
      },
      {
        kind: "textCompare",
        op: "matches",
        left: { kind: "reference", key: "status" },
        right: { kind: "textLiteral", value: "^active$" },
      },
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "tier" },
        candidates: [
          { kind: "textLiteral", value: "gold" },
          { kind: "textLiteral", value: "platinum" },
        ],
      },
      {
        kind: "some",
        collection: "orders",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 30 },
        },
      },
      {
        kind: "every",
        collection: "orders",
        filter: approvedFilter,
        item: {
          kind: "compare",
          op: "lte",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 1000 },
        },
      },
      {
        kind: "anyOf",
        operands: [
          {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "region" },
            right: { kind: "textLiteral", value: "north" },
          },
          {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "region" },
            right: { kind: "textLiteral", value: "south" },
          },
        ],
      },
      {
        kind: "compare",
        op: "gt",
        left: {
          kind: "fold",
          collection: "orders",
          filter: approvedFilter,
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
          kind: "conditional",
          cases: [
            {
              when: {
                kind: "textCompare",
                op: "equals",
                left: { kind: "reference", key: "tier" },
                right: { kind: "textLiteral", value: "platinum" },
              },
              then: { kind: "numberLiteral", value: 50 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 20 },
        },
      },
    ],
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
      if (
        collection === "orders" &&
        isPlainRecord(context) &&
        isUnknownArray(context.orders)
      ) {
        return Promise.resolve(context.orders);
      }
      return Promise.resolve([]);
    },
  };

  it("a gold-tier member meeting every condition is definitely eligible", async () => {
    const member = {
      score: 85,
      status: "active",
      tier: "gold",
      region: "north",
      orders: [
        { amount: 40, status: "approved" },
        { amount: 15, status: "approved" },
        { amount: 5, status: "declined" },
      ],
    };
    const result = await evaluatePredicate(eligibilityRule, member, resolvers);
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("a member with every other condition satisfied but a missing score is indeterminate, not silently eligible or ineligible", async () => {
    const member = {
      status: "active",
      tier: "gold",
      region: "south",
      orders: [{ amount: 100, status: "approved" }],
    };
    const result = await evaluatePredicate(eligibilityRule, member, resolvers);
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });
});

/**
 * Units-aware arithmetic (multiply/divide combining differently unit-tagged numbers) under workerd -- nothing else in this file exercises `Unit` dimensional-exponent combination at all.
 */
describe("units-aware arithmetic (multiply/divide across differently unit-tagged numbers) under workerd", () => {
  const densityExceedsThreshold: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: {
      kind: "arithmetic",
      op: "divide",
      left: { kind: "reference", key: "massKg", unit: { kg: 1 } },
      right: { kind: "reference", key: "volumeM3", unit: { m: 3 } },
    },
    right: { kind: "numberLiteral", value: 15, unit: { kg: 1, m: -3 } },
  };

  const unitByKey: Record<string, Record<string, number>> = {
    massKg: { kg: 1 },
    volumeM3: { m: 3 },
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
      if (typeof value !== "number") return Promise.resolve({ found: false });
      return Promise.resolve({
        found: true,
        value: { kind: "number", value, unit: unitByKey[key] },
      });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async () => Promise.resolve([]),
  };

  it("mass (kg) divided by volume (m^3) combines to kg/m^3, comparable against a matching compound-unit literal", async () => {
    const result = await evaluatePredicate(
      densityExceedsThreshold,
      { massKg: 20, volumeM3: 1 },
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });
});
