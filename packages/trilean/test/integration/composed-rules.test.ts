import { describe, expect, it } from "vitest";
import { evaluatePredicate, evaluateValue, implies } from "../../src/index";
import type {
  Evaluation,
  ExpressionNode,
  PredicateNode,
  Resolvers,
} from "../../src/index";

/**
 * Substantial, multi-kind composed trees exercised through the public evaluator entry points against realistic, resolver-backed, multi-record in-memory datasets -- proving node kinds genuinely cooperate as a system, catching interaction bugs a single-kind unit test can never reach (see src/*.test.ts for the exhaustive per-kind coverage this tier builds on top of).
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function expectDefinite<T>(evaluation: Evaluation<T>, expected: T): void {
  expect(evaluation).toEqual({ status: "definite", value: expected });
}

function expectIndeterminate<T>(
  evaluation: Evaluation<T>,
  code: "not-found" | "wrong-type" | "domain-error",
): void {
  expect(evaluation.status).toBe("indeterminate");
  if (evaluation.status === "indeterminate") {
    expect(evaluation.reason.code).toBe(code);
  }
}

describe("membership eligibility (allOf, anyOf, compare, textCompare, memberOf, some, every, fold, conditional)", () => {
  const approvedFilter: PredicateNode = {
    kind: "textCompare",
    op: "equals",
    left: { kind: "reference", key: "status" },
    right: { kind: "textLiteral", value: "approved" },
  };

  const approvedOrderTotal: ExpressionNode = {
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
  };

  const tierThreshold: ExpressionNode = {
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
        left: approvedOrderTotal,
        right: tierThreshold,
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
    expectDefinite(result, true);
  });

  it("a platinum-tier member outside the served regions is definitely ineligible, regardless of the platinum-only spend threshold", async () => {
    const member = {
      score: 60,
      status: "active",
      tier: "platinum",
      region: "east",
      orders: [{ amount: 10, status: "approved" }],
    };
    const result = await evaluatePredicate(eligibilityRule, member, resolvers);
    expectDefinite(result, false);
  });

  it("a member with every other condition satisfied but a missing score is indeterminate, not silently eligible or ineligible", async () => {
    const member = {
      status: "active",
      tier: "gold",
      region: "south",
      orders: [{ amount: 100, status: "approved" }],
    };
    const result = await evaluatePredicate(eligibilityRule, member, resolvers);
    expectIndeterminate(result, "not-found");
  });
});

describe("units-aware rate calculation (multiply/divide across differently unit-tagged numbers, fold, compare)", () => {
  const unitByKey: Record<string, Record<string, number>> = {
    weightKg: { kg: 1 },
    volumeM3: { m: 3 },
    pricePerKgUSD: { kg: -1 },
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
    resolveCollection: async (collection, context) => {
      if (
        collection === "parcels" &&
        isPlainRecord(context) &&
        isUnknownArray(context.parcels)
      ) {
        return Promise.resolve(context.parcels);
      }
      return Promise.resolve([]);
    },
  };

  const totalWeight: ExpressionNode = {
    kind: "fold",
    collection: "parcels",
    combiner: {
      mode: "reduce",
      initial: { kind: "numberLiteral", value: 0, unit: { kg: 1 } },
      combine: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "accumulator" },
        right: { kind: "reference", key: "weightKg", unit: { kg: 1 } },
      },
    },
  };

  const totalVolume: ExpressionNode = {
    kind: "fold",
    collection: "parcels",
    combiner: {
      mode: "reduce",
      initial: { kind: "numberLiteral", value: 0, unit: { m: 3 } },
      combine: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "accumulator" },
        right: { kind: "reference", key: "volumeM3", unit: { m: 3 } },
      },
    },
  };

  const density: ExpressionNode = {
    kind: "arithmetic",
    op: "divide",
    left: totalWeight,
    right: totalVolume,
  };

  const totalCost: ExpressionNode = {
    kind: "arithmetic",
    op: "multiply",
    left: { kind: "reference", key: "pricePerKgUSD", unit: { kg: -1 } },
    right: totalWeight,
  };

  const shipmentMeetsDensityAndCostThresholds: PredicateNode = {
    kind: "and",
    left: {
      kind: "compare",
      op: "gt",
      left: density,
      right: { kind: "numberLiteral", value: 15, unit: { kg: 1, m: -3 } },
    },
    right: {
      kind: "compare",
      op: "gt",
      left: totalCost,
      right: { kind: "numberLiteral", value: 50 },
    },
  };

  it("density (kg/m^3, via divide) and cost (dimensionless, via multiply) both derive correctly from the same fold-summed weight", async () => {
    const shipment = {
      pricePerKgUSD: 3,
      parcels: [
        { weightKg: 10, volumeM3: 0.5 },
        { weightKg: 6, volumeM3: 0.25 },
        { weightKg: 4, volumeM3: 0.25 },
      ],
    };
    // totalWeight = 20kg, totalVolume = 1m^3, density = 20kg/m^3 (> 15 threshold); totalCost = 3 * 20 = 60 (> 50 threshold).
    const result = await evaluatePredicate(
      shipmentMeetsDensityAndCostThresholds,
      shipment,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("a parcel whose weight resolves in an incompatible unit makes the whole fold -- and everything derived from it -- indeterminate rather than silently miscalculating", async () => {
    const mismatchedResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async (key, context) => {
        if (
          key === "weightKg" &&
          isPlainRecord(context) &&
          context.badUnit === true
        ) {
          const raw = context.weightKg;
          if (typeof raw !== "number") return Promise.resolve({ found: false });
          return Promise.resolve({
            found: true,
            value: { kind: "number", value: raw, unit: { g: 1 } },
          });
        }
        return resolvers.resolveValue(key, context);
      },
    };
    const shipment = {
      pricePerKgUSD: 3,
      parcels: [
        { weightKg: 10, volumeM3: 0.5, badUnit: true },
        { weightKg: 6, volumeM3: 0.25 },
      ],
    };
    const result = await evaluatePredicate(
      shipmentMeetsDensityAndCostThresholds,
      shipment,
      mismatchedResolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

describe("temporal arithmetic with a quantifier and a conditional fallback (instant/duration, some, conditional)", () => {
  const sessionResolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (
        !isPlainRecord(context) ||
        typeof key !== "string" ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      if (typeof value !== "string") return Promise.resolve({ found: false });
      return Promise.resolve({
        found: true,
        value: { kind: "instant", value },
      });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection, context) => {
      if (
        collection === "sessions" &&
        isPlainRecord(context) &&
        isUnknownArray(context.sessions)
      ) {
        return Promise.resolve(context.sessions);
      }
      return Promise.resolve([]);
    },
  };

  const sessionLongerThanThreshold: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: {
      kind: "arithmetic",
      op: "subtract",
      left: { kind: "reference", key: "endedAt" },
      right: { kind: "reference", key: "startedAt" },
    },
    right: { kind: "durationLiteral", value: 30, unit: "min" },
  };

  const flagIfAnySessionRunsLong: ExpressionNode = {
    kind: "conditional",
    cases: [
      {
        when: {
          kind: "some",
          collection: "sessions",
          item: sessionLongerThanThreshold,
        },
        then: { kind: "textLiteral", value: "flagged" },
      },
    ],
    fallback: { kind: "textLiteral", value: "ok" },
  };

  it("a session that exceeds the duration threshold -> 'flagged', via instant subtraction producing a duration compared against a durationLiteral in a different unit", async () => {
    const account = {
      sessions: [
        {
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:45:00.000Z",
        },
        {
          startedAt: "2026-01-01T01:00:00.000Z",
          endedAt: "2026-01-01T01:10:00.000Z",
        },
      ],
    };
    const result = await evaluateValue(
      flagIfAnySessionRunsLong,
      account,
      sessionResolvers,
    );
    expectDefinite(result, { kind: "text", value: "flagged" });
  });

  it("no session exceeds the threshold -> the conditional's fallback, 'ok'", async () => {
    const account = {
      sessions: [
        {
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:10:00.000Z",
        },
      ],
    };
    const result = await evaluateValue(
      flagIfAnySessionRunsLong,
      account,
      sessionResolvers,
    );
    expectDefinite(result, { kind: "text", value: "ok" });
  });

  it("every session's timestamp is unparseable -> the quantifier itself is indeterminate, and the conditional does not skip past its own unresolved guard to reach the fallback", async () => {
    const account = {
      sessions: [
        { startedAt: "not-a-timestamp", endedAt: "2026-01-01T00:45:00.000Z" },
        {
          startedAt: "also-not-a-timestamp",
          endedAt: "2026-01-01T01:10:00.000Z",
        },
      ],
    };
    const result = await evaluateValue(
      flagIfAnySessionRunsLong,
      account,
      sessionResolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

describe("fold's max combiner alongside memberOf and a derived connective (implies)", () => {
  const bidResolvers: Resolvers = {
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
      return Promise.resolve({ found: true, value: { kind: "number", value } });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection, context) => {
      if (
        collection === "bids" &&
        isPlainRecord(context) &&
        isUnknownArray(context.bids)
      ) {
        return Promise.resolve(context.bids);
      }
      return Promise.resolve([]);
    },
  };

  const highestBid: ExpressionNode = {
    kind: "fold",
    collection: "bids",
    combiner: { mode: "max", item: { kind: "reference", key: "amount" } },
  };

  const highestBidIsPreApproved: PredicateNode = {
    kind: "memberOf",
    op: "in",
    operand: highestBid,
    candidates: [
      { kind: "numberLiteral", value: 100 },
      { kind: "numberLiteral", value: 120 },
      { kind: "numberLiteral", value: 140 },
    ],
  };

  const highBidRequiresDiscountApproval: PredicateNode = implies(
    {
      kind: "compare",
      op: "gt",
      left: highestBid,
      right: { kind: "numberLiteral", value: 130 },
    },
    {
      kind: "compare",
      op: "eq",
      left: { kind: "reference", key: "discountFlag" },
      right: { kind: "numberLiteral", value: 1 },
    },
  );

  const auctionRule: PredicateNode = {
    kind: "allOf",
    operands: [highestBidIsPreApproved, highBidRequiresDiscountApproval],
  };

  it("the winning bid is pre-approved and its discount is authorised -> definitely eligible", async () => {
    const auction = {
      bids: [{ amount: 120 }, { amount: 95 }, { amount: 140 }],
      discountFlag: 1,
    };
    const result = await evaluatePredicate(auctionRule, auction, bidResolvers);
    expectDefinite(result, true);
  });

  it("a low winning bid makes the discount clause vacuously true even with no discountFlag at all -- implies absorbs the missing consequent", async () => {
    const auction = { bids: [{ amount: 100 }, { amount: 90 }] };
    const result = await evaluatePredicate(auctionRule, auction, bidResolvers);
    expectDefinite(result, true);
  });

  it("a winning bid outside the pre-approved tiers is definitely ineligible, even though the discount clause itself resolves true", async () => {
    const auction = { bids: [{ amount: 133 }], discountFlag: 1 };
    const result = await evaluatePredicate(auctionRule, auction, bidResolvers);
    expectDefinite(result, false);
  });

  it("an empty bid list has no first item to seed fold's max from -- domain-error propagates through memberOf and is not rescued by the unrelated implies clause resolving true", async () => {
    const auction = { bids: [], discountFlag: 1 };
    const result = await evaluatePredicate(auctionRule, auction, bidResolvers);
    expectIndeterminate(result, "domain-error");
  });
});
