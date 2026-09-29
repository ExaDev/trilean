import type { ComputedValue } from "./computed-value";
import type { Evaluation } from "./evaluation";
import {
  DEFAULT_MAX_EVALUATION_NODES,
  DEFAULT_MAX_NESTING_DEPTH,
  createEvaluationBudget,
} from "./evaluator-budget";
import { evaluatePredicateInternal, evaluateValueInternal } from "./evaluator";
import type { FunctionRegistry } from "./functions";
import { emptyFunctionRegistry } from "./functions";
import { runAsync, runSync } from "./evaluator-effect";
import type { EvaluationContext, Resolvers, SyncResolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * Builds a bound `{ evaluatePredicate, evaluateValue }` pair over a caller-supplied function registry for `call` nodes -- the registry is bound once, at construction time, unlike `resolvers`, which are supplied fresh to every call. `maxNodes` and `maxNestingDepth` configure that same pair's own `EvaluationBudget` (see its doc comment in evaluator-budget.ts), created fresh for every top-level `evaluatePredicate`/`evaluateValue` invocation so budgets never leak between unrelated calls. The bare module-level `evaluatePredicate`/`evaluateValue` exports below are `createEvaluator({})`'s output, so both caps default to `DEFAULT_MAX_EVALUATION_NODES`/`DEFAULT_MAX_NESTING_DEPTH` for every caller that does not explicitly configure them.
 */
/** Options shared by `createEvaluator` and `createSyncEvaluator`. */
export interface EvaluatorOptions {
  functions?: FunctionRegistry;
  /** Caps the total number of predicate/expression nodes a single `evaluatePredicate`/`evaluateValue` call may visit -- see `createEvaluationBudget`. Defaults to `DEFAULT_MAX_EVALUATION_NODES`. */
  maxNodes?: number;
  /** Caps ordinary recursive-descent nesting depth, independent of `MAX_TREE_REFERENCE_DEPTH`'s own `treeReference` chain-depth cap -- see `createEvaluationBudget`. Defaults to `DEFAULT_MAX_NESTING_DEPTH`. */
  maxNestingDepth?: number;
}

/**
 * Builds a bound `{ evaluatePredicate, evaluateValue }` pair over a caller-supplied function registry for `call` nodes -- the registry is bound once, at construction time, unlike `resolvers`, which are supplied fresh to every call. `maxNodes` and `maxNestingDepth` configure that same pair's own `EvaluationBudget` (see its doc comment in evaluator-budget.ts), created fresh for every top-level `evaluatePredicate`/`evaluateValue` invocation so budgets never leak between unrelated calls. The bare module-level `evaluatePredicate`/`evaluateValue` exports below are `createEvaluator({})`'s output, so both caps default to `DEFAULT_MAX_EVALUATION_NODES`/`DEFAULT_MAX_NESTING_DEPTH` for every caller that does not explicitly configure them.
 */
export function createEvaluator({
  functions = emptyFunctionRegistry,
  maxNodes = DEFAULT_MAX_EVALUATION_NODES,
  maxNestingDepth = DEFAULT_MAX_NESTING_DEPTH,
}: EvaluatorOptions): {
  evaluatePredicate: (
    node: PredicateNode,
    context: EvaluationContext,
    resolvers: Readonly<Resolvers>,
  ) => Promise<Evaluation<boolean>>;
  evaluateValue: (
    node: ExpressionNode,
    context: EvaluationContext,
    resolvers: Readonly<Resolvers>,
  ) => Promise<Evaluation<ComputedValue>>;
} {
  return {
    evaluatePredicate: async (node, context, resolvers) =>
      runAsync(
        evaluatePredicateInternal(
          node,
          context,
          resolvers,
          undefined,
          functions,
          new Set(),
          0,
          createEvaluationBudget(maxNodes, maxNestingDepth),
          0,
        ),
      ),
    evaluateValue: async (node, context, resolvers) =>
      runAsync(
        evaluateValueInternal(
          node,
          context,
          resolvers,
          undefined,
          functions,
          new Set(),
          0,
          createEvaluationBudget(maxNodes, maxNestingDepth),
          0,
        ),
      ),
  };
}

/**
 * The synchronous counterpart of `createEvaluator`: the same node rules, options and `Evaluation` results, over `SyncResolvers`, returning the result directly instead of a promise. It runs the same implementation as the asynchronous evaluator, so the two cannot disagree about a node. One difference follows from having nothing to wait on: independent operands (both sides of an `and`, the candidates of a `memberOf`, the items of a collection) are evaluated one after another rather than concurrently, so when a `maxNodes` or `maxNestingDepth` budget is exhausted partway through a tree, which operand meets the limit first can differ from the asynchronous evaluator.
 */
export function createSyncEvaluator({
  functions = emptyFunctionRegistry,
  maxNodes = DEFAULT_MAX_EVALUATION_NODES,
  maxNestingDepth = DEFAULT_MAX_NESTING_DEPTH,
}: EvaluatorOptions): {
  evaluatePredicate: (
    node: PredicateNode,
    context: EvaluationContext,
    resolvers: Readonly<SyncResolvers>,
  ) => Evaluation<boolean>;
  evaluateValue: (
    node: ExpressionNode,
    context: EvaluationContext,
    resolvers: Readonly<SyncResolvers>,
  ) => Evaluation<ComputedValue>;
} {
  return {
    evaluatePredicate: (node, context, resolvers) =>
      runSync(
        evaluatePredicateInternal(
          node,
          context,
          resolvers,
          undefined,
          functions,
          new Set(),
          0,
          createEvaluationBudget(maxNodes, maxNestingDepth),
          0,
        ),
      ),
    evaluateValue: (node, context, resolvers) =>
      runSync(
        evaluateValueInternal(
          node,
          context,
          resolvers,
          undefined,
          functions,
          new Set(),
          0,
          createEvaluationBudget(maxNodes, maxNestingDepth),
          0,
        ),
      ),
  };
}

export const { evaluatePredicate, evaluateValue } = createEvaluator({});
