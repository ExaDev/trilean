import type { Resolvers } from "../resolvers";
import type { PredicateNode } from "../tree";

/** Narrows an opaque `EvaluationContext` to a plain, non-array object -- this repo's `object -> Record<string, unknown>` narrowing convention, never an `as Record<string, unknown>` assertion. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray`'s own lib.es5.d.ts type predicate narrows to `any[]`, not `unknown[]` -- this re-typed wrapper is what lets `resolveCollection` below return a properly `unknown[]`-typed result instead of an implicit `any[]`. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * The exact worked example from README.md's "Worked example" section: `isActive` equals `1` AND `sum(items.amount)` -- the literal `fold` tree the `sum` derived-aggregate builder assembles -- is greater than `x + y`. Exported here, rather than defined separately in each consuming test file, so the unit-project gate (src/golden-examples.test.ts) and the Cloudflare Workers re-run (test/workers/trilean.test.ts) share one byte-identical fixture and can never silently drift apart.
 */
export const goldenExampleTree: PredicateNode = {
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

/** README.md's minimal resolver set for this example: `resolveValue` looks up a top-level key on the context record, `resolveCollection` returns `items` verbatim (or `[]` for any other collection reference), and `resolveLookup` is unused by this example and always reports not-found. */
export const goldenExampleResolvers: Resolvers = {
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
  resolveLookup: async () => Promise.resolve({ found: false }), // unused by this example
  resolveCollection: async (collection, context) => {
    if (collection !== "items" || !isPlainRecord(context)) {
      return Promise.resolve([]);
    }
    const items = context.items;
    return Promise.resolve(isUnknownArray(items) ? items : []);
  },
};

/** Base-case backing data, exactly as given in README.md's "Worked example" section. */
export const goldenExampleData = {
  isActive: 1,
  x: 10,
  y: 5,
  items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
};

/** Variation 1: `items` resolves to `[]` -- the `sum`-over-empty identity (`0`) is not greater than `x + y`, feeding through to `and`'s own absorbing `false`. Typed via an explicit variable annotation, rather than an `as unknown[]` assertion on the empty array literal, so `items` is `unknown[]` without a cast. */
export const goldenExampleDataEmptyItems: {
  isActive: number;
  x: number;
  y: number;
  items: unknown[];
} = {
  isActive: 1,
  x: 10,
  y: 5,
  items: [],
};

/** Variation 2: `x` is missing from the data. `and` has no rescuing value on this side: the left operand (`isActive eq 1`) is definitely `true`, not `false`, so it cannot absorb the right operand's indeterminacy the way variation 1's `false` does above. */
export const goldenExampleDataMissingX = {
  isActive: 1,
  y: 5,
  items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
};
