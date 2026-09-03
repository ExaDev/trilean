import type { ComputedValue } from "./computed-value";

/**
 * Named functions available to a `call` expression node, supplied once at evaluator construction time (see `createEvaluator` in evaluator.ts) rather than per evaluation call. A function reports a domain violation (e.g. `squareRoot` given a negative number) by returning a `domainError` rather than throwing -- this keeps `call` inside the same three-outcome model as every other node kind.
 */
export type FunctionRegistry = Record<
  string,
  (args: readonly ComputedValue[]) => ComputedValue | { domainError: string }
>;

export const emptyFunctionRegistry: FunctionRegistry = {};
