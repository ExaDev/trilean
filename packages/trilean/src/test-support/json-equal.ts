/**
 * How a corpus expectation compares with what an implementation returned. Numbers are equal when `Object.is` says so (`-0` is not `0`), or within `ulps` units in the last place when a case gives a tolerance; an object key whose value is `undefined` counts as absent, since JSON has no `undefined`; every other value must match structurally.
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

/** Whether `actual` equals `expected` under the rules above. */
export function jsonEquals(
  actual: unknown,
  expected: unknown,
  ulps = 0,
): boolean {
  if (typeof expected === "number") {
    return typeof actual === "number" && ulpDistance(actual, expected) <= ulps;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item: unknown, position) =>
        jsonEquals(actual[position], item, ulps),
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
        ([key, item]) => key in actual && jsonEquals(actual[key], item, ulps),
      )
    );
  }

  return Object.is(actual, expected);
}
