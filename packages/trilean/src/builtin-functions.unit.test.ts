import { describe, expect, it } from "vitest";
import { builtinFunctions } from "./builtin-functions";
import type { ComputedValue, Unit } from "./computed-value";
import type { FunctionFailure } from "./functions";

/** Takes one object so a literal is an object-literal property value, which `no-magic-numbers` exempts, rather than a bare call argument. */
function num({ value, unit }: { value: number; unit?: Unit }): ComputedValue {
  return unit === undefined
    ? { kind: "number", value }
    : { kind: "number", value, unit };
}

function call(
  name: string,
  ...args: readonly ComputedValue[]
): ComputedValue | FunctionFailure {
  const fn = builtinFunctions[name];
  if (fn === undefined) throw new Error(`no built-in function ${name}`);

  return fn(args);
}

function domainError(
  result: ComputedValue | FunctionFailure,
): string | undefined {
  return "domainError" in result ? result.domainError : undefined;
}

function wrongType(
  result: ComputedValue | FunctionFailure,
): string | undefined {
  return "wrongType" in result ? result.wrongType : undefined;
}

const metres: Unit = { m: 1 };
const text: ComputedValue = { kind: "text", value: "a" };
const complex: ComputedValue = { kind: "complex", re: 1, im: 1 };

describe("the registry itself", () => {
  it("is frozen, so changing the export cannot change what evaluation resolves", () => {
    expect(Object.isFrozen(builtinFunctions)).toBe(true);
    expect(() => {
      builtinFunctions.minimum = () => ({ wrongType: "replaced" });
    }).toThrow(TypeError);
  });
});

describe("minimum and maximum", () => {
  it("pick the smallest and largest argument, keeping its unit", () => {
    const three = num({ value: 3, unit: metres });
    const one = num({ value: 1, unit: metres });
    const two = num({ value: 2, unit: metres });

    expect(call("minimum", three, one, two)).toEqual(one);
    expect(call("maximum", three, one, two)).toEqual(three);
  });

  it("accept a single argument", () => {
    expect(call("minimum", num({ value: 4 }))).toEqual(num({ value: 4 }));
  });

  it("refuse mixed units as wrong-type rather than converting", () => {
    expect(
      wrongType(
        call(
          "maximum",
          num({ value: 1, unit: metres }),
          num({ value: 1, unit: { s: 1 } }),
        ),
      ),
    ).toMatch(/same unit/);
    expect(
      wrongType(
        call("minimum", num({ value: 1, unit: metres }), num({ value: 2 })),
      ),
    ).toMatch(/same unit/);
  });

  it("refuse no arguments and non-numbers as wrong-type", () => {
    expect(wrongType(call("minimum"))).toMatch(/at least one/);
    expect(wrongType(call("minimum", num({ value: 1 }), text))).toMatch(
      /number arguments only/,
    );
  });
});

describe("absoluteValue", () => {
  it("drops the sign and keeps the unit", () => {
    expect(call("absoluteValue", num({ value: -2.5, unit: { A: 1 } }))).toEqual(
      num({ value: 2.5, unit: { A: 1 } }),
    );
  });

  it("refuses a surplus argument, a non-number and a complex value as wrong-type", () => {
    expect(
      wrongType(call("absoluteValue", num({ value: 1 }), num({ value: 2 }))),
    ).toMatch(/exactly one/);
    expect(wrongType(call("absoluteValue", text))).toMatch(/exactly one/);
    expect(wrongType(call("absoluteValue", complex))).toMatch(/exactly one/);
  });
});

describe("round", () => {
  it("rounds to a whole number with halves away from zero", () => {
    expect(call("round", num({ value: 2.5 }))).toEqual(num({ value: 3 }));
    expect(call("round", num({ value: -2.5 }))).toEqual(num({ value: -3 }));
    expect(call("round", num({ value: 2.4 }))).toEqual(num({ value: 2 }));
  });

  it("rounds to a count of decimal places and keeps the unit", () => {
    expect(
      call("round", num({ value: 1.2345, unit: metres }), num({ value: 2 })),
    ).toEqual(num({ value: 1.23, unit: metres }));
  });

  it("rounds the decimal number written, not its binary approximation", () => {
    expect(call("round", num({ value: 1.005 }), num({ value: 2 }))).toEqual(
      num({ value: 1.01 }),
    );
    expect(call("round", num({ value: -1.005 }), num({ value: 2 }))).toEqual(
      num({ value: -1.01 }),
    );
    expect(call("round", num({ value: 8.345 }), num({ value: 2 }))).toEqual(
      num({ value: 8.35 }),
    );
  });

  it("rounds to a negative count of places", () => {
    expect(call("round", num({ value: 1250 }), num({ value: -2 }))).toEqual(
      num({ value: 1300 }),
    );
  });

  it("handles values written in exponent notation", () => {
    expect(call("round", num({ value: 1.5e-7 }), num({ value: 7 }))).toEqual(
      num({ value: 2e-7 }),
    );
    expect(call("round", num({ value: 1.5e21 }))).toEqual(
      num({ value: 1.5e21 }),
    );
  });

  it("returns a value unchanged when it has no digits at that precision", () => {
    expect(call("round", num({ value: 1.5 }), num({ value: 400 }))).toEqual(
      num({ value: 1.5 }),
    );
    expect(call("round", num({ value: 1e300 }), num({ value: 10 }))).toEqual(
      num({ value: 1e300 }),
    );
    expect(
      call(
        "round",
        num({ value: 1.5 }),
        num({ value: Number.MAX_SAFE_INTEGER }),
      ),
    ).toEqual(num({ value: 1.5 }));
  });

  it("rounds to zero when the places are far below the value", () => {
    expect(call("round", num({ value: 1.5 }), num({ value: -400 }))).toEqual(
      num({ value: 0 }),
    );
    expect(
      call(
        "round",
        num({ value: 1.5 }),
        num({ value: -Number.MAX_SAFE_INTEGER }),
      ),
    ).toEqual(num({ value: 0 }));
  });

  it("never returns a negative zero", () => {
    const result = call("round", num({ value: -0.4 }));

    expect(result).toEqual(num({ value: 0 }));
    expect(Object.is("value" in result ? result.value : undefined, 0)).toBe(
      true,
    );
  });

  it("refuses decimal places with a unit as wrong-type and a fraction as a domain-error", () => {
    expect(
      wrongType(
        call("round", num({ value: 1 }), num({ value: 1, unit: metres })),
      ),
    ).toMatch(/dimensionless/);
    expect(
      domainError(call("round", num({ value: 1 }), num({ value: 1.5 }))),
    ).toMatch(/integer/);
  });

  it("refuses a missing value, a non-number and surplus arguments as wrong-type", () => {
    expect(wrongType(call("round"))).toMatch(/optional count/);
    expect(wrongType(call("round", text))).toMatch(/optional count/);
    expect(
      wrongType(
        call("round", num({ value: 1 }), num({ value: 1 }), num({ value: 1 })),
      ),
    ).toMatch(/optional count/);
  });
});

describe("squareRoot", () => {
  it("halves each unit exponent", () => {
    expect(
      call("squareRoot", num({ value: 9, unit: { m: 2, s: -4 } })),
    ).toEqual(num({ value: 3, unit: { m: 1, s: -2 } }));
  });

  it("returns a unit-less number for a unit-less one", () => {
    expect(call("squareRoot", num({ value: 16 }))).toEqual(num({ value: 4 }));
  });

  it("ignores zero exponents", () => {
    expect(call("squareRoot", num({ value: 4, unit: { m: 0 } }))).toEqual(
      num({ value: 2, unit: {} }),
    );
  });

  it("refuses a negative number as a domain-error", () => {
    expect(domainError(call("squareRoot", num({ value: -1 })))).toMatch(
      /negative/,
    );
  });

  it("refuses an odd unit exponent and a non-number as wrong-type", () => {
    expect(
      wrongType(call("squareRoot", num({ value: 4, unit: metres }))),
    ).toMatch(/even/);
    expect(wrongType(call("squareRoot", text))).toMatch(/exactly one/);
  });
});

describe("exponential", () => {
  it("is e to the power of a dimensionless number", () => {
    expect(call("exponential", num({ value: 0 }))).toEqual(num({ value: 1 }));
    expect(call("exponential", num({ value: 1 }))).toEqual(
      num({ value: Math.E }),
    );
  });

  it("refuses a unit as wrong-type and an overflow as a domain-error", () => {
    expect(
      wrongType(call("exponential", num({ value: 1, unit: metres }))),
    ).toMatch(/dimensionless/);
    expect(domainError(call("exponential", num({ value: 1000 })))).toMatch(
      /not a finite number/,
    );
  });
});

describe("logarithm", () => {
  it("is natural by default and to a base when given one", () => {
    expect(call("logarithm", num({ value: Math.E }))).toEqual(
      num({ value: 1 }),
    );
    const operand = 27;
    const base = 3;
    expect(
      call("logarithm", num({ value: operand }), num({ value: base })),
    ).toEqual(num({ value: Math.log(operand) / Math.log(base) }));
  });

  it("is exact for powers of the bases 10 and 2", () => {
    expect(call("logarithm", num({ value: 1000 }), num({ value: 10 }))).toEqual(
      num({ value: 3 }),
    );
    expect(call("logarithm", num({ value: 8 }), num({ value: 2 }))).toEqual(
      num({ value: 3 }),
    );
  });

  it("refuses zero and negatives as a domain-error and a unit as wrong-type", () => {
    expect(domainError(call("logarithm", num({ value: 0 })))).toMatch(
      /above zero/,
    );
    expect(domainError(call("logarithm", num({ value: -1 })))).toMatch(
      /above zero/,
    );
    expect(
      wrongType(call("logarithm", num({ value: 2, unit: metres }))),
    ).toMatch(/dimensionless/);
  });

  it("refuses a base of one or below zero as a domain-error and a base with a unit as wrong-type", () => {
    expect(
      domainError(call("logarithm", num({ value: 2 }), num({ value: 1 }))),
    ).toMatch(/base/);
    expect(
      domainError(call("logarithm", num({ value: 2 }), num({ value: -2 }))),
    ).toMatch(/base/);
    expect(
      wrongType(
        call("logarithm", num({ value: 2 }), num({ value: 2, unit: metres })),
      ),
    ).toMatch(/base/);
  });

  it("refuses a missing value, a non-number and surplus arguments as wrong-type", () => {
    expect(wrongType(call("logarithm"))).toMatch(/optional base/);
    expect(wrongType(call("logarithm", text))).toMatch(/optional base/);
    expect(
      wrongType(
        call(
          "logarithm",
          num({ value: 2 }),
          num({ value: 2 }),
          num({ value: 2 }),
        ),
      ),
    ).toMatch(/optional base/);
  });
});

describe("a result that is not a finite number", () => {
  const infinite = num({ value: Number.POSITIVE_INFINITY });

  it.each(["minimum", "maximum", "absoluteValue", "round", "magnitude"])(
    "is a domain-error from %s even when the argument already was one",
    (name) => {
      expect(domainError(call(name, infinite))).toMatch(/not a finite number/);
    },
  );
});

describe("magnitude", () => {
  it("is the absolute value of a real number, in its unit", () => {
    expect(call("magnitude", num({ value: -2.5, unit: { A: 1 } }))).toEqual(
      num({ value: 2.5, unit: { A: 1 } }),
    );
  });

  it("is the modulus of a complex number, in the unit it carries", () => {
    expect(
      call("magnitude", {
        kind: "complex",
        re: 3,
        im: -4,
        unit: { V: 1 },
      }),
    ).toEqual(num({ value: 5, unit: { V: 1 } }));
  });

  it("is a domain-error where the modulus leaves the finite range", () => {
    expect(
      domainError(
        call("magnitude", {
          kind: "complex",
          re: Number.MAX_VALUE,
          im: Number.MAX_VALUE,
        }),
      ),
    ).toMatch(/not a finite number/);
  });

  it("is a wrong-type for anything else or for a wrong count", () => {
    expect(wrongType(call("magnitude", text))).toMatch(
      /number or a complex number/,
    );
    expect(wrongType(call("magnitude"))).toMatch(/exactly one/);
    expect(
      wrongType(call("magnitude", num({ value: 1 }), num({ value: 2 }))),
    ).toMatch(/exactly one/);
  });
});

describe("phase", () => {
  it("is the angle of a complex number in radians, dimensionless whatever its unit", () => {
    expect(
      call("phase", { kind: "complex", re: 0, im: 2, unit: { ohm: 1 } }),
    ).toEqual(num({ value: Math.PI / 2 }));
    expect(call("phase", { kind: "complex", re: -1, im: 0 })).toEqual(
      num({ value: Math.PI }),
    );
  });

  it("is +pi for a negative real number whatever the sign of its zero imaginary part", () => {
    expect(call("phase", { kind: "complex", re: -2, im: 0 })).toEqual(
      num({ value: Math.PI }),
    );
    expect(call("phase", { kind: "complex", re: -2, im: -0 })).toEqual(
      num({ value: Math.PI }),
    );
  });

  it("rounds to exactly -pi for a tiny negative imaginary part, so the range is closed", () => {
    for (const { im } of [{ im: -5e-324 }, { im: -1e-17 }]) {
      expect(call("phase", { kind: "complex", re: -1, im })).toEqual(
        num({ value: -Math.PI }),
      );
    }
  });

  it("is zero for a zero of either sign, and for a positive real number whatever the zero's sign", () => {
    for (const re of [0, -0]) {
      for (const im of [0, -0]) {
        const result = call("phase", { kind: "complex", re, im });
        const value = "value" in result ? result.value : undefined;

        expect(Object.is(value, 0)).toBe(true);
      }
    }
    expect(call("phase", { kind: "complex", re: 2, im: -0 })).toEqual(
      num({ value: 0 }),
    );
  });

  it("is a domain-error when a component is not finite, as the other built-ins are for a result that is not", () => {
    for (const component of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        domainError(call("phase", { kind: "complex", re: component, im: 1 })),
      ).toMatch(/finite/);
      expect(
        domainError(call("phase", { kind: "complex", re: 1, im: component })),
      ).toMatch(/finite/);
    }
  });

  it("is a wrong-type for a real number, text or a wrong count", () => {
    expect(wrongType(call("phase", num({ value: 1 })))).toMatch(/complex/);
    expect(wrongType(call("phase", text))).toMatch(/complex/);
    expect(wrongType(call("phase"))).toMatch(/exactly one/);
  });
});

/** Takes one object, as `num` does, so the components are object-literal property values. */
function cx({
  re,
  im,
  unit,
}: {
  re: number;
  im: number;
  unit?: Unit;
}): ComputedValue {
  return unit === undefined
    ? { kind: "complex", re, im }
    : { kind: "complex", re, im, unit };
}

/** Asserts a complex result lies within `tolerance` of `expected` in each component; `tolerance` is the caller's bound for the function at that point, never a fixed constant. */
function expectComplexNear(
  result: ComputedValue | FunctionFailure,
  expected: Readonly<{ re: number; im: number }>,
  tolerance: number,
): void {
  if (!("kind" in result) || result.kind !== "complex") {
    throw new Error(`expected a complex result, got ${JSON.stringify(result)}`);
  }
  expect(Math.abs(result.re - expected.re)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(result.im - expected.im)).toBeLessThanOrEqual(tolerance);
}

/** One rounding of a value of magnitude one: the most a correctly rounded `Math.cos` or `Math.sin` of a double near a multiple of pi/2 can sit from the exact value at the real multiple. */
const UNIT_ROUNDING = Number.EPSILON;

const QUARTER_TURN = Math.PI / 2;
const EIGHTH_TURN = QUARTER_TURN / 2;
const THREE_EIGHTHS_TURN = QUARTER_TURN + EIGHTH_TURN;

describe("squareRoot of a complex number", () => {
  it("is exact where the principal root is representable", () => {
    expect(call("squareRoot", cx({ re: -4, im: 0 }))).toEqual(
      cx({ re: 0, im: 2 }),
    );
    expect(call("squareRoot", cx({ re: 3, im: 4 }))).toEqual(
      cx({ re: 2, im: 1 }),
    );
    expect(call("squareRoot", cx({ re: 3, im: -4 }))).toEqual(
      cx({ re: 2, im: -1 }),
    );
    expect(call("squareRoot", cx({ re: -3, im: 4 }))).toEqual(
      cx({ re: 1, im: 2 }),
    );
    expect(call("squareRoot", cx({ re: -3, im: -4 }))).toEqual(
      cx({ re: 1, im: -2 }),
    );
  });

  it("puts the root of a negative real number on the positive imaginary axis whatever the sign of its zero", () => {
    expect(call("squareRoot", cx({ re: -4, im: -0 }))).toEqual(
      cx({ re: 0, im: 2 }),
    );
  });

  it("stays complex when the imaginary part comes out zero, and is zero at zero", () => {
    expect(call("squareRoot", cx({ re: 4, im: 0 }))).toEqual(
      cx({ re: 2, im: 0 }),
    );
    expect(call("squareRoot", cx({ re: 0, im: 0 }))).toEqual(
      cx({ re: 0, im: 0 }),
    );
  });

  it("squares back to its argument with a real part that is not negative, in every quadrant", () => {
    for (const z of [
      { re: 0.3, im: 1.7 },
      { re: -2.5, im: 0.1 },
      { re: -1e-9, im: -6 },
      { re: 7, im: -1e-12 },
    ]) {
      const root = call("squareRoot", cx(z));
      if (!("kind" in root) || root.kind !== "complex") {
        throw new Error("expected a complex root");
      }
      const modulus = Math.hypot(z.re, z.im);

      expect(root.re).toBeGreaterThanOrEqual(0);
      // Squaring the root costs a few roundings of a value of the argument's size on top of the root's own.
      const roundings = 4;
      const tolerance = roundings * Number.EPSILON * modulus;
      expect(
        Math.abs(root.re * root.re - root.im * root.im - z.re),
      ).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(2 * root.re * root.im - z.im)).toBeLessThanOrEqual(
        tolerance,
      );
    }
  });

  it("halves each unit exponent of a complex value and refuses an odd one as wrong-type", () => {
    expect(call("squareRoot", cx({ re: -4, im: 0, unit: { ohm: 2 } }))).toEqual(
      cx({ re: 0, im: 2, unit: { ohm: 1 } }),
    );
    expect(
      wrongType(call("squareRoot", cx({ re: -4, im: 0, unit: metres }))),
    ).toMatch(/even/);
  });

  it("keeps a root whose argument's terms sum past the largest double", () => {
    expect(call("squareRoot", cx({ re: Number.MAX_VALUE, im: 0 }))).toEqual(
      cx({ re: Math.sqrt(Number.MAX_VALUE), im: 0 }),
    );
  });

  it("keeps the root of the smallest subnormal, whose half would round to zero", () => {
    expect(call("squareRoot", cx({ re: Number.MIN_VALUE, im: 0 }))).toEqual(
      cx({ re: Math.sqrt(Number.MIN_VALUE), im: 0 }),
    );
  });

  it("is a domain-error when the modulus leaves the finite range", () => {
    expect(
      domainError(
        call("squareRoot", cx({ re: Number.MAX_VALUE, im: Number.MAX_VALUE })),
      ),
    ).toMatch(/not a finite number/);
  });
});

describe("exponential of a complex number", () => {
  it("is one at zero, and stays complex", () => {
    expect(call("exponential", cx({ re: 0, im: 0 }))).toEqual(
      cx({ re: 1, im: 0 }),
    );
  });

  it("is -1 at i pi, and e i at 1 + i pi/2, within one rounding of the unit circle", () => {
    expectComplexNear(
      call("exponential", cx({ re: 0, im: Math.PI })),
      { re: -1, im: 0 },
      UNIT_ROUNDING,
    );
    expectComplexNear(
      call("exponential", cx({ re: 1, im: Math.PI / 2 })),
      { re: 0, im: Math.E },
      Math.E * UNIT_ROUNDING,
    );
  });

  it("refuses a complex value with a unit as wrong-type and an overflow as a domain-error", () => {
    expect(
      wrongType(call("exponential", cx({ re: 0, im: 1, unit: metres }))),
    ).toMatch(/dimensionless/);
    expect(domainError(call("exponential", cx({ re: 1000, im: 0 })))).toMatch(
      /not a finite number/,
    );
  });

  it("refuses a non-number and a wrong count as wrong-type", () => {
    expect(wrongType(call("exponential", text))).toMatch(/exactly one/);
    expect(wrongType(call("exponential"))).toMatch(/exactly one/);
  });
});

describe("logarithm of a complex number", () => {
  it("is the principal value, i pi/2 at i and i pi at -1, whatever the sign of -1's zero", () => {
    expect(call("logarithm", cx({ re: 0, im: 1 }))).toEqual(
      cx({ re: 0, im: Math.PI / 2 }),
    );
    expect(call("logarithm", cx({ re: -1, im: 0 }))).toEqual(
      cx({ re: 0, im: Math.PI }),
    );
    expect(call("logarithm", cx({ re: -1, im: -0 }))).toEqual(
      cx({ re: 0, im: Math.PI }),
    );
  });

  it("stays complex at a positive real number", () => {
    expect(call("logarithm", cx({ re: 1, im: 0 }))).toEqual(
      cx({ re: 0, im: 0 }),
    );
  });

  it("is ln|z| + i arg(z) in general", () => {
    const z = { re: 3, im: 4 };
    const modulus = 5;
    expectComplexNear(
      call("logarithm", cx(z)),
      { re: Math.log(modulus), im: Math.atan2(z.im, z.re) },
      // One rounding of each component, the larger of which is the logarithm of the modulus.
      Math.log(modulus) * Number.EPSILON,
    );
  });

  it("divides through by the base's natural logarithm, exact in the real part for a power of ten", () => {
    const result = call(
      "logarithm",
      cx({ re: 0, im: 100 }),
      num({ value: 10 }),
    );

    expectComplexNear(
      result,
      { re: 2, im: Math.PI / 2 / Math.LN10 },
      Number.EPSILON,
    );
    expect("re" in result ? result.re : undefined).toBe(2);
  });

  it("refuses a complex zero and a base of one as a domain-error", () => {
    expect(domainError(call("logarithm", cx({ re: 0, im: 0 })))).toMatch(
      /other than zero/,
    );
    expect(
      domainError(call("logarithm", cx({ re: 0, im: 1 }), num({ value: 1 }))),
    ).toMatch(/base/);
  });

  it("refuses a unit, a complex base and a surplus argument as wrong-type", () => {
    expect(
      wrongType(call("logarithm", cx({ re: 1, im: 1, unit: metres }))),
    ).toMatch(/dimensionless/);
    expect(
      wrongType(call("logarithm", cx({ re: 1, im: 1 }), cx({ re: 2, im: 0 }))),
    ).toMatch(/base/);
    expect(
      wrongType(
        call("logarithm", complex, num({ value: 2 }), num({ value: 2 })),
      ),
    ).toMatch(/optional base/);
  });
});

describe("sine, cosine and tangent", () => {
  it("take an angle in radians", () => {
    expect(call("sine", num({ value: 0 }))).toEqual(num({ value: 0 }));
    expect(call("sine", num({ value: Math.PI / 2 }))).toEqual(
      num({ value: 1 }),
    );
    expect(call("cosine", num({ value: 0 }))).toEqual(num({ value: 1 }));
    expect(call("cosine", num({ value: Math.PI }))).toEqual(num({ value: -1 }));
    const tangent = call("tangent", num({ value: EIGHTH_TURN }));
    expect(
      Math.abs(("value" in tangent ? Number(tangent.value) : 0) - 1),
    ).toBeLessThanOrEqual(UNIT_ROUNDING);
  });

  it("give a large but finite tangent at the double nearest a pole", () => {
    const result = call("tangent", num({ value: Math.PI / 2 }));

    expect(result).toMatchObject({ kind: "number" });
    expect(
      Number.isFinite("value" in result ? Number(result.value) : Number.NaN),
    ).toBe(true);
  });

  it.each(["sine", "cosine", "tangent", "arcTangent"])(
    "%s refuses a unit, a complex value, text and a wrong count as wrong-type",
    (name) => {
      expect(wrongType(call(name, num({ value: 1, unit: metres })))).toMatch(
        /dimensionless/,
      );
      expect(wrongType(call(name, complex))).toMatch(/exactly one/);
      expect(wrongType(call(name, text))).toMatch(/exactly one/);
      expect(wrongType(call(name))).toMatch(/exactly one/);
      expect(
        wrongType(call(name, num({ value: 1 }), num({ value: 1 }))),
      ).toMatch(/exactly one/);
    },
  );

  it.each(["sine", "cosine", "tangent"])(
    "%s is a domain-error for an angle that is not finite",
    (name) => {
      expect(
        domainError(call(name, num({ value: Number.POSITIVE_INFINITY }))),
      ).toMatch(/not a finite number/);
    },
  );
});

describe("arcSine, arcCosine and arcTangent", () => {
  it("return an angle in radians", () => {
    expect(call("arcSine", num({ value: 1 }))).toEqual(
      num({ value: Math.PI / 2 }),
    );
    expect(call("arcSine", num({ value: -1 }))).toEqual(
      num({ value: -Math.PI / 2 }),
    );
    expect(call("arcCosine", num({ value: -1 }))).toEqual(
      num({ value: Math.PI }),
    );
    expect(call("arcCosine", num({ value: 1 }))).toEqual(num({ value: 0 }));
    expect(call("arcTangent", num({ value: 1 }))).toEqual(
      num({ value: EIGHTH_TURN }),
    );
  });

  it.each(["arcSine", "arcCosine"])(
    "%s refuses a number outside -1 to 1 as a domain-error",
    (name) => {
      for (const outside of [
        { value: 1.5 },
        { value: -1.5 },
        { value: Number.POSITIVE_INFINITY },
      ]) {
        expect(domainError(call(name, num(outside)))).toMatch(/-1 to 1/);
      }
    },
  );

  it.each(["arcSine", "arcCosine"])(
    "%s refuses a unit, a complex value and a wrong count as wrong-type",
    (name) => {
      expect(wrongType(call(name, num({ value: 0.5, unit: metres })))).toMatch(
        /dimensionless/,
      );
      expect(wrongType(call(name, complex))).toMatch(/exactly one/);
      expect(wrongType(call(name))).toMatch(/exactly one/);
    },
  );
});

describe("arcTangent2", () => {
  it("is the angle of the point (x, y), called with y first", () => {
    expect(call("arcTangent2", num({ value: 1 }), num({ value: 1 }))).toEqual(
      num({ value: EIGHTH_TURN }),
    );
    expect(call("arcTangent2", num({ value: 1 }), num({ value: -1 }))).toEqual(
      num({ value: THREE_EIGHTHS_TURN }),
    );
    expect(call("arcTangent2", num({ value: -1 }), num({ value: 0 }))).toEqual(
      num({ value: -Math.PI / 2 }),
    );
  });

  it("shares phase's signed-zero handling: +pi on the negative x axis, zero at the origin", () => {
    for (const y of [0, -0]) {
      expect(
        call("arcTangent2", num({ value: y }), num({ value: -1 })),
      ).toEqual(num({ value: Math.PI }));
      const origin = call("arcTangent2", num({ value: y }), num({ value: -0 }));
      expect(Object.is("value" in origin ? origin.value : undefined, 0)).toBe(
        true,
      );
    }
  });

  it("refuses a unit, a complex value and a wrong count as wrong-type", () => {
    expect(
      wrongType(
        call(
          "arcTangent2",
          num({ value: 1, unit: metres }),
          num({ value: 1, unit: metres }),
        ),
      ),
    ).toMatch(/dimensionless/);
    expect(wrongType(call("arcTangent2", complex, num({ value: 1 })))).toMatch(
      /exactly two/,
    );
    expect(wrongType(call("arcTangent2", num({ value: 1 })))).toMatch(
      /exactly two/,
    );
    expect(
      wrongType(
        call(
          "arcTangent2",
          num({ value: 1 }),
          num({ value: 1 }),
          num({ value: 1 }),
        ),
      ),
    ).toMatch(/exactly two/);
  });

  it("is a domain-error for an argument that is not finite", () => {
    expect(
      domainError(
        call(
          "arcTangent2",
          num({ value: Number.POSITIVE_INFINITY }),
          num({ value: 1 }),
        ),
      ),
    ).toMatch(/finite/);
    expect(
      domainError(
        call("arcTangent2", num({ value: 1 }), num({ value: Number.NaN })),
      ),
    ).toMatch(/finite/);
  });
});
