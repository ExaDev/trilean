import type { ComputedValue, Unit } from "./computed-value";
import { unitsEqual } from "./computed-value";
import { complexFromPolar, complexMagnitude, complexPhase } from "./complex";
import type { FunctionFailure, FunctionRegistry } from "./functions";

type NumberValue = Extract<ComputedValue, { kind: "number" }>;
type ComplexValue = Extract<ComputedValue, { kind: "complex" }>;
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

/** The one exit for every complex result, as `finiteNumber` is for real ones. A complex argument always gives a complex result, even when the imaginary part comes out zero, as the evaluator's own complex arithmetic does: the result kind follows the argument kind, never the value. */
function finiteComplex(
  name: string,
  { re, im }: { re: number; im: number },
  unit?: Unit,
): FunctionResult {
  if (!Number.isFinite(re) || !Number.isFinite(im)) {
    return {
      domainError: `${name} produced a result that is not a finite number`,
    };
  }

  return unit === undefined
    ? { kind: "complex", re, im }
    : { kind: "complex", re, im, unit };
}

function singleNumberOrComplex(
  name: string,
  args: readonly ComputedValue[],
): NumberValue | ComplexValue | { wrongType: string } {
  const [arg] = args;
  if (
    args.length !== 1 ||
    (arg?.kind !== "number" && arg?.kind !== "complex")
  ) {
    return {
      wrongType: `${name} requires exactly one number or complex number argument`,
    };
  }

  return arg;
}

/** The value of a single dimensionless real argument, or the `wrongType` refusing anything else (a complex value included). */
function singleDimensionless(
  name: string,
  args: readonly ComputedValue[],
): number | { wrongType: string } {
  const arg = singleNumber(name, args);
  if ("wrongType" in arg) return arg;
  if (!isDimensionless(arg)) {
    return { wrongType: `${name} requires a dimensionless number` };
  }

  return arg.value;
}

/** A real function of one dimensionless number, returning a dimensionless number. */
function dimensionlessFunction(
  name: string,
  apply: (value: number) => number,
): (args: readonly ComputedValue[]) => FunctionResult {
  return (args) => {
    const value = singleDimensionless(name, args);
    if (typeof value !== "number") return value;

    return finiteNumber(name, apply(value));
  };
}

/** An inverse sine or cosine, whose real domain is the closed interval from -1 to 1; outside it the inverse is not a real number, which is a `domainError` rather than the `NaN` `Math.asin` and `Math.acos` return. */
function unitIntervalInverse(
  name: string,
  apply: (value: number) => number,
): (args: readonly ComputedValue[]) => FunctionResult {
  return (args) => {
    const value = singleDimensionless(name, args);
    if (typeof value !== "number") return value;
    if (!(Math.abs(value) <= 1)) {
      return { domainError: `${name} requires a number from -1 to 1` };
    }

    return finiteNumber(name, apply(value));
  };
}

/**
 * The principal square root of a complex value: the root whose real part is not negative, with the branch cut along the negative real axis. On the cut the root lies on the positive imaginary axis whatever the sign of the zero imaginary part, matching `complexPhase`'s +pi for a negative real number, so `sqrt(z)` is `sqrt(|z|) * e^(i * phase(z) / 2)` everywhere.
 *
 * It is computed by the closed form rather than through that polar expression: with `t = sqrt((|re| + |z|) / 2)`, the root is `t + (im / 2t)i` when `re` is not negative and `|im| / 2t + t i` (with the sign of `im` on `t`) otherwise. Neither form subtracts two nearly equal quantities, and an exactly representable root comes out exact (`sqrt(-4)` is `2i`, where `cos(pi / 2)` would leave a stray real part of about 1e-16).
 */
function principalSquareRoot(value: ComplexValue): { re: number; im: number } {
  const modulus = complexMagnitude(value).value;
  if (modulus === 0) return { re: 0, im: 0 };
  const sum = Math.abs(value.re) + modulus;
  // Halving each term first would lose the last bit of a subnormal, so it is done only where the sum itself overflows, when both terms are far above the subnormal range.
  const half = Number.isFinite(sum)
    ? sum / 2
    : Math.abs(value.re) / 2 + modulus / 2;
  const t = Math.sqrt(half);
  const { im } = value;
  if (value.re >= 0) return { re: t, im: im / (2 * t) };

  // `-0 < 0` is false, so a negative real number's root is on the positive imaginary axis whatever the sign of its zero, as the doc comment above states.
  return { re: Math.abs(im) / (2 * t), im: im < 0 ? -t : t };
}

/** The logarithm of a positive real number, natural or to a base already checked to be above zero and not one. */
function realLogarithm(value: number, base: number | undefined): number {
  if (base === undefined) return Math.log(value);
  // `Math.log10` and `Math.log2` are exact on powers of their base where `Math.log(x) / Math.log(base)` is not (`log(1000) / log(10)` is 2.9999999999999996).
  if (base === DECIMAL_BASE) return Math.log10(value);
  if (base === BINARY_BASE) return Math.log2(value);

  return Math.log(value) / Math.log(base);
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
 * The numeric functions a `call` node can name when an embedder has no registry of its own: `minimum` and `maximum` (one or more numbers in a shared unit), `absoluteValue`, `round` (half away from zero, with an optional count of decimal places), `squareRoot`, `exponential`, `logarithm` (natural, or to an optional real base), the two projections of a complex value onto the reals, `magnitude` and `phase`, and the trigonometric functions `sine`, `cosine`, `tangent`, `arcSine`, `arcCosine`, `arcTangent` and `arcTangent2` (the angle of the point `(x, y)`, called with `y` first).
 *
 * Which take a complex value: `squareRoot`, `exponential`, `logarithm` and `magnitude` take a real or a complex number, and `phase` a complex one only. Every other function takes real numbers only and refuses a complex value. A real argument to `squareRoot`, `exponential` or `logarithm` gives a real result, so a negative `squareRoot` or a `logarithm` of zero or a negative number stays a `domainError` rather than becoming complex; a complex argument gives a complex result, the principal value, even when its imaginary part comes out zero, as the evaluator's own complex arithmetic does. The principal values take the branch cut along the negative real axis with `phase`'s convention on it: `logarithm` is `log|z| + i phase(z)` (divided through by the natural logarithm of a base when one is given), so its imaginary part lies in [-pi, pi], and `squareRoot` is the root with a real part that is not negative, on the positive imaginary axis for a negative real number whatever the sign of its zero imaginary part.
 *
 * Failures split as the evaluator's own operators split. An argument a function cannot accept at all (the wrong kind, the wrong count, or units that do not fit) is a `wrongType`; an argument of the right kind outside the function's domain (a negative real `squareRoot`, a `logarithm` of zero, a base of one, a fractional count of decimal places, an `arcSine` or `arcCosine` outside -1 to 1) or a result that is not a finite number (in either component of a complex one) is a `domainError`. A `tangent` near a pole is large but finite, since no double is an odd multiple of pi/2 exactly.
 *
 * Units follow the evaluator's rule that dimensions are never silently converted. `minimum`, `maximum`, `absoluteValue`, `round` and `magnitude` keep the argument's unit (and the first two require all arguments to share one); `phase` returns a dimensionless angle in radians in the range [-pi, pi], whatever unit its argument carries, with a negative real number +pi whatever the sign of its zero imaginary part (a signed zero never gives -pi, though a tiny negative imaginary part can round to it) and zero 0 (a component that is not finite is a `domainError`); `squareRoot` halves each dimension's exponent and refuses a unit whose exponents are not all even; `exponential`, `logarithm` and the trigonometric functions accept only dimensionless numbers and return one, angles in radians. `arcTangent2` is the `phase` of `x + yi`, so it shares that range and signed-zero handling, and its two arguments must be finite.
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
    const arg = singleNumberOrComplex("squareRoot", args);
    if ("wrongType" in arg) return arg;
    const unit = halveUnit(arg.unit);
    if (unit === false) {
      return {
        wrongType: "squareRoot requires every unit exponent to be even",
      };
    }
    if (arg.kind === "complex") {
      return finiteComplex("squareRoot", principalSquareRoot(arg), unit);
    }
    if (arg.value < 0) {
      return {
        domainError: "squareRoot of a negative number is not a real number",
      };
    }

    return finiteNumber("squareRoot", Math.sqrt(arg.value), unit);
  },
  exponential: (args) => {
    const arg = singleNumberOrComplex("exponential", args);
    if ("wrongType" in arg) return arg;
    if (!unitsEqual(arg.unit, undefined)) {
      return { wrongType: "exponential requires a dimensionless number" };
    }
    if (arg.kind === "complex") {
      // e^(re + im i) is e^re * (cos im + i sin im): the polar value with magnitude e^re and phase im.
      return finiteComplex(
        "exponential",
        complexFromPolar(Math.exp(arg.re), arg.im),
      );
    }

    return finiteNumber("exponential", Math.exp(arg.value));
  },
  logarithm: (args) => {
    const [value, base, ...extra] = args;
    if (
      (value?.kind !== "number" && value?.kind !== "complex") ||
      extra.length > 0
    ) {
      return {
        wrongType:
          "logarithm requires a number or a complex number and an optional base",
      };
    }
    if (!unitsEqual(value.unit, undefined)) {
      return { wrongType: "logarithm requires a dimensionless number" };
    }
    const baseNumber =
      base === undefined ? undefined : dimensionlessNumber(base);
    if (base !== undefined && baseNumber === undefined) {
      return {
        wrongType: "logarithm requires its base to be a dimensionless number",
      };
    }
    if (value.kind === "number" && value.value <= 0) {
      return { domainError: "logarithm requires a number above zero" };
    }
    if (value.kind === "complex" && value.re === 0 && value.im === 0) {
      return {
        domainError: "logarithm requires a complex number other than zero",
      };
    }
    if (baseNumber !== undefined && (baseNumber <= 0 || baseNumber === 1)) {
      return {
        domainError: "logarithm requires its base to be above zero and not one",
      };
    }
    if (value.kind === "number") {
      return finiteNumber("logarithm", realLogarithm(value.value, baseNumber));
    }

    // The principal value, log|z| + i arg(z), divided through by ln(base) when a base is given; its imaginary part lies in [-pi, pi] (scaled by that divisor), as `phase` does.
    return finiteComplex("logarithm", {
      re: realLogarithm(complexMagnitude(value).value, baseNumber),
      im:
        complexPhase(value).value /
        (baseNumber === undefined ? 1 : Math.log(baseNumber)),
    });
  },
  magnitude: (args) => {
    const [arg] = args;
    if (args.length !== 1) {
      return { wrongType: "magnitude requires exactly one argument" };
    }
    if (arg?.kind === "complex") {
      const { value, unit } = complexMagnitude(arg);

      return finiteNumber("magnitude", value, unit);
    }
    if (arg?.kind !== "number") {
      return { wrongType: "magnitude requires a number or a complex number" };
    }

    return finiteNumber("magnitude", Math.abs(arg.value), arg.unit);
  },
  phase: (args) => {
    const [arg] = args;
    if (args.length !== 1 || arg?.kind !== "complex") {
      return { wrongType: "phase requires exactly one complex argument" };
    }
    if (!Number.isFinite(arg.re) || !Number.isFinite(arg.im)) {
      // atan2 of finite components is always finite, so refusing a non-finite component here is the whole of the finite check; it has no overflow to catch afterwards, unlike `magnitude`.
      return { domainError: "phase requires finite components" };
    }

    return complexPhase(arg);
  },
  sine: dimensionlessFunction("sine", Math.sin),
  cosine: dimensionlessFunction("cosine", Math.cos),
  tangent: dimensionlessFunction("tangent", Math.tan),
  arcSine: unitIntervalInverse("arcSine", Math.asin),
  arcCosine: unitIntervalInverse("arcCosine", Math.acos),
  arcTangent: dimensionlessFunction("arcTangent", Math.atan),
  arcTangent2: (args) => {
    const [y, x] = args;
    if (args.length !== 2 || !isNumberValue(y) || !isNumberValue(x)) {
      return { wrongType: "arcTangent2 requires exactly two number arguments" };
    }
    if (!isDimensionless(y) || !isDimensionless(x)) {
      return { wrongType: "arcTangent2 requires dimensionless numbers" };
    }
    if (!Number.isFinite(y.value) || !Number.isFinite(x.value)) {
      return { domainError: "arcTangent2 requires finite arguments" };
    }

    // The angle of the point (x, y) is the phase of x + yi, so it shares `phase`'s range and its handling of signed zeros rather than restating them.
    return complexPhase({ kind: "complex", re: x.value, im: y.value });
  },
} satisfies FunctionRegistry);
