import { decodeNumbers } from "./values";

/**
 * How a corpus expectation compares with what an implementation returned. Numbers are equal when `Object.is` says so (`-0` is not `0`), or within the tolerance a case gives (`ulps` units in the last place, or an `absolute` distance); an object key whose value is `undefined` counts as absent, since JSON has no `undefined`; every other value must match structurally.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FLOAT64_BYTES = 8;
const ONE = 1n;
const SIGN_SHIFT = 63n;

/** The position of a finite double in the total order of all doubles, as an integer. */
function orderedBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(FLOAT64_BYTES));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const sign = ONE << SIGN_SHIFT;

  return bits & sign ? -(bits & ~sign) : bits;
}

/** The number of doubles between two numbers, or infinity when either is not a number. */
export function ulpDistance(a: number, b: number): number {
  if (Object.is(a, b)) {
    return 0;
  }
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return Number.POSITIVE_INFINITY;
  }
  const first = orderedBits(a);
  const second = orderedBits(b);

  return Number(first > second ? first - second : second - first);
}

function definedKeys(value: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
}

/** How far a number may be from the one a case gives: within `ulps` units in the last place, or at most `absolute` apart. With neither it must be the same double. */
export interface Tolerance {
  readonly ulps?: number;
  readonly absolute?: number;
}

function withinTolerance(
  actual: number,
  expected: number,
  tolerance: Tolerance,
): boolean {
  if (tolerance.absolute !== undefined) {
    return Math.abs(actual - expected) <= tolerance.absolute;
  }

  return ulpDistance(actual, expected) <= (tolerance.ulps ?? 0);
}

/** Whether `actual` equals `expected` under the rules above. */
export function jsonEquals(
  actual: unknown,
  wanted: unknown,
  tolerance: Tolerance = {},
): boolean {
  return equalsDecoded(actual, decodeNumbers(wanted), tolerance);
}

/** Whether `actual` matches `expected` where `expected` names only some of the fields: an object matches when every key it gives matches, an array matches element by element at the same length, any other value must be equal (numbers by the tolerance). */
export function subsetMatches(
  actual: unknown,
  wanted: unknown,
  tolerance: Tolerance = {},
): boolean {
  return subsetDecoded(actual, decodeNumbers(wanted), tolerance);
}

function subsetDecoded(
  actual: unknown,
  expected: unknown,
  tolerance: Tolerance,
): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item: unknown, position) =>
        subsetDecoded(actual[position], item, tolerance),
      )
    );
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(
        ([key, item]) =>
          key in actual && subsetDecoded(actual[key], item, tolerance),
      )
    );
  }

  return equalsDecoded(actual, expected, tolerance);
}

function equalsDecoded(
  actual: unknown,
  expected: unknown,
  tolerance: Tolerance,
): boolean {
  if (typeof expected === "number") {
    return (
      typeof actual === "number" && withinTolerance(actual, expected, tolerance)
    );
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item: unknown, position) =>
        equalsDecoded(actual[position], item, tolerance),
      )
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) {
      return false;
    }
    const entries = Object.entries(expected);

    return (
      definedKeys(actual).length === entries.length &&
      entries.every(
        ([key, item]) =>
          key in actual && equalsDecoded(actual[key], item, tolerance),
      )
    );
  }

  return Object.is(actual, expected);
}
