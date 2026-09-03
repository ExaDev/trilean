import type { JsonValue } from "./json-value";
import type { PredicateNode } from "./tree";

/**
 * `not`/`and`/`or` are the primitive `PredicateNode` object-constructors -- everything else in this file is built purely by composing these three, so its three-valued correctness is inherited from the already-verified AND/OR/NOT tables rather than requiring a separate proof (see the "Derived connectives" section of README.md).
 */
export const not = (a: PredicateNode): PredicateNode => ({
  kind: "not",
  operand: a,
});
export const and = (a: PredicateNode, b: PredicateNode): PredicateNode => ({
  kind: "and",
  left: a,
  right: b,
});
export const or = (a: PredicateNode, b: PredicateNode): PredicateNode => ({
  kind: "or",
  left: a,
  right: b,
});

export const xor = (a: PredicateNode, b: PredicateNode): PredicateNode =>
  or(and(a, not(b)), and(not(a), b));
export const nand = (a: PredicateNode, b: PredicateNode): PredicateNode =>
  not(and(a, b));
export const nor = (a: PredicateNode, b: PredicateNode): PredicateNode =>
  not(or(a, b));
export const implies = (a: PredicateNode, b: PredicateNode): PredicateNode =>
  or(not(a), b);
export const iff = (a: PredicateNode, b: PredicateNode): PredicateNode =>
  not(xor(a, b));

export const none = (
  collection: JsonValue,
  item: PredicateNode,
  filter?: PredicateNode,
): PredicateNode => not({ kind: "some", collection, item, filter });
