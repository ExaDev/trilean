import type { ComputedValue, DurationUnit } from "./computed-value";
import { unitsEqual } from "./computed-value";
import {
  type Evaluation,
  definite,
  firstIndeterminate,
  indeterminate,
} from "./evaluation";
import type { FunctionRegistry } from "./functions";
import { emptyFunctionRegistry } from "./functions";
import type { EvaluationContext, Resolvers } from "./resolvers";
import type { ComparisonOperator, ExpressionNode, PredicateNode } from "./tree";

/**
 * `evaluatePredicateInternal` and `evaluateValueInternal` are co-located in this one file, rather than split across `predicate-evaluator.ts`/`value-evaluator.ts`, because they are mutually recursive: a predicate leaf (`compare`, `textCompare`, `memberOf`, `exists`) holds `ExpressionNode` operands, and an expression node (`conditional`'s `when`, a fold's `filter`) holds `PredicateNode` operands. Splitting them across modules would make each half import the other, and whichever module finished loading second would see the other's export as `undefined` at its own module-evaluation time -- a genuine circular-import TDZ hazard, not merely a style preference.
 */

/** The three-valued AND table: `false` is absorbing regardless of the other operand's indeterminacy; otherwise both-definite folds to a boolean AND; otherwise indeterminate, with the tie-break rule (declared operand order, left before right) applied via `firstIndeterminate`. */
function combineAnd(
  left: Evaluation<boolean>,
  right: Evaluation<boolean>,
): Evaluation<boolean> {
  if (left.status === "definite" && !left.value) return definite(false);
  if (right.status === "definite" && !right.value) return definite(false);
  const reason = firstIndeterminate(left, right);
  if (reason !== undefined) return { status: "indeterminate", reason };
  return definite(true);
}

/** The three-valued OR table: mirror image of `combineAnd`, with `true` absorbing. */
function combineOr(
  left: Evaluation<boolean>,
  right: Evaluation<boolean>,
): Evaluation<boolean> {
  if (left.status === "definite" && left.value) return definite(true);
  if (right.status === "definite" && right.value) return definite(true);
  const reason = firstIndeterminate(left, right);
  if (reason !== undefined) return { status: "indeterminate", reason };
  return definite(false);
}

function applyComparisonOperator(
  op: ComparisonOperator,
  left: number,
  right: number,
): boolean {
  switch (op) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    default:
      throw new Error("unreachable comparison operator");
  }
}

const millisecondsPerDurationUnit: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `compare`'s two operands: valid kinds are `number` (matching units required), `instant` (ordered by parsed epoch millisecond), or `duration` (ordered by magnitude normalised to milliseconds) -- `text` is never valid here (see `textCompare`), and a kind mismatch between the two operands is `wrong-type`. Narrowing `right` against a literal `left.kind` case (rather than asserting it) is what lets both sides stay properly typed with no `as`. */
function compareValues(
  op: ComparisonOperator,
  left: ComputedValue,
  right: ComputedValue,
): Evaluation<boolean> {
  switch (left.kind) {
    case "number":
      if (right.kind !== "number") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'number' value with a '${right.kind}' value`,
        );
      }
      if (!unitsEqual(left.unit, right.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot compare numbers with incompatible units",
        );
      }
      return definite(applyComparisonOperator(op, left.value, right.value));
    case "text":
      return indeterminate(
        "wrong-type",
        "text values are not comparable via 'compare'; use 'textCompare'",
      );
    case "instant":
      if (right.kind !== "instant") {
        return indeterminate(
          "wrong-type",
          `cannot compare an 'instant' value with a '${right.kind}' value`,
        );
      }
      return definite(
        applyComparisonOperator(
          op,
          Date.parse(left.value),
          Date.parse(right.value),
        ),
      );
    case "duration":
      if (right.kind !== "duration") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'duration' value with a '${right.kind}' value`,
        );
      }
      return definite(
        applyComparisonOperator(
          op,
          left.value * millisecondsPerDurationUnit[left.unit],
          right.value * millisecondsPerDurationUnit[right.unit],
        ),
      );
    default:
      throw new Error("unreachable computed-value kind");
  }
}

async function evaluatePredicateInternal(
  node: PredicateNode,
  // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment in resolvers.ts
  context: EvaluationContext,
  resolvers: Readonly<Resolvers>,
  accumulator: ComputedValue | undefined,
  functions: Readonly<FunctionRegistry>,
): Promise<Evaluation<boolean>> {
  switch (node.kind) {
    case "not": {
      const operand = await evaluatePredicateInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
      );
      if (operand.status === "indeterminate") return operand;
      return definite(!operand.value);
    }
    case "and": {
      const [left, right] = await Promise.all([
        evaluatePredicateInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
        ),
        evaluatePredicateInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
        ),
      ]);
      return combineAnd(left, right);
    }
    case "or": {
      const [left, right] = await Promise.all([
        evaluatePredicateInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
        ),
        evaluatePredicateInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
        ),
      ]);
      return combineOr(left, right);
    }
    case "allOf": {
      const operandResults = await Promise.all(
        node.operands.map(async (operand) =>
          evaluatePredicateInternal(
            operand,
            context,
            resolvers,
            accumulator,
            functions,
          ),
        ),
      );
      return operandResults.reduce<Evaluation<boolean>>(
        combineAnd,
        definite(true),
      );
    }
    case "anyOf": {
      const operandResults = await Promise.all(
        node.operands.map(async (operand) =>
          evaluatePredicateInternal(
            operand,
            context,
            resolvers,
            accumulator,
            functions,
          ),
        ),
      );
      return operandResults.reduce<Evaluation<boolean>>(
        combineOr,
        definite(false),
      );
    }
    case "compare": {
      const [left, right] = await Promise.all([
        evaluateValueInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
        ),
        evaluateValueInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
        ),
      ]);
      if (left.status === "indeterminate") return left;
      if (right.status === "indeterminate") return right;
      return compareValues(node.op, left.value, right.value);
    }
    case "textCompare":
    case "memberOf":
    case "exists":
    case "some":
    case "every":
    default:
      throw new Error(`not yet implemented: ${node.kind}`);
  }
}

async function evaluateValueInternal(
  node: ExpressionNode,
  // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment in resolvers.ts
  context: EvaluationContext,
  resolvers: Readonly<Resolvers>,
  accumulator: ComputedValue | undefined,
  functions: Readonly<FunctionRegistry>,
): Promise<Evaluation<ComputedValue>> {
  switch (node.kind) {
    case "reference": {
      const resolution = await resolvers.resolveValue(node.key, context);
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          `no value found for reference key ${JSON.stringify(node.key)}`,
        );
      }
      if (node.unit !== undefined) {
        if (resolution.value.kind !== "number") {
          return indeterminate(
            "wrong-type",
            "a unit was expected on a reference that resolved to a non-numeric value",
          );
        }
        if (!unitsEqual(node.unit, resolution.value.unit)) {
          return indeterminate(
            "wrong-type",
            "the resolved value's unit does not match the reference's expected unit",
          );
        }
      }
      return definite(resolution.value);
    }
    case "accumulator": {
      if (accumulator === undefined) {
        return indeterminate(
          "wrong-type",
          "accumulator used outside a reduce fold's combine expression",
        );
      }
      return definite(accumulator);
    }
    case "call": {
      const argResults = await Promise.all(
        node.args.map(async (arg) =>
          evaluateValueInternal(
            arg,
            context,
            resolvers,
            accumulator,
            functions,
          ),
        ),
      );
      const args: ComputedValue[] = [];
      for (const result of argResults) {
        if (result.status === "indeterminate") return result;
        args.push(result.value);
      }
      const fn = functions[node.fn];
      if (fn === undefined) {
        return indeterminate(
          "wrong-type",
          `no function registered under the name '${node.fn}'`,
        );
      }
      const outcome = fn(args);
      if ("domainError" in outcome) {
        return indeterminate("domain-error", outcome.domainError);
      }
      return definite(outcome);
    }
    case "numberLiteral":
    case "textLiteral":
    case "instantLiteral":
    case "durationLiteral":
    case "arithmetic":
    case "negate":
    case "lookup":
    case "conditional":
    case "fold":
    case "delegate":
    default:
      throw new Error(`not yet implemented: ${node.kind}`);
  }
}

/**
 * Builds a bound `{ evaluatePredicate, evaluateValue }` pair over a caller-supplied function registry for `call` nodes -- the registry is bound once, at construction time, unlike `resolvers`, which are supplied fresh to every call. The bare module-level `evaluatePredicate`/`evaluateValue` exports below are `createEvaluator({})`'s output.
 */
export function createEvaluator({
  functions = emptyFunctionRegistry,
}: {
  functions?: FunctionRegistry;
}): {
  evaluatePredicate: (
    node: PredicateNode,
    // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment in resolvers.ts
    context: EvaluationContext,
    resolvers: Readonly<Resolvers>,
  ) => Promise<Evaluation<boolean>>;
  evaluateValue: (
    node: ExpressionNode,
    // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment in resolvers.ts
    context: EvaluationContext,
    resolvers: Readonly<Resolvers>,
  ) => Promise<Evaluation<ComputedValue>>;
} {
  return {
    evaluatePredicate: async (node, context, resolvers) =>
      evaluatePredicateInternal(node, context, resolvers, undefined, functions),
    evaluateValue: async (node, context, resolvers) =>
      evaluateValueInternal(node, context, resolvers, undefined, functions),
  };
}

export const { evaluatePredicate, evaluateValue } = createEvaluator({});
