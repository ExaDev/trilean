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
  fallback: { kind: "numberLiteral", value: 0 }, // unreachable: a definite probe is always a member of the single-element list containing only itself
});

export const count = (
  collection: JsonValue,
  filter?: PredicateNode,
  probe?: ExpressionNode,
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
      right: probe ? presenceOf(probe) : { kind: "numberLiteral", value: 1 },
    },
  },
});

export const average = (
  collection: JsonValue,
  item: ExpressionNode,
  filter?: PredicateNode,
): ExpressionNode => ({
  kind: "arithmetic",
  op: "divide",
  left: sum(collection, item, filter),
  right: count(collection, filter),
});
