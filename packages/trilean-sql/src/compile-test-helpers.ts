import type { PredicateNode } from "trilean";
import { compilePredicateNode } from "./compile";
import type { SqlCompileOptions } from "./options";
import { subjectOptions } from "./test-support/columns";

/** Compiles against `subjectOptions` by default, so each split `compile.*.test.ts` file below only has to name a dialect/column configuration explicitly when it actually differs from the shared default. */
export function compile(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions> = subjectOptions,
) {
  return compilePredicateNode(node, options);
}

// Named rather than written twice, so each case's expected `params` is the same value the tree was built from rather than a literal that could drift away from it.
export const ADULT_AGE = 18;
export const SAMPLE_AGE = 40;
export const EXCLUDED_AGE = 7;
export const LOWER_BOUND = 1;
export const UPPER_BOUND = 4;

export const ageOver: PredicateNode = {
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "age" },
  right: { kind: "numberLiteral", value: ADULT_AGE },
};
