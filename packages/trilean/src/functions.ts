import type { ComputedValue } from "./computed-value";

/** What a registered function returns instead of a value when it cannot produce one: a `domainError` for an argument of the right kind outside the function's domain (`squareRoot` of a negative number), or a `wrongType` for an argument the function cannot accept at all (the wrong kind, or units that do not match). They surface as `domain-error` and `wrong-type` respectively, the same split every other node kind draws. */
export type FunctionFailure = { domainError: string } | { wrongType: string };

/**
 * Named functions available to a `call` expression node, supplied once at evaluator construction time (see `createEvaluator` in evaluator-factory.ts) rather than per evaluation call. A function reports a failure by returning a `FunctionFailure` rather than throwing, which keeps `call` inside the same three-outcome model as every other node kind.
 */
export type FunctionRegistry = Record<
  string,
  (args: readonly ComputedValue[]) => ComputedValue | FunctionFailure
>;

export const emptyFunctionRegistry: FunctionRegistry = {};
