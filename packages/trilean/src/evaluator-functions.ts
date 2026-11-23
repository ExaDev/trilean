import type { ComputedValue } from "./computed-value";
import { valueEntryCount } from "./computed-value";
import { type Evaluation, definite, indeterminate } from "./evaluation";
import type { EvaluationBudget } from "./evaluator-budget";
import { resourceExhausted } from "./evaluator-budget";
import type { FunctionRegistry } from "./functions";
import { matrixWork } from "./matrix-functions";

/** `call`'s own function-registry dispatch, given the `fn` name off the tree and its already-evaluated `args`. `node.fn` comes off the serialised tree, which this design treats as data that may have been authored anywhere (see README.md's opening section), while `FunctionRegistry` is an ordinary object with `Object.prototype` on its chain. A bare index lookup would therefore resolve `toString`, `valueOf`, `constructor` and friends as though a consumer had registered them; only the registry's own keys count as registered function names. */
export function invokeRegisteredFunction(
  functions: Readonly<FunctionRegistry>,
  fnName: string,
  args: readonly ComputedValue[],
  budget: Readonly<EvaluationBudget>,
): Evaluation<ComputedValue> {
  const fn = Object.hasOwn(functions, fnName) ? functions[fnName] : undefined;
  if (fn === undefined) {
    return indeterminate(
      "wrong-type",
      `no function registered under the name '${fnName}'`,
    );
  }
  // The work on lists is charged before it runs, as the entries read, so a list too large to work on is never worked on: the exhausted budget is the existing resource-exhausted result.
  const exhausted = budget.chargeWork(
    args.reduce((total, arg) => total + valueEntryCount(arg), 0) +
      matrixWork(fnName, args),
  );
  if (exhausted !== undefined) return exhausted;
  const outcome = fn(args);
  if ("domainError" in outcome) {
    return indeterminate("domain-error", outcome.domainError);
  }
  if ("wrongType" in outcome) {
    return indeterminate("wrong-type", outcome.wrongType);
  }

  if (valueEntryCount(outcome) > budget.maxValueEntries) {
    return resourceExhausted(
      `a function result holds more than the maximum of ${budget.maxValueEntries.toString()} list entries (resource exhausted)`,
    );
  }

  return definite(outcome);
}
