import { describe, expect, it } from "vitest";
import {
  createEvaluator,
  evaluatePredicate,
  evaluateValue,
} from "./evaluator-factory";
import type { FunctionRegistry } from "./functions";
import type { Resolvers } from "./resolvers";
import type { PredicateNode } from "./tree";
import {
  expectDefinite,
  expectIndeterminate,
  isPlainRecord,
  resolvers,
} from "./evaluator-test-helpers";

describe("conditional", () => {
  const whenEquals = (left: number, right: number): PredicateNode => ({
    kind: "compare",
    op: "eq",
    left: { kind: "numberLiteral", value: left },
    right: { kind: "numberLiteral", value: right },
  });
  /** `@typescript-eslint/no-magic-numbers` only exempts -1/0/1/2 -- a third distinctly-numbered case below needs a named constant instead of a bare `3`. */
  const thirdCaseIdentifier = 3;

  it("evaluates the then of the first case whose when is definitely true, skipping earlier false cases", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [
          {
            when: whenEquals(1, 2),
            then: { kind: "numberLiteral", value: 100 },
          },
          {
            when: whenEquals(1, 1),
            then: { kind: "numberLiteral", value: 200 },
          },
          {
            when: whenEquals(1, 1),
            then: { kind: "numberLiteral", value: 300 },
          },
        ],
        fallback: { kind: "numberLiteral", value: 0 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 200 });
  });

  it("evaluates fallback when no case matches", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [
          {
            when: whenEquals(1, 2),
            then: { kind: "numberLiteral", value: 100 },
          },
        ],
        fallback: { kind: "numberLiteral", value: 999 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 999 });
  });

  it("an empty cases list always evaluates to fallback", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [],
        fallback: { kind: "numberLiteral", value: 999 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 999 });
  });

  it("never evaluates a later case's then once an earlier case has already matched", async () => {
    let laterThenEvaluations = 0;
    const trackingResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async (key, context) => {
        if (key === "later-then-marker") laterThenEvaluations += 1;
        return resolvers.resolveValue(key, context);
      },
    };
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [
          {
            when: whenEquals(1, 1),
            then: { kind: "numberLiteral", value: 200 },
          },
        ],
        fallback: { kind: "reference", key: "later-then-marker" },
      },
      undefined,
      trackingResolvers,
    );
    expectDefinite(result, { kind: "number", value: 200 });
    expect(laterThenEvaluations).toBe(0);
  });

  // A `when` predicate that is always indeterminate (not-found), used across the hitPolicy tests below to distinguish "this case definitely doesn't match" from "this case's match status is unknown".
  const whenIndeterminate: PredicateNode = {
    kind: "compare",
    op: "eq",
    left: { kind: "reference", key: "missing" },
    right: { kind: "numberLiteral", value: 0 },
  };

  describe("hitPolicy: 'unique'", () => {
    it("exactly one match: returns that case's then, and never evaluates any other case's then", async () => {
      let secondThenEvaluations = 0;
      const trackingResolvers: Resolvers = {
        ...resolvers,
        resolveValue: async (key, context) => {
          if (key === "second-then-marker") secondThenEvaluations += 1;
          return resolvers.resolveValue(key, context);
        },
      };
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 2),
              then: { kind: "reference", key: "second-then-marker" },
            },
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 200 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        trackingResolvers,
      );
      expectDefinite(result, { kind: "number", value: 200 });
      expect(secondThenEvaluations).toBe(0);
    });

    it("zero matches: returns fallback, same as 'first'", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 2),
              then: { kind: "numberLiteral", value: 100 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 999 },
        },
        undefined,
        resolvers,
      );
      expectDefinite(result, { kind: "number", value: 999 });
    });

    it("two matches: domain-error, regardless of case order", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 100 },
            },
            {
              when: whenEquals(2, 2),
              then: { kind: "numberLiteral", value: 200 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "domain-error");
      if (result.status === "indeterminate") {
        expect(result.reason.message).toBe(
          "more than one case matched under the 'unique' hit policy",
        );
      }
    });

    it("three matches: the same domain-error, not a distinct message", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 1 },
            },
            {
              when: whenEquals(2, 2),
              then: { kind: "numberLiteral", value: 2 },
            },
            {
              when: whenEquals(thirdCaseIdentifier, thirdCaseIdentifier),
              then: { kind: "numberLiteral", value: thirdCaseIdentifier },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "domain-error");
      if (result.status === "indeterminate") {
        expect(result.reason.message).toBe(
          "more than one case matched under the 'unique' hit policy",
        );
      }
    });

    it("one match plus one unrelated indeterminate case: the whole node is indeterminate, NOT the match's then -- a single confirmed match does not absorb a remaining unresolved sibling under 'unique'", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 100 },
            },
            {
              when: whenIndeterminate,
              then: { kind: "numberLiteral", value: 200 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "not-found");
    });

    it("two matches plus a third indeterminate case: still the domain-error -- 2+ matches absorbs even a genuine indeterminate elsewhere", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 1 },
            },
            {
              when: whenEquals(2, 2),
              then: { kind: "numberLiteral", value: 2 },
            },
            {
              when: whenIndeterminate,
              then: { kind: "numberLiteral", value: 3 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "domain-error");
    });

    it("zero matches plus one indeterminate case: indeterminate", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 2),
              then: { kind: "numberLiteral", value: 1 },
            },
            {
              when: whenIndeterminate,
              then: { kind: "numberLiteral", value: 2 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "not-found");
    });

    it("absent hitPolicy behaves identically to explicit 'first'", async () => {
      const cases = [
        {
          when: whenEquals(1, 2),
          then: { kind: "numberLiteral" as const, value: 100 },
        },
        {
          when: whenEquals(1, 1),
          then: { kind: "numberLiteral" as const, value: 200 },
        },
      ];
      const withoutHitPolicy = await evaluateValue(
        {
          kind: "conditional",
          cases,
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      const withExplicitFirst = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "first",
          cases,
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expect(withoutHitPolicy).toEqual(withExplicitFirst);
      expectDefinite(withoutHitPolicy, { kind: "number", value: 200 });
    });

    it("evaluates every case's when concurrently, not short-circuited on the first match", async () => {
      const caseCount = 3;
      let whenEvaluationCount = 0;
      const trackingResolvers: Resolvers = {
        ...resolvers,
        resolveValue: async (key, context) => {
          if (key === "when-marker") whenEvaluationCount += 1;
          return resolvers.resolveValue(key, context);
        },
      };
      const whenMarker: PredicateNode = {
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "when-marker" },
        right: { kind: "numberLiteral", value: 0 },
      };
      await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            { when: whenMarker, then: { kind: "numberLiteral", value: 1 } },
            { when: whenMarker, then: { kind: "numberLiteral", value: 2 } },
            { when: whenMarker, then: { kind: "numberLiteral", value: 3 } },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        trackingResolvers,
      );
      expect(whenEvaluationCount).toBe(caseCount);
    });
  });
});

describe("delegate", () => {
  it("is wrong-type when no delegate handler is registered", async () => {
    const result = await evaluateValue(
      { kind: "delegate", system: "tax-engine", payload: { rate: 0.2 } },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("resolves via the registered handler when one is provided", async () => {
    const delegateResolvers: Resolvers = {
      ...resolvers,
      resolveDelegate: async (system) =>
        Promise.resolve(
          system === "tax-engine"
            ? { found: true, value: { kind: "number", value: 42 } }
            : { found: false },
        ),
    };
    const result = await evaluateValue(
      { kind: "delegate", system: "tax-engine", payload: null },
      undefined,
      delegateResolvers,
    );
    expectDefinite(result, { kind: "number", value: 42 });
  });

  it("is not-found when the registered handler itself reports absence", async () => {
    const delegateResolvers: Resolvers = {
      ...resolvers,
      resolveDelegate: async () => Promise.resolve({ found: false }),
    };
    const result = await evaluateValue(
      { kind: "delegate", system: "tax-engine", payload: null },
      undefined,
      delegateResolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

describe("treeReference", () => {
  it("evaluatePredicate: is wrong-type when no tree resolver is registered", async () => {
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "eligibility" },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("evaluateValue: is wrong-type when no tree resolver is registered", async () => {
    const result = await evaluateValue(
      { kind: "treeReference", key: "pricing" },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("evaluatePredicate: is not-found when the resolver reports absence", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () => Promise.resolve({ found: false }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "eligibility" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("evaluatePredicate: resolves and evaluates the referenced predicate tree, with context passed through unchanged", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve(
          key === "eligibility"
            ? {
                found: true,
                node: {
                  kind: "compare",
                  op: "eq",
                  left: { kind: "reference", key: "age" },
                  right: { kind: "numberLiteral", value: 21 },
                },
              }
            : { found: false },
        ),
      resolveValue: async (key, context) =>
        Promise.resolve(
          key === "age" && isPlainRecord(context) && "age" in context
            ? {
                found: true,
                value: { kind: "number", value: context.age as number },
              }
            : { found: false },
        ),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "eligibility" },
      { age: 21 },
      treeResolvers,
    );
    expectDefinite(result, true);
  });

  it("evaluateValue: resolves and evaluates the referenced expression tree, with the enclosing fold's accumulator passed through unchanged", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve(
          key === "double-accumulator"
            ? {
                found: true,
                node: {
                  kind: "arithmetic",
                  op: "multiply",
                  left: { kind: "accumulator" },
                  right: { kind: "numberLiteral", value: 2 },
                },
              }
            : { found: false },
        ),
      resolveCollection: async (collection) =>
        Promise.resolve(collection === "items" ? [{}] : []),
    };
    const result = await evaluateValue(
      {
        kind: "fold",
        collection: "items",
        combiner: {
          mode: "reduce",
          initial: { kind: "numberLiteral", value: 5 },
          combine: { kind: "treeReference", key: "double-accumulator" },
        },
      },
      undefined,
      treeResolvers,
    );
    expectDefinite(result, { kind: "number", value: 10, unit: {} });
  });

  it("evaluatePredicate: is wrong-type when the resolved node fails to parse as a PredicateNode", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () =>
        Promise.resolve({ found: true, node: { kind: "not-a-real-kind" } }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "malformed" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("evaluateValue: is wrong-type when the resolved node fails to parse as an ExpressionNode", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () =>
        Promise.resolve({ found: true, node: "just a string, not a node" }),
    };
    const result = await evaluateValue(
      { kind: "treeReference", key: "malformed" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("direct self-reference is a domain-error: circular treeReference detected", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
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
    expectIndeterminate(result, "domain-error");
    if (result.status === "indeterminate") {
      expect(result.reason.message).toBe("circular treeReference detected");
    }
  });

  it("indirect A -> B -> A cycle is a domain-error", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve({
          found: true,
          node: {
            kind: "treeReference",
            key: key === "ruleA" ? "ruleB" : "ruleA",
          },
        }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "ruleA" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "domain-error");
    if (result.status === "indeterminate") {
      expect(result.reason.message).toBe("circular treeReference detected");
    }
  });

  it("a long acyclic chain past the maximum depth is a domain-error, not a cycle", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
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
    expectIndeterminate(result, "domain-error");
    if (result.status === "indeterminate") {
      expect(result.reason.message).toBe(
        "treeReference chain exceeds the maximum depth of 100",
      );
    }
  });

  it("a treeReference nested inside a some/every filter still participates in cycle detection correctly", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveCollection: async (collection) =>
        Promise.resolve(collection === "items" ? [{}] : []),
      resolveTree: async () =>
        Promise.resolve({
          found: true,
          node: { kind: "treeReference", key: "self-in-filter" },
        }),
    };
    await expect(
      evaluatePredicate(
        {
          kind: "some",
          collection: "items",
          item: {
            kind: "exists",
            operand: { kind: "numberLiteral", value: 1 },
          },
          filter: { kind: "treeReference", key: "self-in-filter" },
        },
        undefined,
        treeResolvers,
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: {
        code: "domain-error",
        message: "circular treeReference detected",
      },
    });
  });

  it("a treeReference nested inside a conditional's when still participates in cycle detection correctly", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () =>
        Promise.resolve({
          found: true,
          node: { kind: "treeReference", key: "self-in-when" },
        }),
    };
    await expect(
      evaluateValue(
        {
          kind: "conditional",
          cases: [
            {
              when: { kind: "treeReference", key: "self-in-when" },
              then: { kind: "numberLiteral", value: 1 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        treeResolvers,
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: {
        code: "domain-error",
        message: "circular treeReference detected",
      },
    });
  });
});

describe("call", () => {
  const doubleFn: FunctionRegistry = {
    double: (args) => {
      const [arg] = args;
      if (arg?.kind !== "number") {
        return { domainError: "double requires a single number argument" };
      }
      return { kind: "number", value: arg.value + arg.value };
    },
  };

  it("invokes the registered function with the resolved arguments", async () => {
    const { evaluateValue: evaluate } = createEvaluator({
      functions: doubleFn,
    });
    const result = await evaluate(
      {
        kind: "call",
        fn: "double",
        args: [{ kind: "numberLiteral", value: 21 }],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 42 });
  });

  it("is wrong-type for an unregistered function name", async () => {
    const result = await evaluateValue(
      { kind: "call", fn: "doesNotExist", args: [] },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  /** A `FunctionRegistry` is an ordinary object, so `Object.prototype`'s own members answer a bare index lookup on it. A tree naming one of those is naming a function nobody registered, and must be reported as such rather than reaching a prototype method -- which would either throw or produce a "definite" result that is not a `ComputedValue` at all. */
  it.each(["toString", "valueOf", "constructor", "hasOwnProperty"])(
    "treats the inherited Object.prototype member '%s' as an unregistered function name",
    async (fn) => {
      const result = await evaluateValue(
        { kind: "call", fn, args: [] },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    },
  );

  it("is domain-error when the registered function reports one", async () => {
    const { evaluateValue: evaluate } = createEvaluator({
      functions: doubleFn,
    });
    const result = await evaluate(
      {
        kind: "call",
        fn: "double",
        args: [{ kind: "textLiteral", value: "x" }],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });

  it("evaluates every argument concurrently, tie-breaking an indeterminate outcome to the first in declared order", async () => {
    const { evaluateValue: evaluate } = createEvaluator({
      functions: doubleFn,
    });
    const result = await evaluate(
      {
        kind: "call",
        fn: "double",
        args: [
          { kind: "reference", key: "missing" },
          { kind: "reference", key: "also-missing" },
        ],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});
