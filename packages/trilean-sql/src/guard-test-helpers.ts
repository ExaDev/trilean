import type { PredicateNode } from "trilean";

/** Shared across the split `guard.*.test.ts` files below -- a pushable comparison used as filler in trees whose real subject is something else entirely (an unrelated node kind, a collection wrapper). */
export const ageOver: PredicateNode = {
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "age" },
  right: { kind: "numberLiteral", value: 18 },
};
