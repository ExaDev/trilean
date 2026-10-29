import { describe, expect, it } from "vitest";
import type { ComputedValue } from "./computed-value";
import { coalesce } from "./derived-values";
import { count } from "./derived-aggregates";
import type { Evaluation, IndeterminateReason } from "./evaluation";
import { createEvaluator, createSyncEvaluator } from "./evaluator-factory";
import type { Resolution, Resolvers, SyncResolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * Behaviour of a resolver's `{ found: false, notYetKnown: true }` report across every node kind that consumes a resolution, exercised through the synchronous evaluator (the node rules are shared with the asynchronous one, which one test below checks directly). Three reference keys cover the three possible states of a value: `"n"` is known and present, `"gone"` is known to be absent, `"pending"` is not yet known.
 */

/** The number a present value resolves to, and two other numbers that differ from it and from each other. */
const knownValue = 7;
const unequalValue = 8;
const spareValue = 3;

const present: Resolution = {
  found: true,
  value: { kind: "number", value: knownValue },
};
const absent: Resolution = { found: false };
const pending: Resolution = { found: false, notYetKnown: true };

const byKey = (key: unknown): Resolution => {
  if (key === "n") return present;
  if (key === "pending") return pending;

  return absent;
};

/** Item 0 holds a known `n` and item 1 a `pending` field; inside a collection an item is the whole evaluation context, so a reference resolves against the item alone. `pendingItems` holds item 1 only. */
const collections: Record<string, readonly Record<string, unknown>[]> = {
  items: [{ n: 1 }, { pending: 1 }],
  pendingItems: [{ pending: 1 }],
};

const syncResolvers: SyncResolvers = {
  resolveValue: (key, context) => {
    if (typeof context === "object" && context !== null) {
      return key === "n" && "n" in context
        ? present
        : key === "pending" && "pending" in context
          ? pending
          : absent;
    }

    return byKey(key);
  },
  resolveLookup: (table) => byKey(table),
  resolveCollection: (collection) =>
    typeof collection === "string" ? [...(collections[collection] ?? [])] : [],
  resolveDelegate: (system) => byKey(system),
  resolveTree: (key) =>
    key === "pendingTree"
      ? { found: false, notYetKnown: true }
      : key === "goneTree"
        ? { found: false }
        : { found: true, node: { kind: "booleanLiteral", value: true } },
};

const { evaluatePredicate, evaluateValue } = createSyncEvaluator({});

const ref = (key: string): ExpressionNode => ({ kind: "reference", key });
const num = (value: number): ExpressionNode => ({
  kind: "numberLiteral",
  value,
});
const eq = (left: ExpressionNode, right: ExpressionNode): PredicateNode => ({
  kind: "compare",
  op: "eq",
  left,
  right,
});
/** A predicate that is definitely `true` / `false`, independent of every resolver. */
const yes: PredicateNode = eq(num(1), num(1));
const no: PredicateNode = eq(num(1), num(0));
/** A predicate that is indeterminate `not-yet-known` / `not-found`. */
const unknown: PredicateNode = eq(ref("pending"), num(1));
const missing: PredicateNode = eq(ref("gone"), num(1));

function codeOf(evaluation: Evaluation<unknown>): string {
  return evaluation.status === "definite" ? "definite" : evaluation.reason.code;
}

function definiteValue<T>(evaluation: Evaluation<T>): T {
  if (evaluation.status !== "definite") {
    throw new Error(`expected definite, got ${evaluation.reason.code}`);
  }

  return evaluation.value;
}

function evaluatePredicateCode(node: PredicateNode): string {
  return codeOf(evaluatePredicate(node, undefined, syncResolvers));
}

function evaluateValueCode(node: ExpressionNode): string {
  return codeOf(evaluateValue(node, undefined, syncResolvers));
}

describe("a not-yet-known resolution is its own indeterminate reason", () => {
  it.each<[string, ExpressionNode]>([
    ["reference", ref("pending")],
    ["lookup", { kind: "lookup", table: "pending", keys: [num(1)] }],
    ["delegate", { kind: "delegate", system: "pending", payload: null }],
    ["treeReference", { kind: "treeReference", key: "pendingTree" }],
  ])("%s: not-yet-known", (_name, node) => {
    expect(evaluateValueCode(node)).toBe("not-yet-known");
  });

  it.each<[string, ExpressionNode]>([
    ["reference", ref("gone")],
    ["lookup", { kind: "lookup", table: "gone", keys: [num(1)] }],
    ["delegate", { kind: "delegate", system: "gone", payload: null }],
    ["treeReference", { kind: "treeReference", key: "goneTree" }],
  ])("%s: a plain { found: false } is still not-found", (_name, node) => {
    expect(evaluateValueCode(node)).toBe("not-found");
  });

  it("a predicate treeReference reports not-yet-known and not-found by the same rule", () => {
    expect(
      evaluatePredicateCode({ kind: "treeReference", key: "pendingTree" }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "treeReference", key: "goneTree" }),
    ).toBe("not-found");
  });

  it("notYetKnown: false is the same as leaving it out", () => {
    const resolvers: SyncResolvers = {
      ...syncResolvers,
      resolveValue: () => ({ found: false, notYetKnown: false }),
    };
    expect(codeOf(evaluateValue(ref("x"), undefined, resolvers))).toBe(
      "not-found",
    );
  });

  it("the asynchronous evaluator agrees with the synchronous one", async () => {
    const asyncResolvers: Resolvers = {
      resolveValue: async (key) => Promise.resolve(byKey(key)),
      resolveLookup: async (table) => Promise.resolve(byKey(table)),
      resolveCollection: async () => Promise.resolve([]),
    };
    const { evaluateValue: evaluateAsync } = createEvaluator({});
    expect(
      codeOf(await evaluateAsync(ref("pending"), undefined, asyncResolvers)),
    ).toBe("not-yet-known");
    expect(
      codeOf(await evaluateAsync(ref("gone"), undefined, asyncResolvers)),
    ).toBe("not-found");
  });

  it("carries a message naming what is not yet known", () => {
    const result = evaluateValue(ref("pending"), undefined, syncResolvers);
    expect(result).toEqual({
      status: "indeterminate",
      reason: {
        code: "not-yet-known",
        message: 'the value for reference key "pending" is not yet known',
      } satisfies IndeterminateReason,
    });
  });
});

describe("exists", () => {
  it("is true for a found value, false for a known absence, indeterminate for a value not yet known", () => {
    expect(
      evaluatePredicate(
        { kind: "exists", operand: ref("n") },
        undefined,
        syncResolvers,
      ),
    ).toEqual({ status: "definite", value: true });
    expect(
      evaluatePredicate(
        { kind: "exists", operand: ref("gone") },
        undefined,
        syncResolvers,
      ),
    ).toEqual({ status: "definite", value: false });
    expect(
      evaluatePredicateCode({ kind: "exists", operand: ref("pending") }),
    ).toBe("not-yet-known");
  });

  it("is indeterminate when the unknown value is reached through a computation", () => {
    expect(
      evaluatePredicateCode({
        kind: "exists",
        operand: {
          kind: "arithmetic",
          op: "add",
          left: ref("pending"),
          right: num(1),
        },
      }),
    ).toBe("not-yet-known");
  });

  it("stays a definite false when a known absence settles the operand before an unknown value is reached", () => {
    expect(
      evaluatePredicate(
        {
          kind: "exists",
          operand: {
            kind: "arithmetic",
            op: "add",
            left: ref("gone"),
            right: ref("pending"),
          },
        },
        undefined,
        syncResolvers,
      ),
    ).toEqual({ status: "definite", value: false });
  });

  it("is indeterminate when an unknown guard could still select a different branch of the operand", () => {
    const guarded: ExpressionNode = {
      kind: "conditional",
      cases: [
        { when: { kind: "and", left: missing, right: unknown }, then: num(1) },
      ],
      fallback: num(2),
    };
    expect(evaluatePredicateCode({ kind: "exists", operand: guarded })).toBe(
      "not-yet-known",
    );
  });
});

describe("coalesce", () => {
  it("skips a known absence to the next candidate", () => {
    expect(
      definiteValue(
        evaluateValue(
          coalesce(ref("gone"), ref("n")),
          undefined,
          syncResolvers,
        ),
      ),
    ).toEqual({ kind: "number", value: knownValue } satisfies ComputedValue);
  });

  it("stays indeterminate on a candidate that is not yet known, instead of falling through", () => {
    expect(evaluateValueCode(coalesce(ref("pending"), ref("n")))).toBe(
      "not-yet-known",
    );
  });

  it("stays indeterminate when an unknown candidate follows a known absence", () => {
    expect(
      evaluateValueCode(coalesce(ref("gone"), ref("pending"), ref("n"))),
    ).toBe("not-yet-known");
  });

  it("is settled by an earlier present candidate whatever follows it", () => {
    expect(
      definiteValue(
        evaluateValue(
          coalesce(ref("n"), ref("pending")),
          undefined,
          syncResolvers,
        ),
      ),
    ).toEqual({ kind: "number", value: knownValue } satisfies ComputedValue);
  });
});

describe("Kleene connectives with a not-yet-known operand", () => {
  it("and: a definite false absorbs, otherwise the result is indeterminate not-yet-known", () => {
    expect(
      evaluatePredicateCode({ kind: "and", left: unknown, right: no }),
    ).toBe("definite");
    expect(
      evaluatePredicateCode({ kind: "and", left: no, right: unknown }),
    ).toBe("definite");
    expect(
      evaluatePredicateCode({ kind: "and", left: unknown, right: yes }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "and", left: yes, right: unknown }),
    ).toBe("not-yet-known");
  });

  it("or: a definite true absorbs, otherwise the result is indeterminate not-yet-known", () => {
    expect(
      evaluatePredicateCode({ kind: "or", left: unknown, right: yes }),
    ).toBe("definite");
    expect(
      evaluatePredicateCode({ kind: "or", left: yes, right: unknown }),
    ).toBe("definite");
    expect(
      evaluatePredicateCode({ kind: "or", left: unknown, right: no }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "or", left: no, right: unknown }),
    ).toBe("not-yet-known");
  });

  it("not: propagates", () => {
    expect(evaluatePredicateCode({ kind: "not", operand: unknown })).toBe(
      "not-yet-known",
    );
  });

  it("allOf and anyOf: absorb like and and or across the list", () => {
    expect(
      evaluatePredicateCode({ kind: "allOf", operands: [yes, unknown, no] }),
    ).toBe("definite");
    expect(
      evaluatePredicateCode({ kind: "allOf", operands: [yes, unknown] }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "anyOf", operands: [no, unknown, yes] }),
    ).toBe("definite");
    expect(
      evaluatePredicateCode({ kind: "anyOf", operands: [no, unknown] }),
    ).toBe("not-yet-known");
  });

  it("not-yet-known outranks not-found where a later operand could still absorb, whichever side it is on", () => {
    expect(
      evaluatePredicateCode({ kind: "and", left: missing, right: unknown }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "and", left: unknown, right: missing }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "or", left: missing, right: unknown }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "allOf", operands: [missing, unknown] }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({ kind: "and", left: missing, right: yes }),
    ).toBe("not-found");
  });

  it("memberOf: an unknown candidate that could still match outranks an earlier not-found one", () => {
    const candidates = [ref("gone"), ref("pending")];
    expect(
      evaluatePredicateCode({
        kind: "memberOf",
        op: "in",
        operand: num(knownValue),
        candidates,
      }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({
        kind: "memberOf",
        op: "in",
        operand: num(knownValue),
        candidates: [ref("pending"), ref("n")],
      }),
    ).toBe("definite");
  });
});

describe("nodes without an absorbing value propagate the first indeterminate operand", () => {
  it.each<[string, ExpressionNode, string]>([
    [
      "arithmetic, unknown first",
      {
        kind: "arithmetic",
        op: "add",
        left: ref("pending"),
        right: ref("gone"),
      },
      "not-yet-known",
    ],
    [
      "arithmetic, absent first",
      {
        kind: "arithmetic",
        op: "add",
        left: ref("gone"),
        right: ref("pending"),
      },
      "not-found",
    ],
    ["negate", { kind: "negate", operand: ref("pending") }, "not-yet-known"],
    [
      "call argument",
      { kind: "call", fn: "squareRoot", args: [ref("pending")] },
      "not-yet-known",
    ],
    [
      "lookup key",
      { kind: "lookup", table: "n", keys: [ref("pending")] },
      "not-yet-known",
    ],
  ])("%s", (_name, node, expected) => {
    expect(evaluateValueCode(node)).toBe(expected);
  });

  it("compare and textCompare", () => {
    expect(evaluatePredicateCode(eq(ref("pending"), num(1)))).toBe(
      "not-yet-known",
    );
    expect(
      evaluatePredicateCode({
        kind: "textCompare",
        op: "equals",
        left: ref("pending"),
        right: { kind: "textLiteral", value: "a" },
      }),
    ).toBe("not-yet-known");
  });
});

describe("conditional", () => {
  it("first: an unknown guard is returned, never skipped for a later case that matches", () => {
    expect(
      evaluateValueCode({
        kind: "conditional",
        cases: [
          { when: unknown, then: num(1) },
          { when: yes, then: num(2) },
        ],
        fallback: num(spareValue),
      }),
    ).toBe("not-yet-known");
  });

  it("first: an earlier definite match is not affected by a later unknown guard", () => {
    expect(
      evaluateValueCode({
        kind: "conditional",
        cases: [
          { when: yes, then: num(1) },
          { when: unknown, then: num(2) },
        ],
        fallback: num(spareValue),
      }),
    ).toBe("definite");
  });

  it("unique: one match does not absorb an unknown case, and the unknown outranks a not-found one", () => {
    const unique = (
      cases: Extract<ExpressionNode, { kind: "conditional" }>["cases"],
    ): ExpressionNode => ({
      kind: "conditional",
      hitPolicy: "unique",
      cases,
      fallback: num(0),
    });
    expect(
      evaluateValueCode(
        unique([
          { when: yes, then: num(1) },
          { when: unknown, then: num(2) },
        ]),
      ),
    ).toBe("not-yet-known");
    expect(
      evaluateValueCode(
        unique([
          { when: missing, then: num(1) },
          { when: unknown, then: num(2) },
        ]),
      ),
    ).toBe("not-yet-known");
    expect(
      evaluateValueCode(
        unique([
          { when: unknown, then: num(1) },
          { when: yes, then: num(2) },
          { when: yes, then: num(spareValue) },
        ]),
      ),
    ).toBe("domain-error");
  });
});

describe("collections", () => {
  const pendingField = eq(ref("pending"), num(1));

  it("some: a definite true from one item absorbs an item that is not yet known", () => {
    const item: PredicateNode = {
      kind: "or",
      left: eq(ref("n"), num(knownValue)),
      right: pendingField,
    };
    expect(
      evaluatePredicateCode({ kind: "some", collection: "items", item }),
    ).toBe("definite");
  });

  it("some and every: an item that is not yet known outranks another item's known absence", () => {
    expect(
      evaluatePredicateCode({
        kind: "some",
        collection: "items",
        item: pendingField,
      }),
    ).toBe("not-yet-known");
    expect(
      evaluatePredicateCode({
        kind: "every",
        collection: "items",
        item: eq(ref("pending"), num(1)),
      }),
    ).toBe("not-yet-known");
  });

  it("every: a definite false from one item absorbs an item that is not yet known", () => {
    expect(
      evaluatePredicateCode({
        kind: "every",
        collection: "items",
        item: eq(ref("n"), num(unequalValue)),
      }),
    ).toBe("definite");
  });

  it("a filter that is not yet known: an indeterminate vote in a quantifier, an indeterminate fold", () => {
    expect(
      evaluatePredicateCode({
        kind: "some",
        collection: "pendingItems",
        filter: pendingField,
        item: yes,
      }),
    ).toBe("not-yet-known");
    expect(
      evaluateValueCode({
        kind: "fold",
        collection: "pendingItems",
        filter: pendingField,
        combiner: { mode: "max", item: ref("pending") },
      }),
    ).toBe("not-yet-known");
  });

  it("fold: an item expression that is not yet known makes the fold indeterminate", () => {
    expect(
      evaluateValueCode({
        kind: "fold",
        collection: "pendingItems",
        combiner: { mode: "max", item: ref("pending") },
      }),
    ).toBe("not-yet-known");
  });

  it("count with a probe: a probe that is not yet known propagates rather than being skipped", () => {
    // A known absence makes the count untrustworthy by design (see `count`'s probe), and so does a value that has not arrived yet: dropping the item from the count now would give a smaller number that a later evaluation could contradict.
    expect(
      evaluateValueCode(count("pendingItems", undefined, ref("pending"))),
    ).toBe("not-yet-known");
    expect(
      evaluateValueCode(count("pendingItems", undefined, ref("gone"))),
    ).toBe("not-found");
  });
});
