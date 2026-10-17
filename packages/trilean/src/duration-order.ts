import type { DurationUnit } from "./computed-value";

/** How many milliseconds one of each duration unit is. Every unit is a whole multiple of every finer one, which is what lets a value be divided down into a coarser unit by an exact integer. */
export const millisecondsPerDurationUnit: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

type Ordering = -1 | 0 | 1;

const ONE = 1n;
const FRACTION_BITS = 52n;
const FRACTION_MASK = (ONE << FRACTION_BITS) - ONE;
const IMPLICIT_LEADING_BIT = ONE << FRACTION_BITS;
const EXPONENT_FIELD_MASK = 0x7ffn;
const EXPONENT_BIAS_WITH_FRACTION = 1075;
const SUBNORMAL_EXPONENT = -1074;

const scratchValue = new Float64Array(1);
const scratchBits = new BigUint64Array(scratchValue.buffer);

/** A finite double as `significand * 2 ** exponent` with an integer significand, exactly, read from its bit pattern. Zero has a zero significand. */
function exactParts(magnitude: number): {
  significand: bigint;
  exponent: number;
} {
  scratchValue[0] = magnitude;
  const bits = scratchBits[0];
  if (bits === undefined) {
    throw new Error("a one-element array always has an element zero");
  }
  const exponentField = Number((bits >> FRACTION_BITS) & EXPONENT_FIELD_MASK);
  const fraction = bits & FRACTION_MASK;
  if (exponentField === 0) {
    return { significand: fraction, exponent: SUBNORMAL_EXPONENT };
  }

  return {
    significand: fraction | IMPLICIT_LEADING_BIT,
    exponent: exponentField - EXPONENT_BIAS_WITH_FRACTION,
  };
}

function orderOf(left: bigint | number, right: bigint | number): Ordering {
  if (left < right) return -1;

  return left > right ? 1 : 0;
}

/** The exact order of `left * leftSize` and `right * rightSize` for finite doubles and positive integer sizes, by comparing the products as integers once both are written over a common power of two. */
function exactOrder(
  left: Readonly<{ value: number; size: number }>,
  right: Readonly<{ value: number; size: number }>,
): Ordering {
  const leftSign = Math.sign(left.value);
  const rightSign = Math.sign(right.value);
  if (leftSign !== rightSign) return leftSign < rightSign ? -1 : 1;
  if (leftSign === 0) return 0;
  const leftParts = exactParts(Math.abs(left.value));
  const rightParts = exactParts(Math.abs(right.value));
  let leftProduct = leftParts.significand * BigInt(left.size);
  let rightProduct = rightParts.significand * BigInt(right.size);
  const shift = leftParts.exponent - rightParts.exponent;
  if (shift > 0) leftProduct <<= BigInt(shift);
  else rightProduct <<= BigInt(-shift);

  // Of two negative numbers, the one with the larger magnitude is the smaller.
  return leftSign < 0
    ? orderOf(rightProduct, leftProduct)
    : orderOf(leftProduct, rightProduct);
}

/**
 * The order of two durations: -1, 0 or 1, or `undefined` when a NaN makes them unordered.
 *
 * A value that is not finite is handled first, as numbers are: a NaN is unordered against everything (so every comparison with it is false, and `neq` true), and an infinity is equal to the same infinity and greater or less than anything finite whatever the units, since a unit only scales by a positive amount. The bit-pattern comparison below reads a finite double's exact value and has no meaning for these.
 *
 * Two finite durations are ordered exactly, with no overflow and no underflow. Both are divided into the coarser of the two units. A division by an exact integer is correctly rounded and rounding is monotone, so it can collapse a difference into equality but never reverse an order: when the two rounded values differ their order is the true order, and that settles almost every comparison without leaving floating point. Dividing can lose the difference, though: two close values round to the same double, and a subnormal rounds to zero. Only when the rounded values are equal is the answer settled exactly, from the doubles' binary expansions, by comparing each value times its unit's size in milliseconds as integers.
 *
 * Converting both to milliseconds by multiplying instead overflows for spans of days beyond roughly 1e300, which is why it is not done here.
 */
export function compareDurations(
  left: Readonly<{ value: number; unit: DurationUnit }>,
  right: Readonly<{ value: number; unit: DurationUnit }>,
): Ordering | undefined {
  if (Number.isNaN(left.value) || Number.isNaN(right.value)) return undefined;
  if (!Number.isFinite(left.value) || !Number.isFinite(right.value)) {
    return orderOf(left.value, right.value);
  }
  const leftSize = millisecondsPerDurationUnit[left.unit];
  const rightSize = millisecondsPerDurationUnit[right.unit];
  const sharedSize = Math.max(leftSize, rightSize);
  const leftInShared = left.value / (sharedSize / leftSize);
  const rightInShared = right.value / (sharedSize / rightSize);
  if (leftInShared < rightInShared) return -1;
  if (leftInShared > rightInShared) return 1;

  return exactOrder(
    { value: left.value, size: leftSize },
    { value: right.value, size: rightSize },
  );
}
