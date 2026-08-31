import type { ComputedValue, DurationUnit, Unit } from "./computed-value";
import {
  combineUnitsForDivide,
  combineUnitsForMultiply,
  unitsEqual,
} from "./computed-value";
import {
  type Evaluation,
  definite,
  firstIndeterminate,
  indeterminate,
} from "./evaluation";
import type { FunctionRegistry } from "./functions";
import { emptyFunctionRegistry } from "./functions";
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
