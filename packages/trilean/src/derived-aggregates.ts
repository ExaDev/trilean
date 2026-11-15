import type { JsonValue } from "./json-value";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * `sum`, `count`, and `average` are never their own `FoldCombiner` mode -- each is a builder function that assembles an ordinary `fold` (and, for `average`, one `arithmetic` division of two ordinary folds), exactly the same treatment `derived-connectives.ts` already gives `xor`/`nand`/`nor`/`implies`/`iff`/`none` (see the "Derived aggregates" section of README.md).
 */
export const sum = (
  collection: JsonValue,
  item: ExpressionNode,
  filter?: PredicateNode,
): ExpressionNode => ({
  kind: "fold",
  collection,
  filter,
  combiner: {
    mode: "reduce",
    initial: { kind: "numberLiteral", value: 0 },
    combine: {
      kind: "arithmetic",
      op: "add",
      left: { kind: "accumulator" },
      right: item,
    },
  },
});

export const presenceOf = (probe: ExpressionNode): ExpressionNode => ({
  kind: "conditional",
  cases: [
    {
      when: {
        kind: "memberOf",
        op: "in",
        operand: probe,
        candidates: [probe],
      },
      then: { kind: "numberLiteral", value: 1 },
    },
  ],
  // unreachable: a definite probe is always a member of the single-element list containing only itself
  fallback: { kind: "numberLiteral", value: 0 },
});

/** What `count` takes beside the collection. */
export interface CountOptions {
  /** Excludes an item from the count: a filtered-out item is as if it were not in the collection. */
  filter?: PredicateNode;
  /** Makes the whole count indeterminate when it does not resolve for any item that takes part. */
  probe?: ExpressionNode;
}

/** Whether a second argument of `count` is an options object or absent, and not a node or another value that a caller written for `count(collection, filter, probe)` passes, which an options object would read as nothing. */
function isOptions(value: unknown): value is CountOptions | undefined {
  return (
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !Object.hasOwn(value, "kind"))
  );
}

export const count = (
  collection: JsonValue,
  ...rest: readonly [options?: CountOptions]
): ExpressionNode => {
  const [options]: readonly unknown[] = rest;
  if (rest.length > 1 || !isOptions(options)) {
    throw new TypeError(
      "count takes its filter and probe as one options object, count(collection, { filter, probe }), and was given something else",
    );
  }
  const { filter, probe }: CountOptions = options ?? {};

  return {
    kind: "fold",
    collection,
    filter,
    combiner: {
      mode: "reduce",
      initial: { kind: "numberLiteral", value: 0 },
      combine: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "accumulator" },
        right: probe ? presenceOf(probe) : { kind: "numberLiteral", value: 1 },
      },
    },
  };
};

export const average = (
  collection: JsonValue,
  item: ExpressionNode,
  filter?: PredicateNode,
): ExpressionNode => ({
  kind: "arithmetic",
  op: "divide",
  left: sum(collection, item, filter),
  right: count(collection, { filter }),
});
