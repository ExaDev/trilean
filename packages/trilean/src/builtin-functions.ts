import type { ComputedValue, Unit } from "./computed-value";
import { unitsEqual } from "./computed-value";
import type { FunctionRegistry } from "./functions";

const DECIMAL_BASE = 10;

type NumberValue = Extract<ComputedValue, { kind: "number" }>;
type FunctionResult = ComputedValue | { domainError: string };

function isNumberValue(value: ComputedValue | undefined): value is NumberValue {
  return value?.kind === "number";
}

function isDimensionless(value: NumberValue): boolean {
  return unitsEqual(value.unit, undefined);
}

function withUnit(value: number, unit: Unit | undefined): NumberValue {
  return unit === undefined
    ? { kind: "number", value }
    : { kind: "number", value, unit };
}

/** Rejects a result that left the finite range (an overflow or a limit), which would otherwise surface as `Infinity` or `NaN` inside a definite value. */
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
): NumberValue | { domainError: string } {
  const [arg] = args;
  if (args.length !== 1 || !isNumberValue(arg)) {
    return { domainError: `${name} requires exactly one number argument` };
  }

  return arg;
}

/** Halves every dimension's exponent, or `undefined` when one is odd and the root would need a fractional exponent. */
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
    return { domainError: `${name} requires at least one number argument` };
  }
  let best = first;
  for (const arg of rest) {
    if (!isNumberValue(arg)) {
      return { domainError: `${name} requires number arguments only` };
    }
    if (!unitsEqual(arg.unit, first.unit)) {
      return { domainError: `${name} requires arguments in the same unit` };
    }
    if (prefer(arg.value, best.value)) best = arg;
  }

  return best;
}

/**
 * The numeric functions a `call` node can name when an embedder has no registry of its own: `minimum` and `maximum` (one or more numbers in a shared unit), `absoluteValue`, `round` (half away from zero, with an optional count of decimal places), `squareRoot`, `exponential`, and `logarithm` (natural, or to an optional base). Every result stays inside the three-outcome model: an argument of the wrong kind or outside the function's domain is a `domainError`, never an exception.
 *
 * Units follow the evaluator's own rule that dimensions are never silently converted. `minimum`, `maximum`, `absoluteValue` and `round` keep the argument's unit (and the first requires all arguments to share one); `squareRoot` halves each dimension's exponent and refuses a unit whose exponents are not all even; `exponential` and `logarithm` accept only dimensionless numbers and return one.
 */
export const builtinFunctions: FunctionRegistry = {
  minimum: (args) =>
    extremum("minimum", args, (candidate, best) => candidate < best),
  maximum: (args) =>
    extremum("maximum", args, (candidate, best) => candidate > best),
  absoluteValue: (args) => {
    const arg = singleNumber("absoluteValue", args);
    if ("domainError" in arg) return arg;

    return withUnit(Math.abs(arg.value), arg.unit);
  },
  round: (args) => {
    const [value, decimals, ...extra] = args;
    if (!isNumberValue(value) || extra.length > 0) {
      return {
        domainError:
          "round requires a number and an optional count of decimal places",
      };
    }
    if (decimals === undefined) {
      return finiteNumber(
        "round",
        roundHalfAwayFromZero(value.value, 1),
        value.unit,
      );
    }
    if (
      !isNumberValue(decimals) ||
      !isDimensionless(decimals) ||
      !Number.isInteger(decimals.value)
    ) {
      return {
        domainError:
          "round requires its decimal places to be a dimensionless integer",
      };
    }

    return finiteNumber(
      "round",
      roundHalfAwayFromZero(value.value, DECIMAL_BASE ** decimals.value),
      value.unit,
    );
  },
  squareRoot: (args) => {
    const arg = singleNumber("squareRoot", args);
    if ("domainError" in arg) return arg;
    if (arg.value < 0) {
      return {
        domainError: "squareRoot of a negative number is not a real number",
      };
    }
    const unit = halveUnit(arg.unit);
    if (unit === false) {
      return {
        domainError: "squareRoot requires every unit exponent to be even",
      };
    }

    return finiteNumber("squareRoot", Math.sqrt(arg.value), unit);
  },
  exponential: (args) => {
    const arg = singleNumber("exponential", args);
    if ("domainError" in arg) return arg;
    if (!isDimensionless(arg)) {
      return { domainError: "exponential requires a dimensionless number" };
    }

    return finiteNumber("exponential", Math.exp(arg.value));
  },
  logarithm: (args) => {
    const [value, base, ...extra] = args;
    if (!isNumberValue(value) || extra.length > 0) {
      return {
        domainError: "logarithm requires a number and an optional base",
      };
    }
    if (!isDimensionless(value) || value.value <= 0) {
      return {
        domainError: "logarithm requires a dimensionless number above zero",
      };
    }
    if (base === undefined) {
      return finiteNumber("logarithm", Math.log(value.value));
    }
    if (
      !isNumberValue(base) ||
      !isDimensionless(base) ||
      base.value <= 0 ||
      base.value === 1
    ) {
      return {
        domainError:
          "logarithm requires its base to be a dimensionless number above zero other than one",
      };
    }

    return finiteNumber(
      "logarithm",
      Math.log(value.value) / Math.log(base.value),
    );
  },
};

function roundHalfAwayFromZero(value: number, scale: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale;
}
