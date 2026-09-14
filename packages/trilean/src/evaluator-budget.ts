import type { Evaluation } from "./evaluation";
import { indeterminate } from "./evaluation";

/** A defense-in-depth guard against a long acyclic `treeReference` chain exhausting the call stack -- distinct from, and layered on top of, the cycle detector in evaluator.ts (`visitedTreeKeys`), which catches an actual repeat immediately and more precisely. */
export const MAX_TREE_REFERENCE_DEPTH = 100;

/** Default cap on the total number of predicate/expression nodes a single `evaluatePredicate`/`evaluateValue` call may visit -- see `createEvaluator`'s `maxNodes` option, threaded through to `createEvaluationBudget` below. Chosen generously above any realistic hand-authored business-rule, eligibility, or formula tree (see README.md's own consumer use cases), while still bounding an untrusted, adversarially-authored tree's total evaluation cost to a fixed, small amount of work regardless of how it is shaped. */
export const DEFAULT_MAX_EVALUATION_NODES = 10_000;

/** Default cap on ordinary recursive-descent nesting depth -- see `createEvaluator`'s `maxNestingDepth` option, threaded through to `createEvaluationBudget` below. Set comfortably below the depth at which this evaluator's own recursive descent has been observed to exhaust the host call stack (a chain of plain `not` nodes wrapped around a single leaf, evaluated directly against this file under Node.js, failed consistently somewhere in the low thousands of nesting levels, with some run-to-run variance from whatever else already occupied the stack), while remaining far deeper than any legitimate hand-authored tree is ever likely to nest. Kept well clear of that measured failure point because the exact threshold varies by host runtime (a Cloudflare Workers isolate's own stack is smaller than Node's) and by how much of the stack the rest of the call chain has already used. */
export const DEFAULT_MAX_NESTING_DEPTH = 500;

/**
 * A single `evaluatePredicate`/`evaluateValue` call's resource limits, independent of and layered underneath `MAX_TREE_REFERENCE_DEPTH`'s own cross-tree chain guard above: that guard only advances at an actual `treeReference` resolution and says nothing about a plain, self-contained tree built from ordinary `and`/`or`/`fold`/`conditional`/quantifier nesting, with no `treeReference` node anywhere in it. This closes that gap for a consumer evaluating a tree it did not author and cannot fully trust before evaluation (e.g. a tree embedded in a signed but otherwise attacker-controlled payload).
 *
 * Exposed as a single `checkNode` method rather than a raw mutable counter, following the same all-callback shape `Resolvers` and `FunctionRegistry` use in evaluator.ts: every recursive call site threads this object through as `Readonly<EvaluationBudget>`, and that wrapper genuinely prevents tampering because the running node count lives in `createEvaluationBudget`'s own closure, never as an assignable property on the object itself.
 */
export interface EvaluationBudget {
  /** Charges one node visit and checks both caps, returning the `Evaluation` to return immediately if either is now exceeded, or `undefined` if evaluation of this node may proceed. Called as the very first action inside `evaluatePredicateInternal`/`evaluateValueInternal`, before any of that node's own work or further recursion, so an exceeded budget is discovered before it can be spent on additional descent. */
  checkNode: (nestingDepth: number) => Evaluation<never> | undefined;
}

/** Constructs a fresh `EvaluationBudget` for one top-level `evaluatePredicate`/`evaluateValue` call -- see `createEvaluator`'s `maxNodes`/`maxNestingDepth` options, which supply `maxNodes`/`maxNestingDepth` here. A fresh closure per call is what keeps `nodesVisited` from leaking between unrelated evaluations. */
export function createEvaluationBudget(
  maxNodes: number,
  maxNestingDepth: number,
): EvaluationBudget {
  /** Total predicate/expression nodes visited so far across the whole call -- shared by every branch of an `and`/`or`/`allOf`/`anyOf`/fold/quantifier through the closure below, so it accumulates across the whole traversal rather than resetting per branch. */
  let nodesVisited = 0;
  return {
    checkNode(nestingDepth) {
      nodesVisited += 1;
      if (nodesVisited > maxNodes) {
        return indeterminate(
          "domain-error",
          `evaluation exceeded the maximum of ${maxNodes.toString()} nodes visited in a single call (resource exhausted)`,
        );
      }
      // Distinct from `MAX_TREE_REFERENCE_DEPTH`'s own chain-depth counter: `nestingDepth` advances on every recursive descent into a child predicate/expression node, not only at `treeReference` resolution.
      if (nestingDepth >= maxNestingDepth) {
        return indeterminate(
          "domain-error",
          `evaluation nesting depth exceeds the maximum of ${maxNestingDepth.toString()} (resource exhausted)`,
        );
      }
      return undefined;
    },
  };
}
