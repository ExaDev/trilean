import { describe, expect, it } from "vitest";
import { createEvaluator, evaluatePredicate, evaluateValue } from "./evaluator";
import type { Resolvers } from "./resolvers";
import type { PredicateNode } from "./tree";
import {
  baseResolvers,
  falseGuard,
  laterConditionalCaseValue,
  missingGuard,
  missingRef,
  numberLiteral,
  trueGuard,
  uniqueHitPolicyThirdCaseValue,
  untouchedReduceInitial,
} from "./evaluator-indeterminacy-helpers";

// --- Explicitly called-out cases beyond the row-per-cell table above ---

describe("lookup: any-indeterminate-key short-circuit", () => {
  it("never calls resolveLookup when a key is indeterminate", async () => {
    let resolveLookupCalls = 0;
    const trackingResolvers: Resolvers = {
      ...baseResolvers,
      resolveLookup: async (table, keys, context) => {
        resolveLookupCalls += 1;
        return baseResolvers.resolveLookup(table, keys, context);
      },
    };
    const result = await evaluateValue(
      { kind: "lookup", table: "table1", keys: [missingRef, numberLiteral(1)] },
      undefined,
      trackingResolvers,
    );
    expect(result.status).toBe("indeterminate");
    expect(resolveLookupCalls).toBe(0);
  });
});

describe("conditional: must not skip an unresolved guard", () => {
  it("never evaluates a later case once an earlier unmatched guard is indeterminate", async () => {
    let laterCaseEvaluations = 0;
    const trackingResolvers: Resolvers = {
      ...baseResolvers,
      resolveValue: async (key, context) => {
        if (key === "later-case-marker") laterCaseEvaluations += 1;
        return baseResolvers.resolveValue(key, context);
      },
    };
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [
          { when: falseGuard, then: numberLiteral(1) },
          { when: missingGuard, then: numberLiteral(2) },
          {
            when: {
              kind: "compare",
              op: "eq",
              left: { kind: "reference", key: "later-case-marker" },
              right: numberLiteral(1),
            },
            then: numberLiteral(laterConditionalCaseValue),
          },
        ],
        fallback: numberLiteral(0),
      },
      undefined,
      trackingResolvers,
    );
    expect(result.status).toBe("indeterminate");
    expect(laterCaseEvaluations).toBe(0);
  });
});

describe("conditional: 'unique' hit policy", () => {
  it("2+ definite matches absorbs -- domain-error, even with a third case that is itself indeterminate", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        hitPolicy: "unique",
        cases: [
          { when: trueGuard, then: numberLiteral(1) },
          { when: trueGuard, then: numberLiteral(2) },
          {
            when: missingGuard,
            then: numberLiteral(uniqueHitPolicyThirdCaseValue),
          },
        ],
        fallback: numberLiteral(0),
      },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
    }
  });

  it("exactly one definite match plus one indeterminate case does NOT absorb -- the whole node is indeterminate, not the match's then", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        hitPolicy: "unique",
        cases: [
          { when: trueGuard, then: numberLiteral(1) },
          { when: missingGuard, then: numberLiteral(2) },
        ],
        fallback: numberLiteral(0),
      },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });

  it("a when that is itself wrong-type propagates that reason, not domain-error", async () => {
    const wrongTypeGuard: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: { kind: "textLiteral", value: "x" },
      right: numberLiteral(1),
    };
    const result = await evaluateValue(
      {
        kind: "conditional",
        hitPolicy: "unique",
        cases: [{ when: wrongTypeGuard, then: numberLiteral(1) }],
        fallback: numberLiteral(0),
      },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
    }
  });
});

describe("fold: reduce vs max/min over an empty collection", () => {
  it("reduce evaluates to initial directly, without ever evaluating combine", async () => {
    let combineEvaluations = 0;
    const trackingResolvers: Resolvers = {
      ...baseResolvers,
      resolveValue: async (key, context) => {
        if (key === "combine-marker") combineEvaluations += 1;
        return baseResolvers.resolveValue(key, context);
      },
    };
    const result = await evaluateValue(
      {
        kind: "fold",
        collection: "empty",
        combiner: {
          mode: "reduce",
          initial: numberLiteral(untouchedReduceInitial),
          combine: {
            kind: "arithmetic",
            op: "add",
            left: { kind: "accumulator" },
            right: { kind: "reference", key: "combine-marker" },
          },
        },
      },
      undefined,
      trackingResolvers,
    );
    expect(result).toEqual({
      status: "definite",
      value: { kind: "number", value: 42 },
    });
    expect(combineEvaluations).toBe(0);
  });

  it("max/min is domain-error, not initial-untouched -- it has no seed value at all", async () => {
    const result = await evaluateValue(
      {
        kind: "fold",
        collection: "empty",
        combiner: { mode: "max", item: numberLiteral(0) },
      },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate")
      expect(result.reason.code).toBe("domain-error");
  });
});

describe("accumulator: nested-fold shadowing", () => {
  it("an inner fold's own combine expression refers to the inner running value, not the outer's", async () => {
    // Outer fold sums a per-item nested "values" collection via an inner fold, seeded fresh at 0 on every outer item -- if the inner accumulator wrongly resolved to the outer's *current* running total instead of its own, the second outer item (processed once the outer total is already 3) would double-count it.
    const result = await evaluateValue(
      {
        kind: "fold",
        collection: "nested-outer",
        combiner: {
          mode: "reduce",
          initial: numberLiteral(0),
          combine: {
            kind: "arithmetic",
            op: "add",
            left: { kind: "accumulator" },
            right: {
              kind: "fold",
              collection: "values",
              combiner: {
                mode: "reduce",
                initial: numberLiteral(0),
                combine: {
                  kind: "arithmetic",
                  op: "add",
                  left: { kind: "accumulator" },
                  right: { kind: "reference", key: "amount" },
                },
              },
            },
          },
        },
      },
      undefined,
      baseResolvers,
    );
    expect(result).toEqual({
      status: "definite",
      value: { kind: "number", value: 13 },
    });
  });
});

describe("delegate: missing-handler message", () => {
  it("includes the external system's own name", async () => {
    const result = await evaluateValue(
      { kind: "delegate", system: "external-pricing-engine", payload: null },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
      expect(result.reason.message).toContain("external-pricing-engine");
    }
  });
});

describe("treeReference: reason-code coverage", () => {
  it("wrong-type: no resolveTree resolver registered", async () => {
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "any" },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
    }
  });

  it("not-found: the registered resolver reports absence", async () => {
    const treeResolvers: Resolvers = {
      ...baseResolvers,
      resolveTree: async () => Promise.resolve({ found: false }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "any" },
      undefined,
      treeResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });

  it("wrong-type: the resolved value fails to parse against the expected schema", async () => {
    const treeResolvers: Resolvers = {
      ...baseResolvers,
      resolveTree: async () =>
        Promise.resolve({ found: true, node: { kind: "nonsense" } }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "any" },
      undefined,
      treeResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
    }
  });

  it("domain-error: a key already on the current reference chain (cycle)", async () => {
    const treeResolvers: Resolvers = {
      ...baseResolvers,
      resolveTree: async () =>
        Promise.resolve({
          found: true,
          node: { kind: "treeReference", key: "self" },
        }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "self" },
      undefined,
      treeResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
      expect(result.reason.message).toBe("circular treeReference detected");
    }
  });

  it("domain-error: the chain already reached the maximum depth", async () => {
    const treeResolvers: Resolvers = {
      ...baseResolvers,
      resolveTree: async (key) =>
        Promise.resolve({
          found: true,
          node: {
            kind: "treeReference",
            key: `${typeof key === "string" ? key : "chain"}-next`,
          },
        }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "chain-0" },
      undefined,
      treeResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
      expect(result.reason.message).toContain("maximum depth");
    }
  });
});

describe("call: unregistered-name vs out-of-domain-argument distinction", () => {
  it("an unregistered function name is wrong-type", async () => {
    const result = await evaluateValue(
      { kind: "call", fn: "doesNotExist", args: [] },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
      expect(result.reason.message).toContain("doesNotExist");
    }
  });

  it("a registered function's out-of-domain argument is domain-error, not wrong-type", async () => {
    const { evaluateValue: evaluate } = createEvaluator({
      functions: {
        reciprocal: (args) => {
          const [arg] = args;
          if (arg?.kind !== "number") {
            return {
              domainError: "reciprocal requires a single number argument",
            };
          }
          if (arg.value === 0)
            return { domainError: "reciprocal of zero is undefined" };
          return { kind: "number", value: 1 / arg.value };
        },
      },
    });
    const result = await evaluate(
      { kind: "call", fn: "reciprocal", args: [numberLiteral(0)] },
      undefined,
      baseResolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate")
      expect(result.reason.code).toBe("domain-error");
  });
});
