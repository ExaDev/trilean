import { expect } from "vitest";
import {
  createEvaluator,
  evaluatePredicate,
  evaluateValue,
} from "./evaluator-factory";
import type { IndeterminateReason } from "./evaluation";
import type { FunctionRegistry } from "./functions";
import type { EvaluationContext, Resolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * Shared fixture machinery for the two split indeterminacy test files (evaluator.indeterminacy-table.test.ts, evaluator.indeterminacy-cases.test.ts): systematic, table-driven coverage of README.md's "Indeterminacy reference" section, one fixture per node-kind x reason-code combination that section documents, for every `PredicateNode`/`ExpressionNode` kind implemented. This complements, rather than replaces, the ad hoc behavioural tests already spread across the evaluator.*.test.ts files and truth-tables.test.ts.
 */

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** A single resolver pool shared by every fixture below, covering every named key/table/collection any fixture needs. Fixtures that need genuinely different resolver behaviour (the delegate/call rows) supply their own. */
export const baseResolvers: Resolvers = {
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

export const numberLiteral = (value: number): ExpressionNode => ({
  kind: "numberLiteral",
  value,
});
export const missingRef: ExpressionNode = {
  kind: "reference",
  key: "missing",
};
export const divideByZero: ExpressionNode = {
  kind: "arithmetic",
  op: "divide",
  left: numberLiteral(1),
  right: numberLiteral(0),
};
export const wrongTypeArithmetic: ExpressionNode = {
  kind: "arithmetic",
  op: "add",
  left: { kind: "textLiteral", value: "x" },
  right: numberLiteral(1),
};
export const trueGuard: PredicateNode = {
  kind: "compare",
  op: "eq",
  left: numberLiteral(1),
  right: numberLiteral(1),
};
export const falseGuard: PredicateNode = {
  kind: "compare",
  op: "eq",
  left: numberLiteral(1),
  right: numberLiteral(2),
};
export const missingGuard: PredicateNode = {
  kind: "compare",
  op: "eq",
  left: missingRef,
  right: numberLiteral(1),
};

/** Arbitrary non-`{-1,0,1,2}` magnitudes used below, named individually so each numeric literal only appears once (`@typescript-eslint/no-magic-numbers` only exempts -1/0/1/2 and object-literal property values, not values passed as plain call arguments). */
export const memberOfProbeValue = 5;
export const reduceInitialSeed = 5;
export const laterConditionalCaseValue = 3;
export const untouchedReduceInitial = 42;
export const uniqueHitPolicyThirdCaseValue = 3;

// --- Fixture machinery ---

export type Expected =
  | { readonly status: "definite" }
  | {
      readonly status: "indeterminate";
      readonly code: IndeterminateReason["code"];
    };

export const isDefinite: Expected = { status: "definite" };
export const isNotFound: Expected = {
  status: "indeterminate",
  code: "not-found",
};
export const isWrongType: Expected = {
  status: "indeterminate",
  code: "wrong-type",
};
export const isDomainError: Expected = {
  status: "indeterminate",
  code: "domain-error",
};

/** The minimal shape `runFixture` needs from either `evaluatePredicate`'s or `evaluateValue`'s result -- both `Evaluation<boolean>` and `Evaluation<ComputedValue>` are structurally assignable here since only the indeterminate branch's `reason` is ever inspected, never the definite branch's `value`. Typing `Fixture.run`'s result as this proper discriminated union, rather than the looser `{ status: string }` it replaces, is what lets `runFixture` below narrow `result.reason` directly instead of needing a type assertion. */
type FixtureRunResult =
  | { readonly status: "definite" }
  | {
      readonly status: "indeterminate";
      readonly reason: IndeterminateReason;
    };

export interface Fixture {
  readonly description: string;
  readonly expected: Expected;
  readonly run: () => Promise<FixtureRunResult>;
}

export interface FixtureOverrides {
  readonly context?: EvaluationContext;
  readonly resolvers?: Resolvers;
  readonly functions?: FunctionRegistry;
}

export function pred(
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

export function expr(
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

export async function runFixture({ run, expected }: Fixture): Promise<void> {
  const result = await run();
  expect(result.status).toBe(expected.status);
  if (
    expected.status === "indeterminate" &&
    result.status === "indeterminate"
  ) {
    expect(result.reason.code).toBe(expected.code);
  }
}
