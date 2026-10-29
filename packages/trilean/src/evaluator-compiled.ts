import type { ComputedValue } from "./computed-value";
import {
  type Evaluation,
  definite,
  firstIndeterminate,
  indeterminate,
} from "./evaluation";
import {
  type EvaluationBudget,
  createEvaluationBudget,
} from "./evaluator-budget";
import { evaluatePredicateInternal, evaluateValueInternal } from "./evaluator";
import { runSync, settleSync } from "./evaluator-effect";
import { literalValue } from "./evaluator-literals";
import {
  absenceEvaluation,
  applyArithmetic,
  applyNegate,
  checkReferenceUnit,
  combineAnd,
  combineOr,
  compareText,
  compareValues,
  computeMembershipMatch,
  invokeRegisteredFunction,
} from "./evaluator-operations";
import type { FunctionRegistry } from "./functions";
import type { EvaluationContext, SyncResolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * A predicate tree prepared for repeated evaluation: the same result as `createSyncEvaluator`'s `evaluatePredicate` over the tree it was compiled from, for any context and resolvers.
 */
export type CompiledPredicate = (
  context: EvaluationContext,
  resolvers: Readonly<SyncResolvers>,
) => Evaluation<boolean>;

/**
 * One compiled node: the node's evaluation over the call's context and resolvers, with the call's budget threaded through for the nodes that charge it (see `NodeCompiler`'s `counted`).
 */
type Run<T> = (
  context: EvaluationContext,
  resolvers: Readonly<SyncResolvers>,
  budget: Readonly<EvaluationBudget>,
) => Evaluation<T>;

/** Never charged: handed to the nodes of a tree compiled without budget counting, none of which reads it. */
const UNLIMITED_BUDGET: EvaluationBudget = { checkNode: () => undefined };

/** The `visitedTreeKeys` of a call that has not entered any `treeReference`; the interpreter copies it rather than mutating it, so one instance serves every call. */
const NO_TREE_KEYS: ReadonlySet<string> = new Set();

/** The message for the `accumulator` node outside a fold's `combine`, which is everywhere a compiled node can sit. */
const ACCUMULATOR_OUTSIDE_FOLD =
  "accumulator used outside a reduce fold's combine expression";

/** Compiles the nodes of one tree, for one setting of `counted`. */
class NodeCompiler {
  /** The number of nodes compiled natively so far; an upper bound on the nodes one evaluation can visit, because every compiled node is visited at most once per call. */
  nodesCompiled = 0;

  /** Whether any node was left to the interpreter. */
  interpreted = false;

  /**
   * `functions` is the registry `call` nodes resolve against. A node at `maxNestingDepth` or deeper is left to the interpreter, so compilation never descends further than an evaluation would. `counted` says whether every compiled node charges the call's `EvaluationBudget` before doing its own work, exactly as the interpreter does; a tree that can never exhaust its budget is compiled with it off, which removes the charge from every node.
   */
  constructor(
    private readonly functions: Readonly<FunctionRegistry>,
    private readonly maxNestingDepth: number,
    private readonly counted: boolean,
  ) {}

  /** In a counted tree, charges the budget for the node before running it; otherwise `run` as it is. */
  private charged<T>(depth: number, run: Run<T>): Run<T> {
    if (!this.counted) return run;

    return (context, resolvers, budget) =>
      budget.checkNode(depth) ?? run(context, resolvers, budget);
  }

  /** A node left to the interpreter. The interpreter charges the budget for it and its descendants itself, so this is not wrapped in `charged`. */
  private interpretedPredicate(
    node: PredicateNode,
    depth: number,
  ): Run<boolean> {
    this.interpreted = true;
    const { functions } = this;

    return (context, resolvers, budget) =>
      runSync(
        evaluatePredicateInternal(
          node,
          context,
          resolvers,
          undefined,
          functions,
          NO_TREE_KEYS,
          0,
          budget,
          depth,
        ),
      );
  }

  private interpretedValue(
    node: ExpressionNode,
    depth: number,
  ): Run<ComputedValue> {
    this.interpreted = true;
    const { functions } = this;

    return (context, resolvers, budget) =>
      runSync(
        evaluateValueInternal(
          node,
          context,
          resolvers,
          undefined,
          functions,
          NO_TREE_KEYS,
          0,
          budget,
          depth,
        ),
      );
  }

  predicate(node: PredicateNode, depth: number): Run<boolean> {
    if (depth >= this.maxNestingDepth) {
      return this.interpretedPredicate(node, depth);
    }
    this.nodesCompiled += 1;
    const child = (operand: PredicateNode): Run<boolean> =>
      this.predicate(operand, depth + 1);
    const value = (operand: ExpressionNode): Run<ComputedValue> =>
      this.value(operand, depth + 1, false);
    switch (node.kind) {
      case "not": {
        const operand = child(node.operand);

        return this.charged(depth, (context, resolvers, budget) => {
          const result = operand(context, resolvers, budget);

          return result.status === "indeterminate"
            ? result
            : definite(!result.value);
        });
      }
      case "and": {
        const left = child(node.left);
        const right = child(node.right);

        return this.charged(depth, (context, resolvers, budget) => {
          const leftResult = left(context, resolvers, budget);
          const rightResult = right(context, resolvers, budget);

          return combineAnd(leftResult, rightResult);
        });
      }
      case "or": {
        const left = child(node.left);
        const right = child(node.right);

        return this.charged(depth, (context, resolvers, budget) => {
          const leftResult = left(context, resolvers, budget);
          const rightResult = right(context, resolvers, budget);

          return combineOr(leftResult, rightResult);
        });
      }
      case "allOf": {
        const operands = node.operands.map(child);

        return this.charged(depth, (context, resolvers, budget) => {
          let combined: Evaluation<boolean> = definite(true);
          for (const operand of operands) {
            combined = combineAnd(
              combined,
              operand(context, resolvers, budget),
            );
          }

          return combined;
        });
      }
      case "anyOf": {
        const operands = node.operands.map(child);

        return this.charged(depth, (context, resolvers, budget) => {
          let combined: Evaluation<boolean> = definite(false);
          for (const operand of operands) {
            combined = combineOr(combined, operand(context, resolvers, budget));
          }

          return combined;
        });
      }
      case "compare": {
        const left = value(node.left);
        const right = value(node.right);
        const { op } = node;

        return this.charged(depth, (context, resolvers, budget) => {
          const leftResult = left(context, resolvers, budget);
          const rightResult = right(context, resolvers, budget);
          if (leftResult.status === "indeterminate") return leftResult;
          if (rightResult.status === "indeterminate") return rightResult;

          return compareValues(op, leftResult.value, rightResult.value);
        });
      }
      case "textCompare": {
        const left = value(node.left);
        const right = value(node.right);
        const { op } = node;

        return this.charged(depth, (context, resolvers, budget) => {
          const leftResult = left(context, resolvers, budget);
          const rightResult = right(context, resolvers, budget);
          if (leftResult.status === "indeterminate") return leftResult;
          if (rightResult.status === "indeterminate") return rightResult;

          return compareText(op, leftResult.value, rightResult.value);
        });
      }
      case "memberOf": {
        const operand = value(node.operand);
        const candidates = node.candidates.map(value);
        const matched = node.op === "in";

        return this.charged(depth, (context, resolvers, budget) => {
          const operandResult = operand(context, resolvers, budget);
          if (operandResult.status === "indeterminate") return operandResult;
          // Every candidate is evaluated even after a match, so the resolvers are called as the interpreter calls them.
          const outcomes = candidates.map((candidate) => {
            const candidateResult = candidate(context, resolvers, budget);
            if (candidateResult.status === "indeterminate") {
              return candidateResult;
            }

            return computeMembershipMatch(
              operandResult.value,
              candidateResult.value,
            );
          });
          for (const outcome of outcomes) {
            if (outcome.status === "definite" && outcome.value) {
              return definite(matched);
            }
          }
          const reason = firstIndeterminate(...outcomes);
          if (reason !== undefined) return { status: "indeterminate", reason };

          return definite(!matched);
        });
      }
      case "exists": {
        const operand = value(node.operand);

        return this.charged(depth, (context, resolvers, budget) => {
          const result = operand(context, resolvers, budget);
          if (result.status === "indeterminate") {
            if (result.reason.code === "not-yet-known") return result;
            if (result.reason.code === "not-found") return definite(false);
          }

          return definite(true);
        });
      }
      case "some":
      case "every":
      case "treeReference":
        return this.interpretedPredicate(node, depth);
      default:
        // A kind this compiler does not know is the interpreter's to reject, at evaluation time and after its budget charge, as it would for the uncompiled tree.
        return this.interpretedPredicate(node, depth);
    }
  }

  /**
   * Compiles an expression node. `fresh` says whether its value will be handed to code outside this package (a registered function or a resolver): a literal is then built anew on each call, as the interpreter builds it, so no mutation by that code can reach a later call; otherwise it is built once and shared, since only this package's own operators read it.
   */
  value(
    node: ExpressionNode,
    depth: number,
    fresh: boolean,
  ): Run<ComputedValue> {
    if (depth >= this.maxNestingDepth) {
      return this.interpretedValue(node, depth);
    }
    this.nodesCompiled += 1;
    const child = (operand: ExpressionNode): Run<ComputedValue> =>
      this.value(operand, depth + 1, false);
    const handedOver = (operand: ExpressionNode): Run<ComputedValue> =>
      this.value(operand, depth + 1, true);
    switch (node.kind) {
      case "reference": {
        const { key, unit } = node;
        const keyText = JSON.stringify(key);
        const notFound = `no value found for reference key ${keyText}`;
        const notYetKnown = `the value for reference key ${keyText} is not yet known`;

        return this.charged(depth, (context, resolvers) => {
          const resolution = settleSync(resolvers.resolveValue(key, context));
          if (!resolution.found) {
            return absenceEvaluation(resolution, notFound, notYetKnown);
          }
          const unitError = checkReferenceUnit(unit, resolution.value);
          if (unitError !== undefined) return unitError;

          return definite(resolution.value);
        });
      }
      case "accumulator":
        return this.charged(depth, () =>
          indeterminate("wrong-type", ACCUMULATOR_OUTSIDE_FOLD),
        );
      case "call": {
        const args = node.args.map(handedOver);
        const { fn } = node;
        const { functions } = this;

        return this.charged(depth, (context, resolvers, budget) => {
          const results = args.map((arg) => arg(context, resolvers, budget));
          const values: ComputedValue[] = [];
          for (const result of results) {
            if (result.status === "indeterminate") return result;
            values.push(result.value);
          }

          return invokeRegisteredFunction(functions, fn, values);
        });
      }
      case "numberLiteral":
      case "textLiteral":
      case "booleanLiteral":
      case "instantLiteral":
      case "durationLiteral":
      case "complexLiteral": {
        if (fresh) {
          return this.charged(depth, () => definite(literalValue(node)));
        }
        const shared = definite(literalValue(node));

        return this.charged(depth, () => shared);
      }
      case "arithmetic": {
        const left = child(node.left);
        const right = child(node.right);
        const { op } = node;

        return this.charged(depth, (context, resolvers, budget) => {
          const leftResult = left(context, resolvers, budget);
          const rightResult = right(context, resolvers, budget);
          if (leftResult.status === "indeterminate") return leftResult;
          if (rightResult.status === "indeterminate") return rightResult;

          return applyArithmetic(op, leftResult.value, rightResult.value);
        });
      }
      case "negate": {
        const operand = child(node.operand);

        return this.charged(depth, (context, resolvers, budget) => {
          const result = operand(context, resolvers, budget);
          if (result.status === "indeterminate") return result;

          return applyNegate(result.value);
        });
      }
      case "lookup": {
        const keys = node.keys.map(handedOver);
        const { table } = node;
        const tableText = JSON.stringify(table);
        const notFound = `no match found in lookup table ${tableText}`;
        const notYetKnown = `the match in lookup table ${tableText} is not yet known`;

        return this.charged(depth, (context, resolvers, budget) => {
          const results = keys.map((key) => key(context, resolvers, budget));
          const keyValues: ComputedValue[] = [];
          for (const result of results) {
            if (result.status === "indeterminate") return result;
            keyValues.push(result.value);
          }
          const resolution = settleSync(
            resolvers.resolveLookup(table, keyValues, context),
          );
          if (!resolution.found) {
            return absenceEvaluation(resolution, notFound, notYetKnown);
          }

          return definite(resolution.value);
        });
      }
      case "conditional": {
        const fallback = child(node.fallback);
        const cases = node.cases.map(({ when, then }) => ({
          when: this.predicate(when, depth + 1),
          then: child(then),
        }));
        if ((node.hitPolicy ?? "first") === "first") {
          return this.charged(depth, (context, resolvers, budget) => {
            for (const { when, then } of cases) {
              const whenResult = when(context, resolvers, budget);
              if (whenResult.status === "indeterminate") return whenResult;
              if (whenResult.value) return then(context, resolvers, budget);
            }

            return fallback(context, resolvers, budget);
          });
        }

        return this.charged(depth, (context, resolvers, budget) => {
          const whenResults = cases.map(({ when }) =>
            when(context, resolvers, budget),
          );
          let matches = 0;
          let matched: Run<ComputedValue> | undefined;
          cases.forEach(({ then }, index) => {
            const whenResult = whenResults[index];
            if (whenResult?.status === "definite" && whenResult.value) {
              matches += 1;
              matched = then;
            }
          });
          if (matches >= 2) {
            return indeterminate(
              "domain-error",
              "more than one case matched under the 'unique' hit policy",
            );
          }
          const reason = firstIndeterminate(...whenResults);
          if (reason !== undefined) return { status: "indeterminate", reason };

          return (matched ?? fallback)(context, resolvers, budget);
        });
      }
      case "delegate": {
        const { system, payload } = node;
        const notFound = `delegate handler for external system '${system}' reported no value`;
        const notYetKnown = `the value from the delegate handler for external system '${system}' is not yet known`;
        const noHandler = `no delegate handler registered for external system '${system}'`;

        return this.charged(depth, (context, resolvers) => {
          if (resolvers.resolveDelegate === undefined) {
            return indeterminate("wrong-type", noHandler);
          }
          const resolution = settleSync(
            resolvers.resolveDelegate(system, payload, context),
          );
          if (!resolution.found) {
            return absenceEvaluation(resolution, notFound, notYetKnown);
          }

          return definite(resolution.value);
        });
      }
      case "fold":
      case "treeReference":
        return this.interpretedValue(node, depth);
      default:
        // A kind this compiler does not know is the interpreter's to reject (see `predicate`).
        return this.interpretedValue(node, depth);
    }
  }
}

/**
 * Compiles `node` to a function that evaluates it over the resolvers of each call, with the same `Evaluation` as the synchronous interpreter: status, value, and the reason an indeterminate result carries, including which of several candidate reasons it is. The tree is walked once here, so each call does no per-node dispatch, builds no generator or suspension objects, and precomputes everything that depends only on the tree (the messages of absence, the literal values).
 *
 * Compiled natively: `not`, `and`, `or`, `allOf`, `anyOf`, `compare`, `textCompare`, `memberOf` and `exists`, and the expression kinds `reference`, `accumulator`, every literal, `arithmetic`, `negate`, `call`, `lookup`, `conditional` (both hit policies) and `delegate`. Left to the interpreter, as a subtree evaluated by `evaluatePredicateInternal` or `evaluateValueInternal` with the same budget: `some`, `every`, `fold` and `treeReference`, since each re-evaluates a subtree per item or per resolved tree. A tree containing any of them, or more nodes than `maxNodes`, charges the budget at every node exactly as the interpreter does, so a limit is met at the same node; any other tree cannot exhaust either limit and skips the charge.
 *
 * Operands are evaluated in the interpreter's synchronous order, and every operand is evaluated even when an earlier one has settled the result, so the resolvers are called in the same sequence as `evaluatePredicate` calls them. A resolver that returns a promise makes the call throw, as it does there.
 *
 * Precondition: `node` is a well-formed `PredicateNode` and is not mutated after this call, since what the tree fixes is read here once. Errors: none at compile time; a call throws exactly when the interpreter would (a resolver or registered function that throws, a promise from a resolver).
 */
export function compilePredicateTree(
  node: PredicateNode,
  functions: Readonly<FunctionRegistry>,
  maxNodes: number,
  maxNestingDepth: number,
): CompiledPredicate {
  const uncounted = new NodeCompiler(functions, maxNestingDepth, false);
  const uncountedRun = uncounted.predicate(node, 0);
  if (!uncounted.interpreted && uncounted.nodesCompiled <= maxNodes) {
    return (context, resolvers) =>
      uncountedRun(context, resolvers, UNLIMITED_BUDGET);
  }
  const countedRun = new NodeCompiler(
    functions,
    maxNestingDepth,
    true,
  ).predicate(node, 0);

  return (context, resolvers) =>
    countedRun(
      context,
      resolvers,
      createEvaluationBudget(maxNodes, maxNestingDepth),
    );
}
