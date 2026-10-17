import type { ComputedValue, Unit } from "./computed-value";
import { unitsEqual } from "./computed-value";
import type { FunctionFailure, FunctionRegistry } from "./functions";

type NumberValue = Extract<ComputedValue, { kind: "number" }>;
type FunctionResult = ComputedValue | FunctionFailure;

const DECIMAL_BASE = 10;
const BINARY_BASE = 2;

/** Beyond this many decimal places a double either has no digit left to round (positive places) or rounds to zero (negative places): the decimal exponent range of a finite double, from the largest value's order of magnitude down to the smallest subnormal's. Clamping to it keeps the exponent written into a number string well formed whatever count a caller passes. */
const DECIMAL_PLACES_LIMIT = Math.ceil(
  Math.log10(Number.MAX_VALUE) - Math.log10(Number.MIN_VALUE),
);

function isNumberValue(value: ComputedValue | undefined): value is NumberValue {
  return value?.kind === "number";
}

function isDimensionless(value: NumberValue): boolean {
  return unitsEqual(value.unit, undefined);
}

/** The magnitude of a number that carries no unit, or `undefined` for any other value. */
function dimensionlessNumber(value: ComputedValue): number | undefined {
  return isNumberValue(value) && isDimensionless(value)
    ? value.value
    : undefined;
}

function withUnit(value: number, unit: Unit | undefined): NumberValue {
  return unit === undefined
    ? { kind: "number", value }
    : { kind: "number", value, unit };
}

/** The one exit for every numeric result: a value that left the finite range (an overflow or a limit) would otherwise surface as `Infinity` or `NaN` inside a definite value, which JSON writes as `null`. */
function finiteNumber(
  name: string,
  value: number,
  unit?: Unit,
): FunctionResult {
  return Number.isFinite(value)
    ? withUnit(value, unit)
    : { domainError: `${name} produced a result that is not a finite number` };
}

function singleNumber(
  name: string,
  args: readonly ComputedValue[],
): NumberValue | { wrongType: string } {
  const [arg] = args;
  if (args.length !== 1 || !isNumberValue(arg)) {
    return { wrongType: `${name} requires exactly one number argument` };
  }

  return arg;
}

/** Halves every dimension's exponent, or `false` when one is odd and the root would need a fractional exponent. */
function halveUnit(unit: Unit | undefined): Unit | undefined | false {
  if (unit === undefined) return undefined;
  const halved: Unit = {};
  for (const [dimension, exponent] of Object.entries(unit)) {
    if (exponent === 0) continue;
    if (exponent % 2 !== 0) return false;
    halved[dimension] = exponent / 2;
  }

  return halved;
}

function extremum(
  name: string,
  args: readonly ComputedValue[],
  prefer: (candidate: number, best: number) => boolean,
): FunctionResult {
  const [first, ...rest] = args;
  if (!isNumberValue(first)) {
    return { wrongType: `${name} requires at least one number argument` };
  }
  let best = first;
  for (const arg of rest) {
    if (!isNumberValue(arg)) {
      return { wrongType: `${name} requires number arguments only` };
    }
    if (!unitsEqual(arg.unit, first.unit)) {
      return { wrongType: `${name} requires arguments in the same unit` };
    }
    if (prefer(arg.value, best.value)) best = arg;
  }

  return finiteNumber(name, best.value, best.unit);
}

/** Moves the decimal point of a number by editing the exponent of its shortest decimal form, so `1.005` shifted by 2 places is parsed from the text `1.005e2` (exactly 100.5) rather than computed as `1.005 * 100` (100.49999999999999). `String` writes a large or small value in exponent form already (`1.5e-7`), so the existing exponent is read and added to rather than appended to. */
function shiftDecimalPoint(value: number, places: number): number {
  const text = String(value);
  const marker = text.indexOf("e");
  const mantissa = marker === -1 ? text : text.slice(0, marker);
  const exponent = marker === -1 ? 0 : Number(text.slice(marker + 1));

  return Number(`${mantissa}e${String(exponent + places)}`);
}

/** Rounds to `places` decimal places, halves away from zero, working on the decimal number the value is written as. A value whose shifted magnitude reaches the largest safe integer has no fractional digit at that precision (or shifts out of the finite range altogether), so it is returned as it is. */
function roundHalfAwayFromZero(value: number, places: number): number {
  const clamped = Math.max(
    -DECIMAL_PLACES_LIMIT,
    Math.min(DECIMAL_PLACES_LIMIT, places),
  );
  const magnitude = Math.abs(value);
  const shifted = shiftDecimalPoint(magnitude, clamped);
  if (!(shifted < Number.MAX_SAFE_INTEGER)) return value;
  const rounded = shiftDecimalPoint(Math.round(shifted), -clamped);

  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}

/**
 * The numeric functions a `call` node can name when an embedder has no registry of its own: `minimum` and `maximum` (one or more numbers in a shared unit), `absoluteValue`, `round` (half away from zero, with an optional count of decimal places), `squareRoot`, `exponential`, and `logarithm` (natural, or to an optional base). They take real numbers only: a complex value is refused by every one of them, `absoluteValue` included.
 *
 * Failures split as the evaluator's own operators split. An argument a function cannot accept at all (the wrong kind, the wrong count, or units that do not fit) is a `wrongType`; an argument of the right kind outside the function's domain (a negative `squareRoot`, a `logarithm` of zero, a base of one, a fractional count of decimal places) or a result that is not a finite number is a `domainError`.
 *
 * Units follow the evaluator's rule that dimensions are never silently converted. `minimum`, `maximum`, `absoluteValue` and `round` keep the argument's unit (and the first two require all arguments to share one); `squareRoot` halves each dimension's exponent and refuses a unit whose exponents are not all even; `exponential` and `logarithm` accept only dimensionless numbers and return one.
 *
 * Frozen, so mutating the export cannot change what `evaluateDocument` resolves.
 */
export const builtinFunctions: FunctionRegistry = Object.freeze({
  minimum: (args) =>
    extremum("minimum", args, (candidate, best) => candidate < best),
  maximum: (args) =>
    extremum("maximum", args, (candidate, best) => candidate > best),
  absoluteValue: (args) => {
    const arg = singleNumber("absoluteValue", args);
    if ("wrongType" in arg) return arg;

    return finiteNumber("absoluteValue", Math.abs(arg.value), arg.unit);
  },
  round: (args) => {
    const [value, places, ...extra] = args;
    if (!isNumberValue(value) || extra.length > 0) {
      return {
        wrongType:
          "round requires a number and an optional count of decimal places",
      };
    }
    if (places === undefined) {
      return finiteNumber(
        "round",
        roundHalfAwayFromZero(value.value, 0),
        value.unit,
      );
    }
    if (!isNumberValue(places) || !isDimensionless(places)) {
      return {
        wrongType:
          "round requires its decimal places to be a dimensionless number",
      };
    }
    if (!Number.isInteger(places.value)) {
      return {
        domainError: "round requires its decimal places to be an integer",
      };
    }

    return finiteNumber(
      "round",
      roundHalfAwayFromZero(value.value, places.value),
      value.unit,
    );
  },
  squareRoot: (args) => {
    const arg = singleNumber("squareRoot", args);
    if ("wrongType" in arg) return arg;
    const unit = halveUnit(arg.unit);
    if (unit === false) {
      return {
        wrongType: "squareRoot requires every unit exponent to be even",
      };
    }
    if (arg.value < 0) {
      return {
        domainError: "squareRoot of a negative number is not a real number",
      };
    }

    return finiteNumber("squareRoot", Math.sqrt(arg.value), unit);
  },
  exponential: (args) => {
    const arg = singleNumber("exponential", args);
    if ("wrongType" in arg) return arg;
    if (!isDimensionless(arg)) {
      return { wrongType: "exponential requires a dimensionless number" };
    }

    return finiteNumber("exponential", Math.exp(arg.value));
  },
  logarithm: (args) => {
    const [value, base, ...extra] = args;
    if (!isNumberValue(value) || extra.length > 0) {
      return { wrongType: "logarithm requires a number and an optional base" };
    }
    if (!isDimensionless(value)) {
      return { wrongType: "logarithm requires a dimensionless number" };
    }
    const baseNumber =
      base === undefined ? undefined : dimensionlessNumber(base);
    if (base !== undefined && baseNumber === undefined) {
      return {
        wrongType: "logarithm requires its base to be a dimensionless number",
      };
    }
    if (value.value <= 0) {
      return { domainError: "logarithm requires a number above zero" };
    }
    if (baseNumber === undefined) {
      return finiteNumber("logarithm", Math.log(value.value));
    }
    if (baseNumber <= 0 || baseNumber === 1) {
      return {
        domainError: "logarithm requires its base to be above zero and not one",
      };
    }
    // `Math.log10` and `Math.log2` are exact on powers of their base where `Math.log(x) / Math.log(base)` is not (`log(1000) / log(10)` is 2.9999999999999996).
    if (baseNumber === DECIMAL_BASE) {
      return finiteNumber("logarithm", Math.log10(value.value));
    }
    if (baseNumber === BINARY_BASE) {
      return finiteNumber("logarithm", Math.log2(value.value));
    }

    return finiteNumber(
      "logarithm",
      Math.log(value.value) / Math.log(baseNumber),
    );
  },
} satisfies FunctionRegistry);
