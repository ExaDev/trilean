import { expect } from "vitest";
import type { Evaluation } from "./evaluation";
import type { Resolvers } from "./resolvers";

/** A resolver reporting a fixed `{ kind: "number", value: 10, unit: { m: 1 } }` for key `"present"`, and not-found for anything else -- `resolveLookup`/`resolveCollection` are never exercised by expression-level nodes and are stubbed only to satisfy `Resolvers`. Shared across the split `evaluator.*.test.ts` files below; a test needing genuinely different resolver behaviour spreads over it (`{ ...resolvers, resolveValue: ... }`) locally rather than mutating this shared instance. */
export const resolvers: Resolvers = {
  resolveValue: async (key) =>
    Promise.resolve(
      key === "present"
        ? { found: true, value: { kind: "number", value: 10, unit: { m: 1 } } }
        : { found: false },
    ),
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

export function expectDefinite<T>(
  evaluation: Evaluation<T>,
  expected: T,
): void {
  expect(evaluation).toEqual({ status: "definite", value: expected });
}

export function expectIndeterminate<T>(
  evaluation: Evaluation<T>,
  code: "not-found" | "wrong-type" | "domain-error",
): void {
  expect(evaluation.status).toBe("indeterminate");
  if (evaluation.status === "indeterminate") {
    expect(evaluation.reason.code).toBe(code);
  }
}

/** A narrowing type guard for a resolver context treated as a plain record, following this repo's `object -> Record<string, unknown>` narrowing convention rather than an `as Record<string, unknown>` assertion. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray`'s own lib.es5.d.ts type predicate narrows to `any[]`, not `unknown[]` -- this re-typed wrapper is what lets a `resolveCollection` stub return a properly `unknown[]`-typed result instead of an implicit `any[]`. */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
