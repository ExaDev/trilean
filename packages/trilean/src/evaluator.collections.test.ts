import { describe, expect, it } from "vitest";
import { evaluateValue } from "./evaluator-factory";
import type { Resolvers } from "./resolvers";
import {
  expectDefinite,
  expectIndeterminate,
  isPlainRecord,
  resolvers,
} from "./evaluator-test-helpers";

describe("lookup", () => {
  const lookupResolvers: Resolvers = {
    resolveValue: async (key) => {
      if (key === "region") {
        return Promise.resolve({
          found: true,
          value: { kind: "text", value: "north" },
        });
      }
      if (key === "tier") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value: 2 },
        });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async (table) =>
      Promise.resolve(
        table === "pricing"
          ? { found: true, value: { kind: "number", value: 42 } }
          : { found: false },
      ),
    resolveCollection: async () => Promise.resolve([]),
  };

  it("evaluates every key and passes its resolved value to resolveLookup, in declared order", async () => {
    const receivedKeys: unknown[] = [];
    const trackingResolvers: Resolvers = {
      ...lookupResolvers,
      resolveLookup: async (table, keys, context) => {
        receivedKeys.push(...keys);
        return lookupResolvers.resolveLookup(table, keys, context);
      },
    };
    const result = await evaluateValue(
      {
        kind: "lookup",
        table: "pricing",
        keys: [
          { kind: "reference", key: "region" },
          { kind: "reference", key: "tier" },
        ],
      },
      undefined,
      trackingResolvers,
    );
    expect(receivedKeys).toEqual([
      { kind: "text", value: "north" },
      { kind: "number", value: 2 },
    ]);
    expectDefinite(result, { kind: "number", value: 42 });
  });

  it("is not-found when the resolver reports no match", async () => {
    const result = await evaluateValue(
      {
        kind: "lookup",
        table: "unknown-table",
        keys: [{ kind: "reference", key: "region" }],
      },
      undefined,
      lookupResolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("resolves a boolean value with no schema change beyond the ComputedValue union itself -- lookup carries no kind restriction of its own", async () => {
    const booleanLookupResolvers: Resolvers = {
      ...lookupResolvers,
      resolveLookup: async (table, keys, context) =>
        table === "eligibility"
          ? Promise.resolve({
              found: true,
              value: { kind: "boolean", value: true },
            })
          : lookupResolvers.resolveLookup(table, keys, context),
    };
    const result = await evaluateValue(
      {
        kind: "lookup",
        table: "eligibility",
        keys: [{ kind: "reference", key: "region" }],
      },
      undefined,
      booleanLookupResolvers,
    );
    expectDefinite(result, { kind: "boolean", value: true });
  });
});

describe("fold", () => {
  const foldResolvers: Resolvers = {
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
    resolveCollection: async (collection) => {
      if (collection === "amounts") {
        return Promise.resolve([{ amount: 8 }, { amount: 12 }, { amount: 1 }]);
      }
      if (collection === "grouped") {
        return Promise.resolve([
          { group: "keep", amount: 5 },
          { group: "skip", amount: 999 },
        ]);
      }
      if (collection === "empty") return Promise.resolve([]);
      return Promise.resolve([]);
    },
  };

  describe("reduce", () => {
    it("sums participating items, threading the running total through accumulator", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "amounts",
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
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 21 });
    });

    it("filter narrows which items participate, exactly like some/every's own filter", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "grouped",
          filter: {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "group" },
            right: { kind: "textLiteral", value: "keep" },
          },
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
        undefined,
        foldResolvers,
      );
      // The excluded item's amount (999) never participates; only the kept item's 5 does.
      expectDefinite(result, { kind: "number", value: 5 });
    });

    it("over an empty (post-filter) collection evaluates to initial directly, without touching combine", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "empty",
          combiner: {
            mode: "reduce",
            initial: { kind: "numberLiteral", value: 7 },
            combine: { kind: "numberLiteral", value: 999 },
          },
        },
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 7 });
    });
  });

  describe("max, min", () => {
    it("max keeps the largest projected value seen", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "amounts",
          combiner: { mode: "max", item: { kind: "reference", key: "amount" } },
        },
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 12 });
    });

    it("min keeps the smallest projected value seen", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "amounts",
          combiner: { mode: "min", item: { kind: "reference", key: "amount" } },
        },
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 1 });
    });

    it("is domain-error over an empty (post-filter) collection -- there is no first item to seed from", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "empty",
          combiner: { mode: "max", item: { kind: "reference", key: "amount" } },
        },
        undefined,
        foldResolvers,
      );
      expectIndeterminate(result, "domain-error");
    });
  });
});

describe("accumulator", () => {
  it("is wrong-type when evaluated outside any fold's combine expression", async () => {
    const result = await evaluateValue(
      { kind: "accumulator" },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("resolves to the running value inside a reduce fold's own combine expression", async () => {
    // The collection has to genuinely resolve to items: over an empty one `combine` is never evaluated at all and the fold returns `initial` untouched, so an assertion against `initial`'s own value would hold whether or not `accumulator` resolved correctly. Stepping the accumulator once per item is what makes the expected value depend on it.
    const twoItemResolvers: Resolvers = {
      ...resolvers,
      resolveCollection: async () => Promise.resolve([{}, {}]),
    };
    const result = await evaluateValue(
      {
        kind: "fold",
        collection: "items",
        combiner: {
          mode: "reduce",
          initial: { kind: "numberLiteral", value: 5 },
          combine: {
            kind: "arithmetic",
            op: "add",
            left: { kind: "accumulator" },
            right: { kind: "numberLiteral", value: 1 },
          },
        },
      },
      undefined,
      twoItemResolvers,
    );
    expectDefinite(result, { kind: "number", value: 7 });
  });
});
