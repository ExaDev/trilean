import { describe, expect, it } from "vitest";
import type { DurationUnit } from "./computed-value";
import {
  compareDurations,
  millisecondsPerDurationUnit,
} from "./duration-order";

interface Duration {
  value: number;
  unit: DurationUnit;
}

/** A double as an exact fraction, found by doubling until it is a whole number: a different route to the exact value than the bit decomposition the implementation uses, so the two can disagree. The denominator is `2 ** doublings`, built once at the end rather than doubled on every step. */
function toFraction(value: number): { numerator: bigint; denominator: bigint } {
  let scaled = value;
  let doublings = 0;
  while (!Number.isInteger(scaled)) {
    scaled *= 2;
    doublings += 1;
  }

  return {
    numerator: BigInt(scaled),
    denominator: BigInt(2) ** BigInt(doublings),
  };
}

/** The true order of two durations: each value times its unit's size in milliseconds, as exact fractions, cross-multiplied. */
function exactOrder(left: Readonly<Duration>, right: Readonly<Duration>) {
  const l = toFraction(left.value);
  const r = toFraction(right.value);
  const leftSide =
    l.numerator *
    BigInt(millisecondsPerDurationUnit[left.unit]) *
    r.denominator;
  const rightSide =
    r.numerator *
    BigInt(millisecondsPerDurationUnit[right.unit]) *
    l.denominator;
  if (leftSide < rightSide) return -1;

  return leftSide > rightSide ? 1 : 0;
}

/** Named so the cases are the same on every run and no figure is a bare literal. A fifth of the cases are scaled into the subnormal range; each right-hand value is the same span as the left, moved by up to `ulpSpread` units in the last place either way. */
const settings = {
  seed: 7,
  cases: 3000,
  exponentSpread: 60,
  subnormalShare: 0.2,
  subnormalExponent: -1000,
  signShare: 0.5,
  ulpSpread: 3,
};

const units: DurationUnit[] = ["ms", "s", "min", "h", "d"];

/** A small deterministic generator, so the cases are the same on every run. */
const generatorParameters = {
  multiplier: 1103515245,
  increment: 12345,
  modulus: 2147483648,
};

function generator(seed: number) {
  const { multiplier, increment, modulus } = generatorParameters;
  let state = seed;

  return () => {
    state = (state * multiplier + increment) % modulus;

    return state / modulus;
  };
}

/** The double a few units in the last place away, never below zero (the bit pattern below zero is a negative NaN, not a smaller number). */
const bitWidth = 64;

function nudge(value: number, ulps: number): number {
  const buffer = new Float64Array([value]);
  const bits = new BigUint64Array(buffer.buffer);
  const moved = BigInt.asIntN(bitWidth, bits[0] ?? BigInt(0)) + BigInt(ulps);
  bits[0] = moved < BigInt(0) ? BigInt(0) : moved;

  return buffer[0] ?? value;
}

describe("compareDurations", () => {
  it.each([
    [{ value: 5e-324, unit: "ms" }, { value: 0, unit: "d" }, 1],
    [{ value: 0, unit: "d" }, { value: 5e-324, unit: "ms" }, -1],
    [{ value: -5e-324, unit: "ms" }, { value: 0, unit: "d" }, -1],
    [{ value: 1e-310, unit: "ms" }, { value: 0, unit: "s" }, 1],
    [{ value: 0, unit: "h" }, { value: 0, unit: "ms" }, 0],
    [
      { value: 25959408, unit: "min" },
      { value: 18027.366666666665, unit: "d" },
      1,
    ],
    [{ value: 1, unit: "d" }, { value: 86400000, unit: "ms" }, 0],
    [{ value: 1.5, unit: "h" }, { value: 90, unit: "min" }, 0],
    [{ value: -1, unit: "s" }, { value: 1, unit: "ms" }, -1],
    [{ value: -2, unit: "d" }, { value: -1, unit: "d" }, -1],
    [
      { value: -25959408, unit: "min" },
      { value: -18027.366666666665, unit: "d" },
      -1,
    ],
    [{ value: 1e305, unit: "d" }, { value: 2e305, unit: "d" }, -1],
    [{ value: 1e305, unit: "d" }, { value: 1e305, unit: "h" }, 1],
  ] as const)("orders %j and %j as %i", (left, right, expected) => {
    expect(compareDurations(left, right)).toBe(expected);
  });

  it("is exact for every pair of near-equal durations in different units, subnormals included", () => {
    const random = generator(settings.seed);
    let wrong = 0;
    const {
      cases,
      exponentSpread,
      subnormalShare,
      subnormalExponent,
      signShare,
      ulpSpread,
    } = settings;
    for (let applied = 0; applied < cases; applied += 1) {
      const leftUnit = units[Math.floor(random() * units.length)] ?? "ms";
      const rightUnit = units[Math.floor(random() * units.length)] ?? "ms";
      const exponent =
        Math.floor(random() * 2 * exponentSpread) - exponentSpread;
      const subnormal = random() < subnormalShare ? 2 ** subnormalExponent : 1;
      const sign = random() < signShare ? -1 : 1;
      const left = {
        value: sign * (1 + random()) * 2 ** exponent * subnormal,
        unit: leftUnit,
      };
      // The same span written in the other unit, moved by a few units in the last place either way.
      const sameSpan =
        (left.value * millisecondsPerDurationUnit[leftUnit]) /
        millisecondsPerDurationUnit[rightUnit];
      const right = {
        value:
          sign *
          nudge(
            Math.abs(sameSpan),
            Math.floor(random() * (2 * ulpSpread + 1)) - ulpSpread,
          ),
        unit: rightUnit,
      };
      if (compareDurations(left, right) !== exactOrder(left, right)) wrong += 1;
    }

    expect(wrong).toBe(0);
  });
});
