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
