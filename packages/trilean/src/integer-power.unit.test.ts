import { describe, expect, it } from "vitest";
import { powerByRepeatedSquaring } from "./integer-power";

/** Multiplication that counts its own calls, so a test can assert the work done rather than the time taken. */
function countingMultiply() {
  const counter = { calls: 0 };

  return {
    counter,
    multiply: (left: number, right: number) => {
      counter.calls += 1;

      return left * right;
    },
  };
}

function repeatedMultiplication(base: number, exponent: number): number {
  let product = 1;
  for (let applied = 0; applied < exponent; applied += 1) product *= base;

  return product;
}

/** One multiplication per bit of the exponent for the squarings, and at most one more for the product. */
function maximumMultiplications(exponent: number): number {
  return 2 * (Math.floor(Math.log2(exponent)) + 1);
}

/** Rows are objects so each literal is an object-literal property value, which `no-magic-numbers` exempts, rather than a bare call argument or array element. */
const smallExponents = Array.from({ length: 34 }, (_unused, exponent) => ({
  exponent,
}));

const safeIntegerBits = 52;

const largeExponents = [
  { exponent: 1000 },
  { exponent: 1e9 },
  { exponent: 1e15 },
  { exponent: 2 ** safeIntegerBits },
  { exponent: Number.MAX_SAFE_INTEGER },
];

describe("powerByRepeatedSquaring", () => {
  it.each(smallExponents)(
    "matches repeated multiplication for exponent $exponent",
    ({ exponent }) => {
      const base = 3;

      expect(
        powerByRepeatedSquaring({
          base,
          exponent,
          identity: 1,
          multiply: (left, right) => left * right,
        }),
      ).toBe(repeatedMultiplication(base, exponent));
    },
  );

  it("returns the identity for exponent zero without multiplying", () => {
    const { counter, multiply } = countingMultiply();

    expect(
      powerByRepeatedSquaring({ base: 7, exponent: 0, identity: 1, multiply }),
    ).toBe(1);
    expect(counter.calls).toBe(0);
  });

  it.each(largeExponents)(
    "multiplies a number of times logarithmic in the exponent $exponent",
    ({ exponent }) => {
      const { counter, multiply } = countingMultiply();

      powerByRepeatedSquaring({ base: 1, exponent, identity: 1, multiply });

      expect(counter.calls).toBeLessThanOrEqual(
        maximumMultiplications(exponent),
      );
    },
  );

  it("handles an exponent past the safe integers, whose low bits are all zero", () => {
    const { counter, multiply } = countingMultiply();
    const exponent = 1e300;

    expect(
      powerByRepeatedSquaring({ base: 1, exponent, identity: 1, multiply }),
    ).toBe(1);
    expect(counter.calls).toBeLessThanOrEqual(maximumMultiplications(exponent));
  });
});
