import type { CompiledPattern } from "trilean-regex";
import { RegexParseError, compilePattern } from "trilean-regex";
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
import type {
  ArithmeticOperator,
  ComparisonOperator,
  TextComparisonOperator,
} from "./tree";

/** The three-valued AND table: `false` is absorbing regardless of the other operand's indeterminacy; otherwise both-definite folds to a boolean AND; otherwise indeterminate, with the tie-break rule (declared operand order, left before right) applied via `firstIndeterminate`. */
export function combineAnd(
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
export function combineOr(
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

/** `Date.parse` reports an unparseable timestamp as `NaN`, and every downstream use of that `NaN` then fails silently rather than loudly: every comparison against it is `false` (so `neq` between two unparseable instants would come back definitely `true`), a subtraction yields a `NaN`-magnitude duration, and `new Date(NaN).toISOString()` throws a `RangeError` outright -- a thrown exception for a data-quality problem, which this design never does (see `Evaluation<T>`'s own doc comment in evaluation.ts). An `instant` whose string will not parse is a value the operation cannot use, so every caller below reports it as `wrong-type`, exactly like any other unusable operand. */
function toEpochMilliseconds(value: string): number | undefined {
  const epochMilliseconds = Date.parse(value);
  return Number.isNaN(epochMilliseconds) ? undefined : epochMilliseconds;
}

function unparseableInstant(value: string): Evaluation<never> {
  return indeterminate(
    "wrong-type",
    `'${value}' is not a parseable ISO-8601 timestamp`,
  );
}

/** The representable timestamp range is finite, so a valid instant shifted by a large enough duration lands outside it, where `new Date(...).toISOString()` throws a `RangeError`. Checking the shifted date against the platform's own notion of a valid time value keeps that inside the three-outcome model as a `domain-error` -- an operation pushed outside its valid domain, the same category as division by zero -- and avoids hardcoding the range bound. */
function instantFromEpochMilliseconds(
  epochMilliseconds: number,
): Evaluation<ComputedValue> {
  const shifted = new Date(epochMilliseconds);
  if (Number.isNaN(shifted.getTime())) {
    return indeterminate(
      "domain-error",
      "the resulting instant falls outside the representable timestamp range",
    );
  }
  return definite({ kind: "instant", value: shifted.toISOString() });
}

/** `compare`'s two operands: valid kinds are `number` (matching units required), `instant` (ordered by parsed epoch millisecond), or `duration` (ordered by magnitude normalised to milliseconds) -- `text` is never valid here (see `textCompare`), and a kind mismatch between the two operands is `wrong-type`. Narrowing `right` against a literal `left.kind` case (rather than asserting it) is what lets both sides stay properly typed with no `as`. */
export function compareValues(
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
    case "boolean":
      if (right.kind !== "boolean") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'boolean' value with a '${right.kind}' value`,
        );
      }
      if (op !== "eq" && op !== "neq") {
        return indeterminate(
          "wrong-type",
          `booleans have no natural ordering; '${op}' is only defined for 'eq'/'neq'`,
        );
      }
      return definite(
        op === "eq" ? left.value === right.value : left.value !== right.value,
      );
    case "instant": {
      if (right.kind !== "instant") {
        return indeterminate(
          "wrong-type",
          `cannot compare an 'instant' value with a '${right.kind}' value`,
        );
      }
      const leftEpoch = toEpochMilliseconds(left.value);
      if (leftEpoch === undefined) return unparseableInstant(left.value);
      const rightEpoch = toEpochMilliseconds(right.value);
      if (rightEpoch === undefined) return unparseableInstant(right.value);
      return definite(applyComparisonOperator(op, leftEpoch, rightEpoch));
    }
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
    // Complex operands stay kind-strict here, deliberately unlike `arithmetic`'s promotion of a real operand: arithmetic produces a value, so promoting loses nothing, whereas a comparison consumes two and this design already treats a kind difference between them as a modelling error worth surfacing (the same reason an `instant` is never compared against a plain `number`).
    case "complex":
      if (op !== "eq" && op !== "neq") {
        return indeterminate(
          "wrong-type",
          `ordering operator '${op}' is not defined for complex values; the complex plane has no total order`,
        );
      }
      if (right.kind !== "complex") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'complex' value with a '${right.kind}' value`,
        );
      }
      if (!unitsEqual(left.unit, right.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot compare complex values with incompatible units",
        );
      }
      return definite(
        op === "eq"
          ? left.re === right.re && left.im === right.im
          : left.re !== right.re || left.im !== right.im,
      );
    default:
      throw new Error("unreachable computed-value kind");
  }
}

/** `textCompare`'s two operands must both resolve to the `text` computed-value kind -- any other kind, on either operand, is `wrong-type` (see the `textCompare` section of README.md). `equals`/`notEquals` are exact string equality; `matches`/`notMatches` interpret `right`'s text as an ECMAScript regular expression tested against `left`'s text; `portableMatches`/`portableNotMatches` interpret it as a pattern in `trilean-regex`'s own restricted grammar instead, matched by that package's finite-automaton reference matcher rather than the host's native `RegExp` engine -- see the `textCompare` section of README.md for when to reach for the portable pair instead of the plain one. An invalid pattern is `wrong-type` rather than a thrown exception either way -- every data-quality problem stays inside the `Evaluation` result, per `Evaluation<T>`'s own doc comment in evaluation.ts. */
export function compareText(
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
    case "portableMatches":
    case "portableNotMatches": {
      let compiled: CompiledPattern;
      try {
        compiled = compilePattern(right.value);
      } catch (error) {
        const reason =
          error instanceof RegexParseError ? error.message : String(error);
        return indeterminate(
          "wrong-type",
          `'${right.value}' is not a valid trilean-regex pattern: ${reason}`,
        );
      }
      const isMatch = compiled.test(left.value);
      return definite(op === "portableMatches" ? isMatch : !isMatch);
    }
    default:
      throw new Error("unreachable text comparison operator");
  }
}

/** `memberOf`'s own value-equality test between two computed values -- kind-agnostic across `number`/`text`/`instant`/`duration` (see the `memberOf` section of README.md, and its "Derived aggregates" note that this equality is kind-agnostic across every computed-value kind), unlike `compare`'s own `eq`, which rejects a `text` operand outright and directs callers to `textCompare` instead. A kind mismatch, or a `number` pair with an incompatible unit, is `wrong-type` -- never simply "not equal". Narrowing `candidate` against a literal `operand.kind` case (rather than asserting it) is the same technique `compareValues` uses above. */
export function computeMembershipMatch(
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
    case "boolean":
      if (candidate.kind !== "boolean") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'boolean' value with a '${candidate.kind}' value for membership`,
        );
      }
      return definite(operand.value === candidate.value);
    case "instant": {
      if (candidate.kind !== "instant") {
        return indeterminate(
          "wrong-type",
          `cannot compare an 'instant' value with a '${candidate.kind}' value for membership`,
        );
      }
      const operandEpoch = toEpochMilliseconds(operand.value);
      if (operandEpoch === undefined) return unparseableInstant(operand.value);
      const candidateEpoch = toEpochMilliseconds(candidate.value);
      if (candidateEpoch === undefined) {
        return unparseableInstant(candidate.value);
      }
      return definite(operandEpoch === candidateEpoch);
    }
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
    case "complex":
      if (candidate.kind !== "complex") {
        return indeterminate(
          "wrong-type",
          `cannot compare a 'complex' value with a '${candidate.kind}' value for membership`,
        );
      }
      if (!unitsEqual(operand.unit, candidate.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot compare complex values with incompatible units for membership",
        );
      }
      return definite(
        operand.re === candidate.re && operand.im === candidate.im,
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
export function applyNegate(operand: ComputedValue): Evaluation<ComputedValue> {
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
    case "complex":
      return definite({
        kind: "complex",
        re: -operand.re,
        im: -operand.im,
        unit: operand.unit,
      });
    case "text":
    case "instant":
    case "boolean":
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
      // A zero base with a negative exponent is a division by zero written the other way round, so it belongs in the same domain-error category rather than escaping as a definite (infinite) result.
      if (left.value === 0 && right.value < 0) {
        return indeterminate(
          "domain-error",
          "zero raised to a negative power is a division by zero",
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

/** Every real number is a complex number with a zero imaginary part, so promoting one is exact and total -- unlike the temporal cross-kind combinations above, which each had to be enumerated because no such embedding exists between an `instant` and a `duration`. This is what lets a tree mix real and complex terms freely instead of forcing every real literal to be written as a complex one. */
function toComplexValue(
  value: Readonly<Extract<ComputedValue, { kind: "number" | "complex" }>>,
): Extract<ComputedValue, { kind: "complex" }> {
  if (value.kind === "complex") return value;
  return { kind: "complex", re: value.value, im: 0, unit: value.unit };
}

/** The complex product, as its own component-level helper rather than only a branch of the operator switch below, because `power`'s repeated multiplication needs exactly this and must not re-derive it. */
function multiplyComplexValues(
  left: Readonly<Extract<ComputedValue, { kind: "complex" }>>,
  right: Readonly<Extract<ComputedValue, { kind: "complex" }>>,
): Extract<ComputedValue, { kind: "complex" }> {
  return {
    kind: "complex",
    re: left.re * right.re - left.im * right.im,
    im: left.re * right.im + left.im * right.re,
    unit: combineUnitsForMultiply(left.unit, right.unit),
  };
}

/** Complex arithmetic, over the one canonical rectangular representation the `complex` kind stores (see the "Complex values" section of README.md). `add`/`subtract` are component-wise and carry the same identical-units requirement real numbers already have. `power` is deliberately excluded from this operator set rather than handled and rejected here: its exponent must stay an un-promoted real number, so the dispatcher routes it to `applyComplexPower` first, and excluding it from the type is what makes the compiler enforce that routing instead of leaving a dead branch behind. */
function applyArithmeticOnComplex(
  op: Exclude<ArithmeticOperator, "power">,
  left: Readonly<Extract<ComputedValue, { kind: "complex" }>>,
  right: Readonly<Extract<ComputedValue, { kind: "complex" }>>,
): Evaluation<ComputedValue> {
  switch (op) {
    case "add":
      if (!unitsEqual(left.unit, right.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot add complex values with incompatible units",
        );
      }
      return definite({
        kind: "complex",
        re: left.re + right.re,
        im: left.im + right.im,
        unit: left.unit,
      });
    case "subtract":
      if (!unitsEqual(left.unit, right.unit)) {
        return indeterminate(
          "wrong-type",
          "cannot subtract complex values with incompatible units",
        );
      }
      return definite({
        kind: "complex",
        re: left.re - right.re,
        im: left.im - right.im,
        unit: left.unit,
      });
    case "multiply":
      return definite(multiplyComplexValues(left, right));
    case "divide": {
      // Multiplying both sides by the divisor's conjugate makes the denominator the real |divisor|^2, which is what turns a complex quotient into two ordinary real divisions.
      const divisorSquaredMagnitude = right.re * right.re + right.im * right.im;
      // Zero is the one complex value with no reciprocal, and it is zero in *both* components -- a divisor with only a zero real part (a purely imaginary one) divides perfectly well.
      if (divisorSquaredMagnitude === 0) {
        return indeterminate("domain-error", "division by zero");
      }
      return definite({
        kind: "complex",
        re: (left.re * right.re + left.im * right.im) / divisorSquaredMagnitude,
        im: (left.im * right.re - left.re * right.im) / divisorSquaredMagnitude,
        unit: combineUnitsForDivide(left.unit, right.unit),
      });
    }
    // Unlike the `wrong-type` cases elsewhere in this design, which mean "an answer exists but this operator does not accept this operand", modulo has no answer to accept: a remainder needs a canonical notion of "how many whole divisors fit", and the complex plane has no ordering to provide one. That is a genuine domain violation, the same category as division by zero.
    case "modulo":
      return indeterminate(
        "domain-error",
        "'modulo' is undefined for complex values",
      );
    default:
      throw new Error("unreachable arithmetic operator");
  }
}

/** `power` with a complex operand on either side, defined for exactly one case: a real integer exponent, evaluated as the repeated multiplication that integer exponentiation *is* (see the "Complex values" section of README.md for why an arbitrary complex exponent stays out of scope). */
function applyComplexPower(
  base: Readonly<Extract<ComputedValue, { kind: "number" | "complex" }>>,
  exponent: Readonly<Extract<ComputedValue, { kind: "number" | "complex" }>>,
): Evaluation<ComputedValue> {
  if (exponent.kind !== "number" || !Number.isInteger(exponent.value)) {
    return indeterminate(
      "wrong-type",
      "'power' with a complex operand requires a real integer exponent",
    );
  }
  if (!isDimensionless(base.unit) || !isDimensionless(exponent.unit)) {
    return indeterminate(
      "wrong-type",
      "'power' requires dimensionless operands",
    );
  }
  const complexUnit: Extract<ComputedValue, { kind: "complex" }> = {
    kind: "complex",
    re: 1,
    im: 0,
    unit: {},
  };
  const complexBase = toComplexValue(base);
  let repeatedProduct = complexUnit;
  for (let applied = 0; applied < Math.abs(exponent.value); applied += 1) {
    repeatedProduct = multiplyComplexValues(repeatedProduct, complexBase);
  }
  if (exponent.value >= 0) return definite(repeatedProduct);
  // A negative exponent is the reciprocal of the positive one by definition, so it reuses the division above rather than re-deriving it -- which also means a zero base inherits that operator's own division-by-zero domain-error instead of needing its own check.
  return applyArithmeticOnComplex("divide", complexUnit, repeatedProduct);
}

/**
 * Dispatches `arithmetic` by operand kind. The three cross-kind temporal combinations this design defines (`instant - instant`, `instant + duration`, `duration + instant`) are checked explicitly first, in that order, against the exact operator each requires; any other combination touching an `instant` is `wrong-type` (see "Temporal values" in README.md -- e.g. adding two instants, or subtracting a `duration` from an `instant`, are deliberately *not* defined). Same-kind `duration`/`duration` combinations are delegated to `applyArithmeticOnDurations`; a `duration` paired with anything other than an `instant` or another `duration` is `wrong-type`. Everything remaining requires two `number` operands.
 */
export function applyArithmetic(
  op: ArithmeticOperator,
  left: ComputedValue,
  right: ComputedValue,
): Evaluation<ComputedValue> {
  if (
    left.kind === "instant" &&
    right.kind === "instant" &&
    op === "subtract"
  ) {
    const leftEpoch = toEpochMilliseconds(left.value);
    if (leftEpoch === undefined) return unparseableInstant(left.value);
    const rightEpoch = toEpochMilliseconds(right.value);
    if (rightEpoch === undefined) return unparseableInstant(right.value);
    return definite({
      kind: "duration",
      value: leftEpoch - rightEpoch,
      unit: "ms",
    });
  }
  if (left.kind === "instant" && right.kind === "duration" && op === "add") {
    const leftEpoch = toEpochMilliseconds(left.value);
    if (leftEpoch === undefined) return unparseableInstant(left.value);
    return instantFromEpochMilliseconds(
      leftEpoch + toMilliseconds(right.value, right.unit),
    );
  }
  if (left.kind === "duration" && right.kind === "instant" && op === "add") {
    const rightEpoch = toEpochMilliseconds(right.value);
    if (rightEpoch === undefined) return unparseableInstant(right.value);
    return instantFromEpochMilliseconds(
      rightEpoch + toMilliseconds(left.value, left.unit),
    );
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
  if (left.kind !== "number" && left.kind !== "complex") {
    return indeterminate(
      "wrong-type",
      `arithmetic requires numeric operands; got a '${left.kind}' value`,
    );
  }
  if (right.kind !== "number" && right.kind !== "complex") {
    return indeterminate(
      "wrong-type",
      `arithmetic requires numeric operands; got a '${right.kind}' value`,
    );
  }
  if (left.kind === "complex" || right.kind === "complex") {
    if (op === "power") return applyComplexPower(left, right);
    // Both operands are `number` or `complex` by this point, so promoting the real side is always possible; the result is complex whenever either operand is, regardless of what the components turn out to be.
    return applyArithmeticOnComplex(
      op,
      toComplexValue(left),
      toComplexValue(right),
    );
  }
  return applyArithmeticOnNumbers(op, left, right);
}

/** `reference`'s optional expected-unit check: when `expectedUnit` is declared (from `node.unit`), the resolved value must be numeric (`number` or `complex`) and its own unit must match. Returns the `wrong-type` `Evaluation` to return immediately if the check fails, or `undefined` if the reference may resolve as-is. */
export function checkReferenceUnit(
  expectedUnit: Unit | undefined,
  resolvedValue: ComputedValue,
): Evaluation<never> | undefined {
  if (expectedUnit === undefined) return undefined;
  // `complex` counts as numeric here alongside `number`: it carries a `unit` of its own for exactly the same dimensional-analysis reason, so a reference to a complex-valued quantity can declare what it expects like any other.
  if (resolvedValue.kind !== "number" && resolvedValue.kind !== "complex") {
    return indeterminate(
      "wrong-type",
      "a unit was expected on a reference that resolved to a non-numeric value",
    );
  }
  if (!unitsEqual(expectedUnit, resolvedValue.unit)) {
    return indeterminate(
      "wrong-type",
      "the resolved value's unit does not match the reference's expected unit",
    );
  }
  return undefined;
}

/** `call`'s own function-registry dispatch, given the `fn` name off the tree and its already-evaluated `args`. `node.fn` comes off the serialised tree, which this design treats as data that may have been authored anywhere (see README.md's opening section), while `FunctionRegistry` is an ordinary object with `Object.prototype` on its chain. A bare index lookup would therefore resolve `toString`, `valueOf`, `constructor` and friends as though a consumer had registered them; only the registry's own keys count as registered function names. */
export function invokeRegisteredFunction(
  functions: Readonly<FunctionRegistry>,
  fnName: string,
  args: readonly ComputedValue[],
): Evaluation<ComputedValue> {
  const fn = Object.hasOwn(functions, fnName) ? functions[fnName] : undefined;
  if (fn === undefined) {
    return indeterminate(
      "wrong-type",
      `no function registered under the name '${fnName}'`,
    );
  }
  const outcome = fn(args);
  if ("domainError" in outcome) {
    return indeterminate("domain-error", outcome.domainError);
  }
  return definite(outcome);
}
