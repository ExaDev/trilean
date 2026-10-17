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

/** Correctly rounded values computed with exact rational arithmetic, so each is the true quotient of the two doubles written in the case. */
const accuracy = 1e-15;

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
