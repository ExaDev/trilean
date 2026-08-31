import { describe, expect, it } from "vitest";
import { createEvaluator, evaluatePredicate, evaluateValue } from "./evaluator";
import type { IndeterminateReason } from "./evaluation";
import type { FunctionRegistry } from "./functions";
import type { EvaluationContext, Resolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * Systematic, table-driven coverage of README.md's "Indeterminacy reference" section: one fixture per node-kind x reason-code combination that section documents, for every `PredicateNode`/`ExpressionNode` kind implemented across all six phases so far. This complements, rather than replaces, the ad hoc behavioural tests already in evaluator.test.ts/truth-tables.test.ts -- this file exists specifically to walk the reference table itself, row by row.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** A single resolver pool shared by every fixture below, covering every named key/table/collection any fixture needs. Fixtures that need genuinely different resolver behaviour (the delegate/call rows) supply their own. */
const baseResolvers: Resolvers = {
  resolveValue: async (key, context) => {
    if (key === "present") {
      return Promise.resolve({
        found: true,
        value: { kind: "number", value: 10, unit: { m: 1 } },
      });
    }
    if (key === "presentText") {
      return Promise.resolve({
        found: true,
        value: { kind: "text", value: "hello" },
      });
    }
    if (typeof key === "string" && isPlainRecord(context) && key in context) {
      const value = context[key];
      if (typeof value === "number") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value },
        });
      }
      if (typeof value === "string") {
        return Promise.resolve({
          found: true,
          value: { kind: "text", value },
        });
      }
    }
    return Promise.resolve({ found: false });
  },
  resolveLookup: async (table) => {
    if (table === "table1") {
      return Promise.resolve({
        found: true,
        value: { kind: "number", value: 100 },
      });
    }
    return Promise.resolve({ found: false });
  },
  resolveCollection: async (collection, context) => {
    if (collection === "single-notfound") return Promise.resolve([{}]);
    if (collection === "single-wrongtype") {
      return Promise.resolve([{ value: "x" }]);
    }
    if (collection === "single-domainerror") return Promise.resolve([{}]);
    if (collection === "empty") return Promise.resolve([]);
    if (collection === "one-item") return Promise.resolve([{}]);
    if (collection === "nested-outer") {
      return Promise.resolve([
        { values: [{ amount: 1 }, { amount: 2 }] },
        { values: [{ amount: 10 }] },
      ]);
    }
    if (collection === "values" && isPlainRecord(context)) {
      const values = context.values;
      return Promise.resolve(isUnknownArray(values) ? values : []);
    }
    return Promise.resolve([]);
  },
};

// --- Shared node fragments ---

const numberLiteral = (value: number): ExpressionNode => ({
  kind: "numberLiteral",
  value,
});
const missingRef: ExpressionNode = { kind: "reference", key: "missing" };
const divideByZero: ExpressionNode = {
  kind: "arithmetic",
  op: "divide",
  left: numberLiteral(1),
  right: numberLiteral(0),
};
const wrongTypeArithmetic: ExpressionNode = {
  kind: "arithmetic",
  op: "add",
  left: { kind: "textLiteral", value: "x" },
  right: numberLiteral(1),
};
const trueGuard: PredicateNode = {
  kind: "compare",
  op: "eq",
  left: numberLiteral(1),
  right: numberLiteral(1),
};
const falseGuard: PredicateNode = {
  kind: "compare",
  op: "eq",
  left: numberLiteral(1),
  right: numberLiteral(2),
};
const missingGuard: PredicateNode = {
  kind: "compare",
  op: "eq",
  left: missingRef,
  right: numberLiteral(1),
};

/** Arbitrary non-{-1,0,1,2} magnitudes used below, named individually so each numeric literal only appears once (`@typescript-eslint/no-magic-numbers` only exempts -1/0/1/2 and object-literal property values, not values passed as plain call arguments). */
const memberOfProbeValue = 5;
const reduceInitialSeed = 5;
const laterConditionalCaseValue = 3;
const untouchedReduceInitial = 42;

// --- Fixture machinery ---

type Expected =
  | { readonly status: "definite" }
  | {
      readonly status: "indeterminate";
      readonly code: IndeterminateReason["code"];
    };

const isDefinite: Expected = { status: "definite" };
const isNotFound: Expected = { status: "indeterminate", code: "not-found" };
const isWrongType: Expected = { status: "indeterminate", code: "wrong-type" };
const isDomainError: Expected = {
  status: "indeterminate",
  code: "domain-error",
};

interface Fixture {
  readonly description: string;
  readonly expected: Expected;
  readonly run: () => Promise<{ status: string }>;
}

interface FixtureOverrides {
  readonly context?: EvaluationContext;
  readonly resolvers?: Resolvers;
  readonly functions?: FunctionRegistry;
}

function pred(
  description: string,
  node: PredicateNode,
  expected: Expected,
  overrides: FixtureOverrides = {},
): Fixture {
  const { context, resolvers = baseResolvers, functions } = overrides;
  const { evaluatePredicate: evaluate } = functions
    ? createEvaluator({ functions })
    : { evaluatePredicate };
  return {
    description,
    expected,
    run: async () => evaluate(node, context, resolvers),
  };
}

function expr(
  description: string,
  node: ExpressionNode,
  expected: Expected,
  overrides: FixtureOverrides = {},
): Fixture {
  const { context, resolvers = baseResolvers, functions } = overrides;
  const { evaluateValue: evaluate } = functions
    ? createEvaluator({ functions })
    : { evaluateValue };
  return {
    description,
    expected,
    run: async () => evaluate(node, context, resolvers),
  };
}

async function runFixture({ run, expected }: Fixture): Promise<void> {
  const result = await run();
  expect(result.status).toBe(expected.status);
  if (expected.status === "indeterminate" && "reason" in result) {
    expect((result as { reason: IndeterminateReason }).reason.code).toBe(
      expected.code,
    );
  }
}

// --- The reference table itself, one row per node-kind x reason-code combination ---

const fixtures: readonly Fixture[] = [
  // not
  pred(
    "not: not-found propagates from operand",
    {
      kind: "not",
      operand: {
        kind: "compare",
        op: "eq",
        left: missingRef,
        right: numberLiteral(1),
      },
    },
    isNotFound,
  ),
  pred(
    "not: wrong-type propagates from operand",
    {
      kind: "not",
      operand: {
        kind: "compare",
        op: "eq",
        left: numberLiteral(1),
        right: { kind: "textLiteral", value: "1" },
      },
    },
    isWrongType,
  ),
  pred(
    "not: domain-error propagates from operand",
    {
      kind: "not",
      operand: {
        kind: "compare",
        op: "eq",
        left: divideByZero,
        right: numberLiteral(1),
      },
    },
    isDomainError,
  ),

  // and
  pred(
    "and: not-found propagates when the other operand is not definitely false",
    { kind: "and", left: trueGuard, right: missingGuard },
    isNotFound,
  ),
  pred(
    "and: false absorbs an indeterminate other operand regardless of its reason",
    {
      kind: "and",
      left: falseGuard,
      right: {
        kind: "compare",
        op: "eq",
        left: divideByZero,
        right: numberLiteral(1),
      },
    },
    isDefinite,
  ),

  // or
  pred(
    "or: not-found propagates when the other operand is not definitely true",
    { kind: "or", left: falseGuard, right: missingGuard },
    isNotFound,
  ),
  pred(
    "or: true absorbs an indeterminate other operand regardless of its reason",
    {
      kind: "or",
      left: trueGuard,
      right: {
        kind: "compare",
        op: "eq",
        left: divideByZero,
        right: numberLiteral(1),
      },
    },
    isDefinite,
  ),

  // allOf / anyOf
  pred(
    "allOf: an indeterminate operand propagates when nothing in the list is definitely false",
    { kind: "allOf", operands: [trueGuard, missingGuard, trueGuard] },
    isNotFound,
  ),
  pred(
    "allOf: a definitely-false operand absorbs an indeterminate sibling",
    { kind: "allOf", operands: [falseGuard, missingGuard] },
    isDefinite,
  ),
  pred(
    "anyOf: an indeterminate operand propagates when nothing in the list is definitely true",
    { kind: "anyOf", operands: [falseGuard, missingGuard, falseGuard] },
    isNotFound,
  ),
  pred(
    "anyOf: a definitely-true operand absorbs an indeterminate sibling",
    { kind: "anyOf", operands: [trueGuard, missingGuard] },
    isDefinite,
  ),

  // compare
  pred(
    "compare: not-found propagates from either operand",
    { kind: "compare", op: "eq", left: missingRef, right: numberLiteral(1) },
    isNotFound,
  ),
  pred(
    "compare: wrong-type when the operand kinds differ",
    {
      kind: "compare",
      op: "eq",
      left: numberLiteral(1),
      right: { kind: "textLiteral", value: "1" },
    },
    isWrongType,
  ),
  pred(
    "compare: wrong-type when both operands are a kind compare does not support (text)",
    {
      kind: "compare",
      op: "eq",
      left: { kind: "textLiteral", value: "a" },
      right: { kind: "textLiteral", value: "b" },
    },
    isWrongType,
  ),
  pred(
    "compare: wrong-type when two numbers have incompatible units",
    {
      kind: "compare",
      op: "eq",
      left: { kind: "numberLiteral", value: 1, unit: { m: 1 } },
      right: { kind: "numberLiteral", value: 1, unit: { s: 1 } },
    },
    isWrongType,
  ),
  pred(
    "compare: never generates its own domain-error, but still carries one through from an operand",
    { kind: "compare", op: "eq", left: divideByZero, right: numberLiteral(1) },
    isDomainError,
  ),

  // textCompare
  pred(
    "textCompare: not-found propagates from either operand",
    {
      kind: "textCompare",
      op: "equals",
      left: missingRef,
      right: { kind: "textLiteral", value: "x" },
    },
    isNotFound,
  ),
  pred(
    "textCompare: wrong-type when an operand is not text",
    {
      kind: "textCompare",
      op: "equals",
      left: numberLiteral(1),
      right: { kind: "textLiteral", value: "1" },
    },
    isWrongType,
  ),
  pred(
    "textCompare: never generates its own domain-error, but still carries one through from an operand",
    {
      kind: "textCompare",
      op: "equals",
      left: divideByZero,
      right: { kind: "textLiteral", value: "x" },
    },
    isDomainError,
  ),

  // memberOf
  pred(
    "memberOf: not-found when operand is not found",
    {
      kind: "memberOf",
      op: "in",
      operand: missingRef,
      candidates: [numberLiteral(1)],
    },
    isNotFound,
  ),
  pred(
    "memberOf: wrong-type when operand/candidate kinds are incompatible and nothing else matches",
    {
      kind: "memberOf",
      op: "in",
      operand: numberLiteral(memberOfProbeValue),
      candidates: [{ kind: "textLiteral", value: "5" }],
    },
    isWrongType,
  ),
  pred(
    "memberOf: never generates its own domain-error, but still carries one through from the operand",
    {
      kind: "memberOf",
      op: "in",
      operand: divideByZero,
      candidates: [numberLiteral(1)],
    },
    isDomainError,
  ),

  // exists -- never indeterminate, by design
  pred(
    "exists: never not-found -- converts operand not-found to definitely false",
    { kind: "exists", operand: missingRef },
    isDefinite,
  ),
  pred(
    "exists: never wrong-type -- converts operand wrong-type to definitely true",
    { kind: "exists", operand: wrongTypeArithmetic },
    isDefinite,
  ),
  pred(
    "exists: never domain-error -- converts operand domain-error to definitely true",
    { kind: "exists", operand: divideByZero },
    isDefinite,
  ),

  // some / every
  pred(
    "some: not-found from a participating item's item sub-node, not absorbed by any other item",
    {
      kind: "some",
      collection: "single-notfound",
      item: {
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "value" },
        right: numberLiteral(1),
      },
    },
    isNotFound,
  ),
  pred(
    "every: wrong-type from a participating item's item sub-node, not absorbed by any other item",
    {
      kind: "every",
      collection: "single-wrongtype",
      item: {
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "value" },
        right: numberLiteral(1),
      },
    },
    isWrongType,
  ),
  pred(
    "some: domain-error from a participating item's item sub-node, not absorbed by any other item",
    {
      kind: "some",
      collection: "single-domainerror",
      item: {
        kind: "compare",
        op: "eq",
        left: divideByZero,
        right: numberLiteral(1),
      },
    },
    isDomainError,
  ),

  // literals -- never indeterminate, by construction
  expr("numberLiteral: never indeterminate", numberLiteral(1), isDefinite),
  expr(
    "textLiteral: never indeterminate",
    { kind: "textLiteral", value: "x" },
    isDefinite,
  ),
  expr(
    "instantLiteral: never indeterminate",
    { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
    isDefinite,
  ),
  expr(
    "durationLiteral: never indeterminate",
    { kind: "durationLiteral", value: 1, unit: "min" },
    isDefinite,
  ),

  // reference
  expr(
    "reference: not-found when the resolver reports absence",
    missingRef,
    isNotFound,
  ),
  expr(
    "reference: wrong-type when the expected unit does not match the resolved value's unit",
    { kind: "reference", key: "present", unit: { s: 1 } },
    isWrongType,
  ),

  // arithmetic
  expr(
    "arithmetic: not-found propagates from either operand",
    {
      kind: "arithmetic",
      op: "add",
      left: missingRef,
      right: numberLiteral(1),
    },
    isNotFound,
  ),
  expr(
    "arithmetic: wrong-type when an operand is non-numeric",
    wrongTypeArithmetic,
    isWrongType,
  ),
  expr(
    "arithmetic: domain-error on division by zero",
    divideByZero,
    isDomainError,
  ),

  // negate
  expr(
    "negate: not-found propagates from the operand",
    { kind: "negate", operand: missingRef },
    isNotFound,
  ),
  expr(
    "negate: wrong-type when the operand is not number/duration",
    {
      kind: "negate",
      operand: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
    },
    isWrongType,
  ),
  expr(
    "negate: never generates its own domain-error, but still carries one through from the operand",
    { kind: "negate", operand: divideByZero },
    isDomainError,
  ),

  // call
  expr(
    "call: not-found propagates from any argument, before the function is ever invoked",
    { kind: "call", fn: "identity", args: [missingRef] },
    isNotFound,
    {
      functions: {
        identity: () => {
          throw new Error(
            "unreachable: an indeterminate argument must short-circuit before the function is invoked",
          );
        },
      },
    },
  ),
  expr(
    "call: wrong-type for an unregistered function name",
    { kind: "call", fn: "doesNotExist", args: [] },
    isWrongType,
  ),
  expr(
    "call: domain-error when a registered function's argument is out of its valid domain",
    { kind: "call", fn: "reciprocal", args: [numberLiteral(0)] },
    isDomainError,
    {
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
    },
  ),

  // lookup
  expr(
    "lookup: not-found when a key expression is itself not-found",
    { kind: "lookup", table: "table1", keys: [missingRef] },
    isNotFound,
  ),
  expr(
    "lookup: not-found when the resolver reports no match",
    { kind: "lookup", table: "unknown-table", keys: [numberLiteral(1)] },
    isNotFound,
  ),
  expr(
    "lookup: wrong-type propagates from a key expression's own wrong-type evaluation",
    {
      kind: "lookup",
      table: "table1",
      keys: [{ kind: "reference", key: "present", unit: { s: 1 } }],
    },
    isWrongType,
  ),

  // conditional
  expr(
    "conditional: not-found from an unmatched guard evaluated before any earlier case matched",
    {
      kind: "conditional",
      cases: [
        { when: falseGuard, then: numberLiteral(1) },
        { when: missingGuard, then: numberLiteral(2) },
      ],
      fallback: numberLiteral(0),
    },
    isNotFound,
  ),
  expr(
    "conditional: wrong-type from the chosen branch's own result",
    {
      kind: "conditional",
      cases: [{ when: trueGuard, then: wrongTypeArithmetic }],
      fallback: numberLiteral(0),
    },
    isWrongType,
  ),
  expr(
    "conditional: domain-error from the chosen branch's own result",
    {
      kind: "conditional",
      cases: [{ when: trueGuard, then: divideByZero }],
      fallback: numberLiteral(0),
    },
    isDomainError,
  ),

  // fold
  expr(
    "fold (reduce): not-found from a participating item's combine step",
    {
      kind: "fold",
      collection: "single-notfound",
      combiner: {
        mode: "reduce",
        initial: numberLiteral(0),
        combine: {
          kind: "arithmetic",
          op: "add",
          left: { kind: "accumulator" },
          right: { kind: "reference", key: "value" },
        },
      },
    },
    isNotFound,
  ),
  expr(
    "fold (reduce): wrong-type from the initial expression",
    {
      kind: "fold",
      collection: "empty",
      combiner: {
        mode: "reduce",
        initial: wrongTypeArithmetic,
        combine: numberLiteral(0),
      },
    },
    isWrongType,
  ),
  expr(
    "fold (reduce): domain-error from a participating item's combine step",
    {
      kind: "fold",
      collection: "single-domainerror",
      combiner: {
        mode: "reduce",
        initial: numberLiteral(0),
        combine: {
          kind: "arithmetic",
          op: "add",
          left: { kind: "accumulator" },
          right: divideByZero,
        },
      },
    },
    isDomainError,
  ),
  expr(
    "fold: an indeterminate filter makes the whole fold indeterminate outright -- no absorption, unlike some/every",
    {
      kind: "fold",
      collection: "single-notfound",
      filter: {
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "value" },
        right: numberLiteral(1),
      },
      combiner: {
        mode: "reduce",
        initial: numberLiteral(0),
        combine: numberLiteral(1),
      },
    },
    isNotFound,
  ),
  expr(
    "fold (max): domain-error over an empty (post-filter) collection -- no first item to seed from",
    {
      kind: "fold",
      collection: "empty",
      combiner: { mode: "max", item: numberLiteral(0) },
    },
    isDomainError,
  ),
  expr(
    "fold (min): domain-error over an empty (post-filter) collection -- no first item to seed from",
    {
      kind: "fold",
      collection: "empty",
      combiner: { mode: "min", item: numberLiteral(0) },
    },
    isDomainError,
  ),
  expr(
    "fold (max): not-found from a participating item's own item expression",
    {
      kind: "fold",
      collection: "single-notfound",
      combiner: { mode: "max", item: { kind: "reference", key: "value" } },
    },
    isNotFound,
  ),

  // accumulator
  expr(
    "accumulator: wrong-type when used outside any fold's combine expression",
    { kind: "accumulator" },
    isWrongType,
  ),
  expr(
    "accumulator: definite inside a reduce fold's own combine expression",
    {
      kind: "fold",
      collection: "one-item",
      combiner: {
        mode: "reduce",
        initial: numberLiteral(reduceInitialSeed),
        combine: { kind: "accumulator" },
      },
    },
    isDefinite,
  ),
  expr(
    "accumulator: wrong-type inside a fold's filter (reset to undefined, even though a fold's own combine has one in scope)",
    {
      kind: "fold",
      collection: "one-item",
      filter: {
        kind: "compare",
        op: "eq",
        left: { kind: "accumulator" },
        right: numberLiteral(0),
      },
      combiner: {
        mode: "reduce",
        initial: numberLiteral(0),
        combine: numberLiteral(1),
      },
    },
    isWrongType,
  ),
  expr(
    "accumulator: wrong-type inside a max/min combiner's item (reset to undefined)",
    {
      kind: "fold",
      collection: "one-item",
      combiner: { mode: "max", item: { kind: "accumulator" } },
    },
    isWrongType,
  ),
  expr(
    "accumulator: wrong-type inside a reduce combiner's own initial, even nested inside an outer fold's combine where an accumulator IS in scope",
    {
      kind: "fold",
      collection: "one-item",
      combiner: {
        mode: "reduce",
        initial: numberLiteral(0),
        combine: {
          kind: "fold",
          collection: "empty",
          combiner: {
            mode: "reduce",
            initial: { kind: "accumulator" },
            combine: numberLiteral(0),
          },
        },
      },
    },
    isWrongType,
  ),

  // delegate
  expr(
    "delegate: wrong-type when no handler is registered for the named system",
    {
      kind: "delegate",
      system: "external-pricing-engine",
      payload: { foo: "bar" },
    },
    isWrongType,
  ),
  expr(
    "delegate: never domain-error, and not-found only when the handler itself reports absence",
    { kind: "delegate", system: "known", payload: null },
    isNotFound,
    {
      resolvers: {
        ...baseResolvers,
        resolveDelegate: async () => Promise.resolve({ found: false }),
      },
    },
  ),
  expr(
    "delegate: definite when the registered handler resolves a value",
    { kind: "delegate", system: "known", payload: null },
    isDefinite,
    {
      resolvers: {
        ...baseResolvers,
        resolveDelegate: async () =>
          Promise.resolve({
            found: true,
            value: { kind: "number", value: 1 },
          }),
      },
    },
  ),
];

describe("indeterminacy reference table", () => {
  it.each(fixtures)("$description", runFixture);
});

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
