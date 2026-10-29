import { z } from "zod";

/**
 * Every evaluation -- of a predicate node or an expression node -- produces exactly one of two outcomes: a definite result, or an indeterminate result carrying a reason. Never a bare boolean/number, and never a thrown exception for a data-quality problem.
 */
export type Evaluation<T> =
  | { status: "definite"; value: T }
  | { status: "indeterminate"; reason: IndeterminateReason };

export const IndeterminateReasonSchema = z.object({
  /** Which of the four reason categories applies. `not-yet-known` is the only one that is not a property of the data: it says a resolver has not been supplied the value yet, so a later evaluation may settle it either way. */
  code: z.enum(["not-found", "not-yet-known", "wrong-type", "domain-error"]),
  /** A human-readable explanation, for logging and debugging. */
  message: z.string(),
});

export type IndeterminateReason = z.infer<typeof IndeterminateReasonSchema>;

export function definite<T>(value: T): Evaluation<T> {
  return { status: "definite", value };
}

export function indeterminate(
  code: IndeterminateReason["code"],
  message: string,
): Evaluation<never> {
  return { status: "indeterminate", reason: { code, message } };
}

/**
 * Implements the tie-break rule from "The evaluation model": when several sub-evaluations could each independently be indeterminate for a different reason, take the first indeterminate reason encountered in the node's own declared operand order, except that a `not-yet-known` reason outranks every other. Entries that are `undefined` (an operand not yet evaluated, or not applicable to this node kind) are skipped rather than treated as indeterminate.
 *
 * The exception exists because this function is only called where a later outcome can still absorb an indeterminate one (`and`, `or`, `memberOf`, a `unique` conditional). Reporting `not-found` for such a node while another operand is still `not-yet-known` would be wrong: that operand might settle as a definite absorbing value, and the node would then be definite where `exists` had already reported its absence. Preferring `not-yet-known` keeps every non-`not-yet-known` reason a statement that no completion of the unknown values can overturn.
 */
export function firstIndeterminate(
  ...results: readonly (Evaluation<unknown> | undefined)[]
): IndeterminateReason | undefined {
  let first: IndeterminateReason | undefined;
  for (const result of results) {
    if (result?.status !== "indeterminate") continue;
    if (result.reason.code === "not-yet-known") return result.reason;
    first ??= result.reason;
  }

  return first;
}
