import { describe, expect, it } from "vitest";
import { divideComplexComponents } from "./complex-division";

interface Complex {
  re: number;
  im: number;
}

function divide({
  dividend,
  divisor,
}: Readonly<{ dividend: Complex; divisor: Complex }>): Complex {
  return divideComplexComponents(dividend, divisor);
}

/** The relative error of `actual` against `expected` over the pair, as a norm, which is the accuracy complex division is judged by. */
function normwiseError(actual: Readonly<Complex>, expected: Readonly<Complex>) {
  const distance = Math.hypot(actual.re - expected.re, actual.im - expected.im);

  return distance / Math.hypot(expected.re, expected.im);
}

/** The rounding error of one correctly rounded double operation, as a fraction of the result: 2^-53. */
const unitRoundoff = Number.EPSILON / 2;

/** A few units of rounding error over the pair, which is what several operations accumulate; the expected values in these cases are the correctly rounded true quotients of the doubles written. */
const allowedUnitRoundoffs = 8;
const accuracy = allowedUnitRoundoffs * unitRoundoff;

/** The spacing of the subnormal numbers, 2^-1074: the resolution below which a quotient cannot be written any more finely. */
const subnormalSpacing = Number.MIN_VALUE;

/** Whole numbers of spacings used by the cases below, as properties so each is a named quantity rather than a bare literal. */
const spacings = { three: 3, sixBelowZero: -6 };

describe("divideComplexComponents near the largest double", () => {
  it("does not collapse a representable quotient to zero when |divisor| is near the top of the range", () => {
    const quotient = divide({
      dividend: { re: -6.562357840001232e306, im: 1.1562475168118175e307 },
      divisor: { re: -4.145533667044553e307, im: 1.7287855058139144e308 },
    });

    expect(
      normwiseError(quotient, {
        re: 0.07185287237270656,
        im: 0.02072942428658858,
      }),
    ).toBeLessThan(accuracy);
  });

  it("divides a value by itself to exactly one", () => {
    const value = { re: 1e308, im: 1e308 };

    expect(divide({ dividend: value, divisor: value })).toEqual({
      re: 1,
      im: 0,
    });
  });

  it("returns a quotient as large as the dividend when the divisor is about one", () => {
    expect(
      divide({
        dividend: { re: 1.5e308, im: 1.5e308 },
        divisor: { re: 1, im: 1 },
      }),
    ).toEqual({ re: 1.5e308, im: 0 });
  });

  it("returns the reciprocal of a divisor near the top of the range", () => {
    const quotient = divide({
      dividend: { re: 1, im: 0 },
      divisor: { re: 1e308, im: 1e308 },
    });

    expect(normwiseError(quotient, { re: 5e-309, im: -5e-309 })).toBeLessThan(
      accuracy,
    );
  });
});

describe("divideComplexComponents at subnormal scale", () => {
  it("keeps the bits of subnormal operands", () => {
    // (2 - 3i) / (4 - 1i) in units of the smallest subnormal, which is 11/17 - 10/17 i.
    const expected = { re: 0.6470588235294118, im: -0.5882352941176471 };
    const quotient = divide({
      dividend: { re: 1e-323, im: -1.5e-323 },
      divisor: { re: 2e-323, im: -5e-324 },
    });

    expect(normwiseError(quotient, expected)).toBeLessThan(accuracy);
  });

  it("divides a subnormal by itself to exactly one", () => {
    const value = { re: 5e-324, im: 5e-324 };

    expect(divide({ dividend: value, divisor: value })).toEqual({
      re: 1,
      im: 0,
    });
  });

  it("divides by a subnormal divisor to a large quotient", () => {
    const quotient = divide({
      dividend: { re: 1e-300, im: 1e-300 },
      divisor: { re: 5e-324, im: 5e-324 },
    });

    expect(
      normwiseError(quotient, { re: 2.0240225330731062e23, im: 0 }),
    ).toBeLessThan(accuracy);
  });
});

describe("divideComplexComponents when the quotient is subnormal", () => {
  it("does not round a quotient of several spacings to zero when the dividend is far smaller than the divisor", () => {
    // The exact real part is about -5.77 spacings, which rounds to -6; the imaginary part is about -5e-9 of a spacing.
    const expectedRoundedReal = spacings.sixBelowZero * subnormalSpacing;
    const quotient = divide({
      dividend: { re: -7.124494562846174e-209, im: -8.343164103148207e-219 },
      divisor: { re: 2.50063496577604e114, im: -1.8086225038951245e105 },
    });

    expect(quotient.re).not.toBe(0);
    expect(Math.abs(quotient.re - expectedRoundedReal)).toBeLessThanOrEqual(
      subnormalSpacing,
    );
    expect(Math.abs(quotient.im)).toBeLessThanOrEqual(subnormalSpacing);
  });

  it("rounds a quotient of three quarters of a spacing up to one spacing, not to zero", () => {
    const threeSpacings = spacings.three * subnormalSpacing;
    // 3 spacings divided by 4. The scale factor for the result is 2^-1075, which as a double is zero, so the shift has to be applied in parts.
    expect(
      divide({
        dividend: { re: threeSpacings, im: 0 },
        divisor: { re: 4, im: 0 },
      }).re,
    ).toBe(subnormalSpacing);
  });
});

describe("divideComplexComponents when the operands differ enormously in size", () => {
  it("returns zero for a zero dividend however large the divisor", () => {
    expect(
      divide({
        dividend: { re: 0, im: 0 },
        divisor: { re: 1e300, im: -1e300 },
      }),
    ).toEqual({ re: 0, im: 0 });
  });

  it("returns zero when the quotient is below the smallest subnormal", () => {
    expect(
      divide({
        dividend: { re: 1e-300, im: 1e-300 },
        divisor: { re: 1e300, im: 1e300 },
      }),
    ).toEqual({ re: 0, im: 0 });
  });

  it("overflows to infinity when the quotient is too large for a double", () => {
    const quotient = divide({
      dividend: { re: 1e300, im: 0 },
      divisor: { re: 1e-300, im: 0 },
    });

    expect(quotient.re).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the dividend's own scale when the divisor is much larger", () => {
    // 1e-100 / 1e200 is 1e-300, a normal number, reached through a large difference of scales.
    const quotient = divide({
      dividend: { re: 1e-100, im: 0 },
      divisor: { re: 1e200, im: 0 },
    });

    expect(normwiseError(quotient, { re: 1e-300, im: 0 })).toBeLessThan(
      accuracy,
    );
  });
});

describe("divideComplexComponents at ordinary scale", () => {
  it("matches the textbook quotient", () => {
    // (4 + 2i) / (1 + 2i) = 1.6 - 1.2i
    expect(
      normwiseError(
        divide({
          dividend: { re: 4, im: 2 },
          divisor: { re: 1, im: 2 },
        }),
        { re: 1.6, im: -1.2 },
      ),
    ).toBeLessThan(accuracy);
  });

  it("divides by a purely imaginary value", () => {
    expect(
      divide({ dividend: { re: 4, im: 0 }, divisor: { re: 0, im: 2 } }),
    ).toEqual({ re: 0, im: -2 });
  });
});
