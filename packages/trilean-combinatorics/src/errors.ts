import type { Scalar } from "combinatrix";
import { CombinatrixError, ConstraintContractError } from "combinatrix";
import type { IndeterminateReason } from "trilean";

/**
 * Thrown by `trileanConstraint` when a tree cannot be a constraint over the given dimensions: it does not parse as a trilean predicate tree, uses a node kind whose resolver the adapter cannot provide, references a key that is not a string or names no dimension, calls a function the registry does not hold, tags a reference with a unit, or reads a dimension that can take a value with no trilean counterpart. Every defect found is listed, not only the first.
 */
export class PredicateTreeError extends CombinatrixError {
  /** One message per defect, each naming where in the tree it is (`$` is the root). */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `invalid trilean constraint:\n${issues.map((issue) => `  ${issue}`).join("\n")}`,
    );
    this.name = "PredicateTreeError";
    this.issues = issues;
  }
}

/**
 * Thrown by `trileanConstraint` when evaluating the tree could exhaust trilean's default evaluation budget. A tree accepted by the adapter visits each of its nodes at most once per evaluation, so its node count and its depth are exactly what an evaluation can spend, and checking them when the constraint is defined means the budget is never met partway through an evaluation.
 */
export class EvaluationBudgetError extends CombinatrixError {
  /** Which of the evaluator's two budgets the tree exceeds: `nodes` is its node count against `maxNodes`, `depth` its deepest node's nesting depth (the root is at 0) against `maxNestingDepth`. */
  readonly budget: "nodes" | "depth";

  /** The tree's own node count or deepest nesting depth. */
  readonly actual: number;

  /** The evaluator's default for that budget: the largest node count it accepts, or the first nesting depth it refuses. */
  readonly limit: number;

  constructor(budget: "nodes" | "depth", actual: number, limit: number) {
    super(
      budget === "nodes"
        ? `the tree has ${String(actual)} nodes, more than the ${String(limit)} one evaluation may visit`
        : `the tree nests to depth ${String(actual)}, and evaluation refuses depth ${String(limit)} and deeper`,
    );
    this.name = "EvaluationBudgetError";
    this.budget = budget;
    this.actual = actual;
    this.limit = limit;
  }
}

/**
 * Thrown by a trilean constraint that is still indeterminate once every dimension it reads is assigned, which combinatrix's contract forbids: there is nothing left to wait for, so the tree has no answer for that combination. The usual cause is reading a dimension that is unset there without guarding it with `exists`, which leaves a `compare` indeterminate with `not-found`; `and(exists(reference), compare(...))` is definitely false when the dimension is unset, because a definite false absorbs. It extends `ConstraintContractError`, the error combinatrix raises for the same breach, and carries trilean's own reason.
 */
export class UndecidedConstraintError extends ConstraintContractError {
  /** Trilean's reason the evaluation stayed indeterminate. */
  readonly reason: IndeterminateReason;

  constructor(label: string, reason: Readonly<IndeterminateReason>) {
    super(
      `${label} is indeterminate with every dimension it reads assigned (${reason.code}: ${reason.message})`,
    );
    this.name = "UndecidedConstraintError";
    this.reason = reason;
  }
}

/**
 * Thrown when a trilean constraint reads a computed dimension whose function produced `null`, which has no trilean value: trilean's values are text, numbers, booleans and its own richer kinds, and its absence is a resolver's report rather than a value. A choice or first-valid dimension that can take `null` is refused earlier, by `trileanConstraint` itself, since its domain is known when the constraint is defined.
 */
export class UnmappableValueError extends CombinatrixError {
  /** The dimension whose value could not be mapped. */
  readonly dimension: string;

  /** The value it held. */
  readonly value: Scalar;

  constructor(dimension: string, value: Scalar) {
    super(
      `dimension "${dimension}" holds ${JSON.stringify(value)}, which has no trilean value`,
    );
    this.name = "UnmappableValueError";
    this.dimension = dimension;
    this.value = value;
  }
}
