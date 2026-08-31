import type { ComputedValue, DurationUnit, Unit } from "./computed-value";
import {
  combineUnitsForDivide,
  combineUnitsForMultiply,
  unitsEqual,
} from "./computed-value";
import {
  type Evaluation,
  type IndeterminateReason,
  definite,
  firstIndeterminate,
  indeterminate,
} from "./evaluation";
import type { FunctionRegistry } from "./functions";
import { emptyFunctionRegistry } from "./functions";
import type { JsonValue } from "./json-value";
import type { EvaluationContext, Resolvers } from "./resolvers";
import type {
  ArithmeticOperator,
  ComparisonOperator,
  ExpressionNode,
  PredicateNode,
  TextComparisonOperator,
} from "./tree";

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

/** Normalises a `duration`'s magnitude to milliseconds, the common base unit for combining or comparing two `duration`s (or an `instant` and a `duration`) of potentially different `DurationUnit`s -- shared by `compareValues`'s own `duration` branch below and by the temporal arithmetic further down. */
function toMilliseconds(value: number, unit: DurationUnit): number {
  return value * millisecondsPerDurationUnit[unit];
}

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
          toMilliseconds(left.value, left.unit),
          toMilliseconds(right.value, right.unit),
        ),
      );
    default:
      throw new Error("unreachable computed-value kind");
  }
}

/** `textCompare`'s two operands must both resolve to the `text` computed-value kind -- any other kind, on either operand, is `wrong-type` (see the `textCompare` section of README.md). `equals`/`notEquals` are exact string equality; `matches`/`notMatches` interpret `right`'s text as an ECMAScript regular expression tested against `left`'s text. An invalid pattern is `wrong-type` rather than a thrown exception -- every data-quality problem stays inside the `Evaluation` result, per `Evaluation<T>`'s own doc comment in evaluation.ts. */
function compareText(
  op: TextComparisonOperator,
  left: ComputedValue,
  right: ComputedValue,
): Evaluation<boolean> {
  if (left.kind !== "text") {
    return indeterminate(
      "wrong-type",
      `'textCompare' requires 'text' operands; the left operand is '${left.kind}'`,
    );
  }
  if (right.kind !== "text") {
    return indeterminate(
      "wrong-type",
      `'textCompare' requires 'text' operands; the right operand is '${right.kind}'`,
    );
  }
  switch (op) {
    case "equals":
      return definite(left.value === right.value);
    case "notEquals":
      return definite(left.value !== right.value);
    case "matches":
    case "notMatches": {
      let pattern: RegExp;
      try {
        pattern = new RegExp(right.value);
      } catch {
        return indeterminate(
          "wrong-type",
          `'${right.value}' is not a valid regular expression pattern`,
        );
      }
      const isMatch = pattern.test(left.value);
      return definite(op === "matches" ? isMatch : !isMatch);
    }
    default:
      throw new Error("unreachable text comparison operator");
  }
}

/** `memberOf`'s own value-equality test between two computed values -- kind-agnostic across `number`/`text`/`instant`/`duration` (see the `memberOf` section of README.md, and its "Derived aggregates" note that this equality is kind-agnostic across every computed-value kind), unlike `compare`'s own `eq`, which rejects a `text` operand outright and directs callers to `textCompare` instead. A kind mismatch, or a `number` pair with an incompatible unit, is `wrong-type` -- never simply "not equal". Narrowing `candidate` against a literal `operand.kind` case (rather than asserting it) is the same technique `compareValues` uses above. */
function computeMembershipMatch(
  operand: ComputedValue,
  candidate: ComputedValue,
): Evaluation<boolean> {
  switch (operand.kind) {
    case "number":
      if (candidate.kind !== "number") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'number' value with a '${candidate.kind}' value for membership`,
        );
      }
      if (!unitsEqual(operand.unit, candidate.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot compare numbers with incompatible units for membership",
        );
      }
      return definite(operand.value === candidate.value);
    case "text":
      if (candidate.kind !== "text") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'text' value with a '${candidate.kind}' value for membership`,
        );
      }
      return definite(operand.value === candidate.value);
    case "instant":
      if (candidate.kind !== "instant") {
        return indeterminate(
          "wrong-type",
          `cannot compare an 'instant' value with a '${candidate.kind}' value for membership`,
        );
      }
      return definite(
        Date.parse(operand.value) === Date.parse(candidate.value),
      );
    case "duration":
      if (candidate.kind !== "duration") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'duration' value with a '${candidate.kind}' value for membership`,
        );
      }
      return definite(
        toMilliseconds(operand.value, operand.unit) ===
          toMilliseconds(candidate.value, candidate.unit),
      );
    default:
      throw new Error("unreachable computed-value kind");
  }
}

/** `power`/`modulo` have no defined unit-combination rule in this design (unlike `add`/`subtract`'s "identical units" requirement or `multiply`/`divide`'s dimensional-exponent combination) -- scoping them to dimensionless operands avoids inventing an unspecified unit-scaling semantics for a fractional or runtime-determined exponent. */
function isDimensionless(unit: Unit | undefined): boolean {
  return unitsEqual(unit, undefined);
}

/** `negate` is never sugar for "zero minus the value" (see the `arithmetic`/`negate` section of README.md) -- a `duration`'s magnitude is negated directly, in its own original unit, with no subtraction or millisecond normalisation involved. */
function applyNegate(operand: ComputedValue): Evaluation<ComputedValue> {
  switch (operand.kind) {
    case "number":
      return definite({
        kind: "number",
        value: -operand.value,
        unit: operand.unit,
      });
    case "duration":
      return definite({
        kind: "duration",
        value: -operand.value,
        unit: operand.unit,
      });
    case "text":
    case "instant":
      return indeterminate(
        "wrong-type",
        `cannot negate a '${operand.kind}' value`,
      );
    default:
      throw new Error("unreachable computed-value kind");
  }
}

function applyArithmeticOnNumbers(
  op: ArithmeticOperator,
  left: Extract<ComputedValue, { kind: "number" }>,
  right: Extract<ComputedValue, { kind: "number" }>,
): Evaluation<ComputedValue> {
  switch (op) {
    case "add":
      if (!unitsEqual(left.unit, right.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot add numbers with incompatible units",
        );
      }
      return definite({
        kind: "number",
        value: left.value + right.value,
        unit: left.unit,
      });
    case "subtract":
      if (!unitsEqual(left.unit, right.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot subtract numbers with incompatible units",
        );
      }
      return definite({
        kind: "number",
        value: left.value - right.value,
        unit: left.unit,
      });
    case "multiply":
      return definite({
        kind: "number",
        value: left.value * right.value,
        unit: combineUnitsForMultiply(left.unit, right.unit),
      });
    case "divide":
      if (right.value === 0) {
        return indeterminate("domain-error", "division by zero");
      }
      return definite({
        kind: "number",
        value: left.value / right.value,
        unit: combineUnitsForDivide(left.unit, right.unit),
      });
    case "power":
      if (!isDimensionless(left.unit) || !isDimensionless(right.unit)) {
        return indeterminate(
          "wrong-type",
          "'power' requires dimensionless operands",
        );
      }
      if (left.value < 0 && !Number.isInteger(right.value)) {
        return indeterminate(
          "domain-error",
          "a negative base raised to a non-integer power is not a real number",
        );
      }
      return definite({ kind: "number", value: left.value ** right.value });
    case "modulo":
      if (!isDimensionless(left.unit) || !isDimensionless(right.unit)) {
        return indeterminate(
          "wrong-type",
          "'modulo' requires dimensionless operands",
        );
      }
      if (right.value === 0) {
        return indeterminate("domain-error", "modulo by zero");
      }
      return definite({ kind: "number", value: left.value % right.value });
    default:
      throw new Error("unreachable arithmetic operator");
  }
}

/** The only same-kind, non-`number` arithmetic this design defines: two `duration`s combine by normalising both to milliseconds first (see `toMilliseconds`), reporting the result in milliseconds -- `multiply`/`divide`/`power`/`modulo` have no representable result unit for a `duration` squared or a dimensionless ratio, so they are `wrong-type` rather than invented. */
function applyArithmeticOnDurations(
  op: ArithmeticOperator,
  left: Readonly<Extract<ComputedValue, { kind: "duration" }>>,
  right: Readonly<Extract<ComputedValue, { kind: "duration" }>>,
): Evaluation<ComputedValue> {
  switch (op) {
    case "add":
      return definite({
        kind: "duration",
        value:
          toMilliseconds(left.value, left.unit) +
          toMilliseconds(right.value, right.unit),
        unit: "ms",
      });
    case "subtract":
      return definite({
        kind: "duration",
        value:
          toMilliseconds(left.value, left.unit) -
          toMilliseconds(right.value, right.unit),
        unit: "ms",
      });
    case "multiply":
    case "divide":
    case "power":
    case "modulo":
      return indeterminate(
        "wrong-type",
        `arithmetic operator '${op}' is not defined between two 'duration' values`,
      );
    default:
      throw new Error("unreachable arithmetic operator");
  }
}

/**
 * Dispatches `arithmetic` by operand kind. The three cross-kind temporal combinations this design defines (`instant - instant`, `instant + duration`, `duration + instant`) are checked explicitly first, in that order, against the exact operator each requires; any other combination touching an `instant` is `wrong-type` (see "Temporal values" in README.md -- e.g. adding two instants, or subtracting a `duration` from an `instant`, are deliberately *not* defined). Same-kind `duration`/`duration` combinations are delegated to `applyArithmeticOnDurations`; a `duration` paired with anything other than an `instant` or another `duration` is `wrong-type`. Everything remaining requires two `number` operands.
 */
function applyArithmetic(
  op: ArithmeticOperator,
  left: ComputedValue,
  right: ComputedValue,
): Evaluation<ComputedValue> {
  if (
    left.kind === "instant" &&
    right.kind === "instant" &&
    op === "subtract"
  ) {
    return definite({
      kind: "duration",
      value: Date.parse(left.value) - Date.parse(right.value),
      unit: "ms",
    });
  }
  if (left.kind === "instant" && right.kind === "duration" && op === "add") {
    return definite({
      kind: "instant",
      value: new Date(
        Date.parse(left.value) + toMilliseconds(right.value, right.unit),
      ).toISOString(),
    });
  }
  if (left.kind === "duration" && right.kind === "instant" && op === "add") {
    return definite({
      kind: "instant",
      value: new Date(
        Date.parse(right.value) + toMilliseconds(left.value, left.unit),
      ).toISOString(),
    });
  }
  if (left.kind === "instant" || right.kind === "instant") {
    return indeterminate(
      "wrong-type",
      `arithmetic operator '${op}' is not defined between a '${left.kind}' and a '${right.kind}' value`,
    );
  }
  if (left.kind === "duration" && right.kind === "duration") {
    return applyArithmeticOnDurations(op, left, right);
  }
  if (left.kind === "duration" || right.kind === "duration") {
    return indeterminate(
      "wrong-type",
      `arithmetic operator '${op}' is not defined between a '${left.kind}' and a '${right.kind}' value`,
    );
  }
  if (left.kind !== "number") {
    return indeterminate(
      "wrong-type",
      `arithmetic requires numeric operands; got a '${left.kind}' value`,
    );
  }
  if (right.kind !== "number") {
    return indeterminate(
      "wrong-type",
      `arithmetic requires numeric operands; got a '${right.kind}' value`,
    );
  }
  return applyArithmeticOnNumbers(op, left, right);
}

/** A collection candidate paired with its own pre-filter outcome: `"include"`/`"exclude"` when `filter` resolved definitely, or the filter's own indeterminate `Evaluation` when it did not (there is no third, definite-but-neither branch -- see `resolveParticipatingItems` below). */
interface ResolvedCollectionItem {
  readonly item: unknown;
  readonly filterOutcome: "include" | "exclude" | Evaluation<never>;
}

/**
 * Collection resolution shared by the quantifiers (`some`/`every`, below) and by `fold` (a later phase): resolves the opaque `collection` reference to its concrete candidate list via `resolvers.resolveCollection`, then evaluates each candidate's optional `filter` with that candidate as its own evaluation context and the accumulator reset to `undefined` -- see the README's "Evaluation context" and "Pre-filtering which items participate" sections. Deliberately stops short of deciding how an indeterminate filter combines with the rest of the surrounding node: `some`/`every` fold a filter-indeterminate item in as its own vote via the surrounding OR/AND absorption, while `fold` has no absorbing value at all and goes indeterminate outright on the same condition -- the two callers need genuinely different combination logic over these same per-item outcomes, so this helper only produces the outcomes and leaves combining them to the caller.
 */
async function resolveParticipatingItems(
  collection: JsonValue,
  filter: PredicateNode | undefined,
  // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment in resolvers.ts
  context: EvaluationContext,
  resolvers: Readonly<Resolvers>,
  functions: Readonly<FunctionRegistry>,
): Promise<ResolvedCollectionItem[]> {
  const candidates = await resolvers.resolveCollection(collection, context);
  return Promise.all(
    candidates.map(async (item): Promise<ResolvedCollectionItem> => {
      if (filter === undefined) return { item, filterOutcome: "include" };
      const filterResult = await evaluatePredicateInternal(
        filter,
        item,
        resolvers,
        undefined,
        functions,
      );
      if (filterResult.status === "indeterminate") {
        return { item, filterOutcome: filterResult };
      }
      return {
        item,
        filterOutcome: filterResult.value ? "include" : "exclude",
      };
    }),
  );
}

/** The first participating item (in declared collection order) whose `filter` evaluation was itself indeterminate, or `undefined` if every participating item's filter resolved definitely -- a filter-excluded item's own `"exclude"` outcome never counts here. Used only by `fold`, which -- unlike `some`/`every`'s OR/AND absorption -- has no absorbing value at all: any participating item's indeterminate filter makes the whole fold indeterminate outright, with no other item's outcome able to override it. */
function firstFilterIndeterminate(
  participating: readonly ResolvedCollectionItem[],
): IndeterminateReason | undefined {
  for (const { filterOutcome } of participating) {
    if (filterOutcome === "include" || filterOutcome === "exclude") continue;
    if (filterOutcome.status === "indeterminate") return filterOutcome.reason;
  }
  return undefined;
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
    case "textCompare": {
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
      return compareText(node.op, left.value, right.value);
    }
    case "memberOf": {
      const operandResult = await evaluateValueInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
      );
      if (operandResult.status === "indeterminate") return operandResult;

      // Every candidate is evaluated concurrently; the scan below then walks the resolved outcomes in declared order, so a definite match short-circuits the *result* without ever needing to short-circuit the resolver calls themselves.
      const candidateOutcomes = await Promise.all(
        node.candidates.map(async (candidate): Promise<Evaluation<boolean>> => {
          const candidateResult = await evaluateValueInternal(
            candidate,
            context,
            resolvers,
            accumulator,
            functions,
          );
          if (candidateResult.status === "indeterminate") {
            return candidateResult;
          }
          return computeMembershipMatch(
            operandResult.value,
            candidateResult.value,
          );
        }),
      );

      for (const outcome of candidateOutcomes) {
        if (outcome.status === "definite" && outcome.value) {
          return definite(node.op === "in");
        }
      }
      // No definite match: indeterminate (first candidate's reason, per the tie-break rule) if any candidate was itself indeterminate or of an incompatible kind/unit; otherwise every candidate was a definite non-match. An empty `candidates` array falls straight through to this same definite non-match result, with no separate empty-list branch needed.
      const reason = firstIndeterminate(...candidateOutcomes);
      if (reason !== undefined) return { status: "indeterminate", reason };
      return definite(node.op === "notIn");
    }
    case "exists": {
      const operandResult = await evaluateValueInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
      );
      // The data point resolved to *something* unless it was flatly not-found; a resolved-but-unusable value (wrong-type/domain-error) still counts as existing. `exists` is never itself indeterminate.
      if (
        operandResult.status === "indeterminate" &&
        operandResult.reason.code === "not-found"
      ) {
        return definite(false);
      }
      return definite(true);
    }
    case "some":
    case "every": {
      const participating = await resolveParticipatingItems(
        node.collection,
        node.filter,
        context,
        resolvers,
        functions,
      );
      // A filter-excluded item contributes no vote at all (as if never in the collection); a filter-indeterminate item contributes its own indeterminate vote, letting a different item's clean match still absorb it -- contrast with `fold`, which has no absorbing value and goes indeterminate outright on the same condition.
      const votes = (
        await Promise.all(
          participating.map(
            async ({
              item,
              filterOutcome,
            }): Promise<Evaluation<boolean> | undefined> => {
              if (filterOutcome === "exclude") return undefined;
              if (filterOutcome !== "include") return filterOutcome;
              return evaluatePredicateInternal(
                node.item,
                item,
                resolvers,
                undefined,
                functions,
              );
            },
          ),
        )
      ).filter((vote): vote is Evaluation<boolean> => vote !== undefined);
      // `some` is an OR fold seeded at `false`; `every` an AND fold seeded at `true` -- exactly `anyOf`/`allOf`'s own pairwise fold, so an empty `votes` list (an empty collection, or every candidate filtered out) already reduces to `anyOf([])`/`allOf([])`'s own identity values with no separate empty-collection branch.
      const combine = node.kind === "some" ? combineOr : combineAnd;
      const identity = node.kind === "some" ? definite(false) : definite(true);
      return votes.reduce<Evaluation<boolean>>(combine, identity);
    }
    default:
      throw new Error("unreachable predicate node kind");
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
      return definite({ kind: "number", value: node.value, unit: node.unit });
    case "textLiteral":
      return definite({ kind: "text", value: node.value });
    case "instantLiteral":
      return definite({ kind: "instant", value: node.value });
    case "durationLiteral":
      return definite({
        kind: "duration",
        value: node.value,
        unit: node.unit,
      });
    case "arithmetic": {
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
      // Unlike `and`/`or` (see `combineAnd`/`combineOr` above), arithmetic has no absorbing value: any indeterminate operand always makes the whole node indeterminate, regardless of what the other operand would have been, tie-broken left before right per the tie-break rule.
      if (left.status === "indeterminate") return left;
      if (right.status === "indeterminate") return right;
      return applyArithmetic(node.op, left.value, right.value);
    }
    case "negate": {
      const operand = await evaluateValueInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
      );
      if (operand.status === "indeterminate") return operand;
      return applyNegate(operand.value);
    }
    case "lookup": {
      // All keys are evaluated concurrently; any indeterminate key makes the whole lookup indeterminate immediately, with no `resolveLookup` call attempted at all -- see the `lookup` section of README.md.
      const keyResults = await Promise.all(
        node.keys.map(async (key) =>
          evaluateValueInternal(
            key,
            context,
            resolvers,
            accumulator,
            functions,
          ),
        ),
      );
      const keyValues: ComputedValue[] = [];
      for (const result of keyResults) {
        if (result.status === "indeterminate") return result;
        keyValues.push(result.value);
      }
      const resolution = await resolvers.resolveLookup(
        node.table,
        keyValues,
        context,
      );
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          `no match found in lookup table ${JSON.stringify(node.table)}`,
        );
      }
      return definite(resolution.value);
    }
    case "conditional": {
      // Strictly sequential, not concurrent: a for...of loop with early return on the first definite match, or the first indeterminate guard, is required behaviour -- evaluation must never skip past an unresolved guard to try a later case that might only look correct because an earlier one couldn't actually be checked (see the `conditional` section of README.md).
      for (const { when, then } of node.cases) {
        const whenResult = await evaluatePredicateInternal(
          when,
          context,
          resolvers,
          accumulator,
          functions,
        );
        if (whenResult.status === "indeterminate") return whenResult;
        if (whenResult.value) {
          return evaluateValueInternal(
            then,
            context,
            resolvers,
            accumulator,
            functions,
          );
        }
      }
      return evaluateValueInternal(
        node.fallback,
        context,
        resolvers,
        accumulator,
        functions,
      );
    }
    case "fold": {
      const participating = await resolveParticipatingItems(
        node.collection,
        node.filter,
        context,
        resolvers,
        functions,
      );
      const filterIndeterminateReason = firstFilterIndeterminate(participating);
      if (filterIndeterminateReason !== undefined) {
        return { status: "indeterminate", reason: filterIndeterminateReason };
      }
      const includedItems = participating
        .filter(({ filterOutcome }) => filterOutcome === "include")
        .map(({ item }) => item);

      if (node.combiner.mode === "reduce") {
        // Unlike some/every's OR/AND absorption, `reduce` has no absorbing value at all: `initial` and every participating item's `combine` step must each resolve definitely, or the whole fold is indeterminate -- see the `fold` section of README.md. `initial` is evaluated with the accumulator reset to undefined (the same treatment as a filter/item sub-node below), then threaded as the real running accumulator into each `combine` step in turn.
        const initialResult = await evaluateValueInternal(
          node.combiner.initial,
          context,
          resolvers,
          undefined,
          functions,
        );
        if (initialResult.status === "indeterminate") return initialResult;
        let runningAccumulator = initialResult.value;
        for (const item of includedItems) {
          const stepResult = await evaluateValueInternal(
            node.combiner.combine,
            item,
            resolvers,
            runningAccumulator,
            functions,
          );
          if (stepResult.status === "indeterminate") return stepResult;
          runningAccumulator = stepResult.value;
        }
        return definite(runningAccumulator);
      }

      // max/min: the "unseeded" variant of reduce -- there is no largest/smallest real number to seed a running extremum with, so the first participating item's own projected value seeds the running result directly, and every later item's is compared against it via `compareValues` (reusing `compare`'s own ordering semantics rather than reinventing them). An empty (post-filter) collection is domain-error, the same category as division by zero, since there is no first item to seed from -- unlike `reduce`, which always has a real seed (`initial`) and needs no such case.
      if (includedItems.length === 0) {
        return indeterminate(
          "domain-error",
          `'${node.combiner.mode}' has no participating items to seed a running result from`,
        );
      }
      const dominatesOp: ComparisonOperator =
        node.combiner.mode === "max" ? "gt" : "lt";
      let runningExtremum: ComputedValue | undefined;
      for (const item of includedItems) {
        const itemResult = await evaluateValueInternal(
          node.combiner.item,
          item,
          resolvers,
          undefined,
          functions,
        );
        if (itemResult.status === "indeterminate") return itemResult;
        if (runningExtremum === undefined) {
          runningExtremum = itemResult.value;
          continue;
        }
        const comparison = compareValues(
          dominatesOp,
          itemResult.value,
          runningExtremum,
        );
        if (comparison.status === "indeterminate") return comparison;
        if (comparison.value) runningExtremum = itemResult.value;
      }
      if (runningExtremum === undefined) {
        throw new Error(
          "unreachable: max/min over a non-empty participating list produced no running result",
        );
      }
      return definite(runningExtremum);
    }
    case "delegate": {
      if (resolvers.resolveDelegate === undefined) {
        return indeterminate(
          "wrong-type",
          `no delegate handler registered for external system '${node.system}'`,
        );
      }
      const resolution = await resolvers.resolveDelegate(
        node.system,
        node.payload,
        context,
      );
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          `delegate handler for external system '${node.system}' reported no value`,
        );
      }
      return definite(resolution.value);
    }
    default:
      throw new Error("unreachable expression node kind");
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
