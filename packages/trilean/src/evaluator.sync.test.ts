import { describe, expect, it } from "vitest";
import type { ComputedValue } from "./computed-value";
import { createEvaluator, createSyncEvaluator } from "./evaluator-factory";
import type { Resolution, Resolvers, SyncResolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function toComputed(value: unknown): Resolution {
  if (typeof value === "number") {
    return { found: true, value: { kind: "number", value } };
  }
  if (typeof value === "string") {
    return { found: true, value: { kind: "text", value } };
  }
  if (typeof value === "boolean") {
    return { found: true, value: { kind: "boolean", value } };
  }
  return { found: false };
}

const trees: Record<string, PredicateNode> = {
  storedTree: {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "a" },
    right: { kind: "numberLiteral", value: 1 },
  },
};

/** Resolvers over a plain object context, used as the single source of truth for both flavours. */
const syncResolvers: SyncResolvers = {
  resolveValue: (key, context) =>
    typeof key === "string" && isPlainRecord(context)
      ? toComputed(context[key])
      : { found: false },
  resolveLookup: (table, keys) => {
    const [first] = keys;
    if (table === "doubling" && first?.kind === "number") {
      return { found: true, value: { kind: "number", value: first.value * 2 } };
    }
    return { found: false };
  },
  resolveCollection: (collection, context) => {
    if (typeof collection !== "string" || !isPlainRecord(context)) return [];
    const items = context[collection];
    return isUnknownArray(items) ? items : [];
  },
  resolveDelegate: (system, payload) =>
    system === "flag" ? toComputed(payload) : { found: false },
  resolveTree: (key) =>
    typeof key === "string" && key in trees
      ? { found: true, node: trees[key] ?? null }
      : { found: false },
};

/** The same behaviour, delivered through promises, so a mismatch can only come from the evaluator. */
const asyncResolvers: Resolvers = {
  resolveValue: async (key, context) =>
    Promise.resolve(syncResolvers.resolveValue(key, context)),
  resolveLookup: async (table, keys, context) =>
    Promise.resolve(syncResolvers.resolveLookup(table, keys, context)),
  resolveCollection: async (collection, context) =>
    Promise.resolve(syncResolvers.resolveCollection(collection, context)),
  resolveDelegate: async (system, payload, context) =>
    Promise.resolve(
      syncResolvers.resolveDelegate?.(system, payload, context) ?? {
        found: false,
      },
    ),
  resolveTree: async (key, context) =>
    Promise.resolve(
      syncResolvers.resolveTree?.(key, context) ?? { found: false },
    ),
};

const functions = {
  double: (args: readonly ComputedValue[]) => {
    const [first] = args;
    return first?.kind === "number"
      ? { kind: "number" as const, value: first.value * 2 }
      : { domainError: "double takes a number" };
  },
};

const numbers = {
  nNeg9: { kind: "numberLiteral", value: -9 },
  n0: { kind: "numberLiteral", value: 0 },
  n1: { kind: "numberLiteral", value: 1 },
  n2: { kind: "numberLiteral", value: 2 },
  n3: { kind: "numberLiteral", value: 3 },
  n8: { kind: "numberLiteral", value: 8 },
  n9: { kind: "numberLiteral", value: 9 },
  n13: { kind: "numberLiteral", value: 13 },
  n50: { kind: "numberLiteral", value: 50 },
  n100: { kind: "numberLiteral", value: 100 },
  n200: { kind: "numberLiteral", value: 200 },
} satisfies Record<string, ExpressionNode>;
const ref = (key: string): ExpressionNode => ({ kind: "reference", key });
const gt = (left: ExpressionNode, right: ExpressionNode): PredicateNode => ({
  kind: "compare",
  op: "gt",
  left,
  right,
});

const context = {
  a: 5,
  b: 2,
  name: "widget",
  on: true,
  items: [{ n: 1 }, { n: 4 }, { n: 9 }],
  empty: [],
};

/** One tree per node kind or evaluation strategy, each with data that resolves and data that does not. */
const predicateCases: Record<string, PredicateNode> = {
  not: { kind: "not", operand: gt(ref("a"), numbers.n1) },
  and: {
    kind: "and",
    left: gt(ref("a"), numbers.n1),
    right: gt(ref("b"), numbers.n1),
  },
  andWithMissing: {
    kind: "and",
    left: gt(ref("a"), numbers.n1),
    right: gt(ref("missing"), numbers.n1),
  },
  or: {
    kind: "or",
    left: gt(ref("missing"), numbers.n1),
    right: gt(ref("a"), numbers.n1),
  },
  allOf: {
    kind: "allOf",
    operands: [gt(ref("a"), numbers.n1), gt(ref("b"), numbers.n9)],
  },
  anyOf: {
    kind: "anyOf",
    operands: [gt(ref("b"), numbers.n9), gt(ref("a"), numbers.n1)],
  },
  textCompare: {
    kind: "textCompare",
    op: "matches",
    left: ref("name"),
    right: { kind: "textLiteral", value: "^wid.*t$" },
  },
  memberOf: {
    kind: "memberOf",
    op: "in",
    operand: ref("a"),
    candidates: [numbers.n1, ref("a"), ref("missing")],
  },
  memberOfNoMatch: {
    kind: "memberOf",
    op: "notIn",
    operand: ref("a"),
    candidates: [numbers.n1, numbers.n2],
  },
  exists: { kind: "exists", operand: ref("missing") },
  some: { kind: "some", collection: "items", item: gt(ref("n"), numbers.n8) },
  everyWithFilter: {
    kind: "every",
    collection: "items",
    filter: gt(ref("n"), numbers.n1),
    item: gt(ref("n"), numbers.n3),
  },
  everyOverEmpty: {
    kind: "every",
    collection: "empty",
    item: gt(ref("n"), numbers.n3),
  },
  treeReference: { kind: "treeReference", key: "storedTree" },
  treeReferenceMissing: { kind: "treeReference", key: "absent" },
  delegateInCompare: {
    kind: "compare",
    op: "eq",
    left: { kind: "delegate", system: "flag", payload: true },
    right: { kind: "booleanLiteral", value: true },
  },
  callInCompare: gt(
    { kind: "call", fn: "double", args: [ref("a")] },
    numbers.n9,
  ),
  lookupInCompare: gt(
    { kind: "lookup", table: "doubling", keys: [ref("b")] },
    numbers.n3,
  ),
  conditionalFirst: gt(
    {
      kind: "conditional",
      cases: [
        { when: gt(ref("missing"), numbers.n0), then: numbers.n1 },
        { when: gt(ref("a"), numbers.n0), then: numbers.n100 },
      ],
      fallback: numbers.n0,
    },
    numbers.n50,
  ),
  conditionalUnique: gt(
    {
      kind: "conditional",
      hitPolicy: "unique",
      cases: [
        { when: gt(ref("a"), numbers.n0), then: numbers.n100 },
        { when: gt(ref("b"), numbers.n0), then: numbers.n200 },
      ],
      fallback: numbers.n0,
    },
    numbers.n50,
  ),
  foldReduce: gt(
    {
      kind: "fold",
      collection: "items",
      combiner: {
        mode: "reduce",
        initial: numbers.n0,
        combine: {
          kind: "arithmetic",
          op: "add",
          left: { kind: "accumulator" },
          right: ref("n"),
        },
      },
    },
    numbers.n13,
  ),
  foldMax: gt(
    {
      kind: "fold",
      collection: "items",
      combiner: { mode: "max", item: ref("n") },
    },
    numbers.n8,
  ),
  foldMinOverEmpty: gt(
    {
      kind: "fold",
      collection: "empty",
      combiner: { mode: "min", item: ref("n") },
    },
    numbers.n0,
  ),
  negate: gt({ kind: "negate", operand: ref("a") }, numbers.nNeg9),
};

describe("createSyncEvaluator", () => {
  const sync = createSyncEvaluator({ functions });
  const async = createEvaluator({ functions });

  it.each(Object.entries(predicateCases))(
    "evaluates %s exactly as the asynchronous evaluator does",
    async (_name, tree) => {
      const expected = await async.evaluatePredicate(
        tree,
        context,
        asyncResolvers,
      );
      expect(sync.evaluatePredicate(tree, context, syncResolvers)).toEqual(
        expected,
      );
    },
  );

  it("gives definite and indeterminate results across the cases above, so the comparison is not vacuous", () => {
    const statuses = new Set(
      Object.values(predicateCases).map(
        (tree) => sync.evaluatePredicate(tree, context, syncResolvers).status,
      ),
    );
    expect(statuses).toEqual(new Set(["definite", "indeterminate"]));
  });

  it("evaluates a value expression to the same result as the asynchronous evaluator", async () => {
    const node: ExpressionNode = {
      kind: "arithmetic",
      op: "multiply",
      left: ref("a"),
      right: { kind: "call", fn: "double", args: [ref("b")] },
    };
    expect(sync.evaluateValue(node, context, syncResolvers)).toEqual({
      status: "definite",
      value: { kind: "number", value: 20, unit: {} },
    });
    expect(sync.evaluateValue(node, context, syncResolvers)).toEqual(
      await async.evaluateValue(node, context, asyncResolvers),
    );
  });

  it("throws, rather than returning a pending result, when a resolver hands back a thenable", () => {
    const thenable = { found: false, then: () => undefined } as const;
    const promising: SyncResolvers = {
      ...syncResolvers,
      resolveValue: () => thenable,
    };
    expect(() =>
      sync.evaluatePredicate(gt(ref("a"), numbers.n1), context, promising),
    ).toThrow(TypeError);
  });

  it("applies the node budget", () => {
    const limited = createSyncEvaluator({ maxNodes: 3 });
    const result = limited.evaluatePredicate(
      {
        kind: "allOf",
        operands: [gt(ref("a"), numbers.n1), gt(ref("a"), numbers.n2)],
      },
      context,
      syncResolvers,
    );
    expect(result.status).toBe("indeterminate");
  });

  it("propagates an exception thrown by a resolver", () => {
    const failing: SyncResolvers = {
      ...syncResolvers,
      resolveValue: () => {
        throw new Error("resolver failed");
      },
    };
    expect(() =>
      sync.evaluatePredicate(gt(ref("a"), numbers.n1), context, failing),
    ).toThrow("resolver failed");
  });
});
