import { z } from "zod";

/**
 * Every evaluation -- of a predicate node or an expression node -- produces exactly one of two outcomes: a definite result, or an indeterminate result carrying a reason. Never a bare boolean/number, and never a thrown exception for a data-quality problem.
 */
export type Evaluation<T> =
  | { status: "definite"; value: T }
  | { status: "indeterminate"; reason: IndeterminateReason };

export const IndeterminateReasonSchema = z.object({
  /** Which of the three reason categories applies. */
  code: z.enum(["not-found", "wrong-type", "domain-error"]),
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
 * Implements the tie-break rule from "The evaluation model": when several sub-evaluations could each independently be indeterminate for a different reason, take the first indeterminate reason encountered in the node's own declared operand order. Entries that are `undefined` (an operand not yet evaluated, or not applicable to this node kind) are skipped rather than treated as indeterminate.
 */
export function firstIndeterminate(
  ...results: readonly (Evaluation<unknown> | undefined)[]
): IndeterminateReason | undefined {
  for (const result of results) {
    if (result?.status === "indeterminate") return result.reason;
  }
  return undefined;
}
