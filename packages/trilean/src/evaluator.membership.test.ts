import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "./evaluator";
import type { Resolvers } from "./resolvers";
import type { ExpressionNode } from "./tree";
import {
  expectDefinite,
  expectIndeterminate,
  isPlainRecord,
  resolvers,
} from "./evaluator-test-helpers";

describe("memberOf", () => {
  it("in: a definite match makes the leaf definitely true", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [
          { kind: "numberLiteral", value: 3 },
          { kind: "numberLiteral", value: 5 },
        ],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("notIn: a definite match makes the leaf definitely false", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [{ kind: "numberLiteral", value: 5 }],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("boolean operands participate under the same kind-agnostic equality rule as every other kind", async () => {
    const matchResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "booleanLiteral", value: true },
        candidates: [
          { kind: "booleanLiteral", value: false },
          { kind: "booleanLiteral", value: true },
        ],
      },
      undefined,
      resolvers,
    );
    expectDefinite(matchResult, true);

    const nonMatchResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "booleanLiteral", value: true },
        candidates: [{ kind: "booleanLiteral", value: false }],
      },
      undefined,
      resolvers,
    );
    expectDefinite(nonMatchResult, false);
  });

  it("is wrong-type when a boolean operand is compared against a non-boolean candidate for membership", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "booleanLiteral", value: true },
        candidates: [{ kind: "numberLiteral", value: 1 }],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("matches a complex candidate on both components at once", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "complexLiteral", re: 3, im: -4 },
        candidates: [
          { kind: "complexLiteral", re: 3, im: 4 },
          { kind: "complexLiteral", re: 3, im: -4 },
        ],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("is wrong-type when a complex operand meets a candidate of another kind", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "complexLiteral", re: 3, im: 0 },
        candidates: [{ kind: "numberLiteral", value: 3 }],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("is wrong-type when a complex candidate carries an incompatible unit", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "complexLiteral", re: 3, im: -4, unit: { V: 1 } },
        candidates: [{ kind: "complexLiteral", re: 3, im: -4, unit: { A: 1 } }],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("a definite match short-circuits the result past a later indeterminate candidate", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [
          { kind: "numberLiteral", value: 5 },
          { kind: "reference", key: "missing" },
        ],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("an empty candidates list is never scanned: in is definitely false, notIn is definitely true", async () => {
    const inResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [],
      },
      undefined,
      resolvers,
    );
    expectDefinite(inResult, false);

    const notInResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [],
      },
      undefined,
      resolvers,
    );
    expectDefinite(notInResult, true);
  });

  it("no match among definite, comparable candidates: in is false, notIn is true", async () => {
    const candidates: ExpressionNode[] = [
      { kind: "numberLiteral", value: 1 },
      { kind: "numberLiteral", value: 2 },
    ];

    const inResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates,
      },
      undefined,
      resolvers,
    );
    expectDefinite(inResult, false);

    const notInResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "numberLiteral", value: 5 },
        candidates,
      },
      undefined,
      resolvers,
    );
    expectDefinite(notInResult, true);
  });

  it("tie-breaks several indeterminate/incompatible candidates to the first's reason, per declared order", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [
          { kind: "textLiteral", value: "5" }, // incompatible kind -> wrong-type
          { kind: "reference", key: "missing" }, // not-found
        ],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("an indeterminate operand makes the whole leaf indeterminate without ever scanning a candidate", async () => {
    let candidateEvaluations = 0;
    const trackingResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async (key, context) => {
        if (key === "candidate-marker") candidateEvaluations += 1;
        return resolvers.resolveValue(key, context);
      },
    };
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "missing" },
        candidates: [{ kind: "reference", key: "candidate-marker" }],
      },
      undefined,
      trackingResolvers,
    );
    expectIndeterminate(result, "not-found");
    expect(candidateEvaluations).toBe(0);
  });

  it("respects units for numeric candidates -- an incompatible unit is wrong-type, never a plain non-match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5, unit: { m: 1 } },
        candidates: [{ kind: "numberLiteral", value: 5, unit: { s: 1 } }],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

describe("exists", () => {
  it("a definite operand makes exists definitely true", async () => {
    const result = await evaluatePredicate(
      { kind: "exists", operand: { kind: "numberLiteral", value: 1 } },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("not-found converts to definitely false", async () => {
    const result = await evaluatePredicate(
      { kind: "exists", operand: { kind: "reference", key: "missing" } },
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("wrong-type converts to definitely true -- the data point resolved, it just wasn't usable", async () => {
    const result = await evaluatePredicate(
      {
        kind: "exists",
        operand: { kind: "reference", key: "present", unit: { s: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("domain-error converts to definitely true -- the data point resolved, it just wasn't usable", async () => {
    const result = await evaluatePredicate(
      {
        kind: "exists",
        operand: {
          kind: "arithmetic",
          op: "divide",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "numberLiteral", value: 0 },
        },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });
});

describe("some, every", () => {
  /** A resolver whose `resolveCollection` maps a small set of named collection references onto plain-object item arrays, and whose `resolveValue` reads a field straight off whatever item context it's given -- mirroring `resolveCollection`/`resolveValue`'s real relationship: descending into a quantifier replaces the evaluation context with the resolved item itself (see README.md's "Evaluation context" section), so a `reference` inside `item`/`filter` resolves against that one item, not the outer context. */
  const quantifierResolvers: Resolvers = {
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
        return Promise.resolve([{ amount: 1 }, { amount: 2 }, { amount: 30 }]);
      }
      if (collection === "grouped") {
        return Promise.resolve([
          { group: "keep", amount: 5 },
          { group: "skip", amount: 999 },
        ]);
      }
      if (collection === "flagged") {
        return Promise.resolve([
          { flag: 1, amount: 100 },
          { amount: 5 }, // no `flag` field -- the filter itself is indeterminate for this item
        ]);
      }
      return Promise.resolve([]);
    },
  };

  it("some is definitely true when at least one participating item's item predicate matches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 10 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, true);
  });

  it("some is definitely false when no participating item's item predicate matches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 1000 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, false);
  });

  it("every is definitely true when every participating item's item predicate matches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "every",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 0 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, true);
  });

  it("every is definitely false when at least one participating item's item predicate fails to match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "every",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 10 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, false);
  });

  it("filter excludes an item entirely, as if it had never been in the collection", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "grouped",
        filter: {
          kind: "textCompare",
          op: "equals",
          left: { kind: "reference", key: "group" },
          right: { kind: "textLiteral", value: "keep" },
        },
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 500 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    // The only participating item ("keep") has amount 5, well under 500; the excluded item's amount 999 would satisfy `item`, but it never gets to participate.
    expectDefinite(result, false);
  });

  it("a filter-indeterminate item's own vote is absorbed by a different item's clean match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "flagged",
        filter: {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "flag" },
          right: { kind: "numberLiteral", value: 1 },
        },
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 10 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    // The second item has no `flag` field, so its filter is indeterminate and its vote is indeterminate too -- but the first item's clean match (flag 1, amount 100 > 10) still absorbs it to a definite true, exactly as OR's own absorption already requires.
    expectDefinite(result, true);
  });

  // Deliberate, settled per README.md: "every over an empty collection is definitely true" -- vacuous truth, the standard convention for universal quantification over an empty set. This must never be "fixed" to false.
  it("every over an empty collection is definitely true", async () => {
    const result = await evaluatePredicate(
      {
        kind: "every",
        collection: "nothing-here",
        item: {
          kind: "compare",
          op: "eq",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "numberLiteral", value: 1 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, true);
  });

  it("some over an empty collection is definitely false", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "nothing-here",
        item: {
          kind: "compare",
          op: "eq",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "numberLiteral", value: 1 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, false);
  });
});
