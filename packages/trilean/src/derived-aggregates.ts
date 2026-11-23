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

const callOf = (
  fn: string,
  ...args: readonly ExpressionNode[]
): ExpressionNode => ({
  kind: "call",
  fn,
  args: [...args],
});

/**
 * The list of `item` evaluated for each participating item, in collection order: a `reduce` fold whose accumulator is a list, which `append`s one entry per item. Like `sum`, it is a builder over `fold` and adds no evaluator logic; it needs the `list` and `append` functions in the registry, which the built-in functions hold.
 */
export const map = (
  collection: JsonValue,
  item: ExpressionNode,
  filter?: PredicateNode,
): ExpressionNode => ({
  kind: "fold",
  collection,
  filter,
  combiner: {
    mode: "reduce",
    initial: callOf("list"),
    combine: callOf("append", { kind: "accumulator" }, item),
  },
});

/** The list of `item` for the items that satisfy `predicate`: `map` with the filter given first and required. */
export const filter = (
  collection: JsonValue,
  predicate: PredicateNode,
  item: ExpressionNode,
): ExpressionNode => map(collection, item, predicate);

/**
 * The `result` of the participating item whose `key` is least (`argmin`) or greatest (`argmax`), in one pass: the accumulator is a two-entry list of the best key so far and its result, replaced only by a strictly better key, so a tie keeps the first item in collection order, the order `fold` visits. With no participating item the pass leaves an empty list, and reading its result is an indeterminate `domain-error`, since no item is the least. It needs the `list`, `append`, `length` and `at` functions in the registry, which the built-in functions hold.
 */
/** What `argmin` and `argmax` share: the collection, the expression compared, the expression returned and the optional filter on which items take part. */
interface ArgumentsOfArgExtremum {
  collection: JsonValue;
  key: ExpressionNode;
  result: ExpressionNode;
  participating?: PredicateNode;
}

const argExtremum = (
  better: "lt" | "gt",
  { collection, key, result, participating }: ArgumentsOfArgExtremum,
): ExpressionNode => {
  const accumulator: ExpressionNode = { kind: "accumulator" };

  return callOf(
    "at",
    {
      kind: "fold",
      collection,
      filter: participating,
      combiner: {
        mode: "reduce",
        initial: callOf("list"),
        combine: {
          kind: "conditional",
          cases: [
            {
              when: {
                kind: "or",
                left: {
                  kind: "compare",
                  op: "eq",
                  left: callOf("length", accumulator),
                  right: { kind: "numberLiteral", value: 0 },
                },
                right: {
                  kind: "compare",
                  op: better,
                  left: key,
                  right: callOf("at", accumulator, {
                    kind: "numberLiteral",
                    value: 0,
                  }),
                },
              },
              then: callOf("list", key, result),
            },
          ],
          fallback: accumulator,
        },
      },
    },
    { kind: "numberLiteral", value: 1 },
  );
};

export const argmin = (
  collection: JsonValue,
  key: ExpressionNode,
  result: ExpressionNode,
  participating?: PredicateNode,
): ExpressionNode =>
  argExtremum("lt", { collection, key, result, participating });

export const argmax = (
  collection: JsonValue,
  key: ExpressionNode,
  result: ExpressionNode,
  participating?: PredicateNode,
): ExpressionNode =>
  argExtremum("gt", { collection, key, result, participating });
