import { describe, expect, it } from "vitest";
import { builtinFunctions } from "./builtin-functions";
import type { ComputedValue, Unit } from "./computed-value";

/** Takes one object so a literal is an object-literal property value, which `no-magic-numbers` exempts, rather than a bare call argument. */
function num({ value, unit }: { value: number; unit?: Unit }): ComputedValue {
  return unit === undefined
    ? { kind: "number", value }
    : { kind: "number", value, unit };
}

function call(
  name: string,
  ...args: readonly ComputedValue[]
): ComputedValue | { domainError: string } {
  const fn = builtinFunctions[name];
  if (fn === undefined) throw new Error(`no built-in function ${name}`);

  return fn(args);
}

function domainError(
  result: ComputedValue | { domainError: string },
): string | undefined {
  return "domainError" in result ? result.domainError : undefined;
}

describe("minimum and maximum", () => {
  it("pick the smallest and largest argument, keeping its unit", () => {
    const metres = { m: 1 };
    expect(
      call(
        "minimum",
        num({ value: 3, unit: metres }),
        num({ value: 1, unit: metres }),
        num({ value: 2, unit: metres }),
      ),
    ).toEqual(num({ value: 1, unit: metres }));
    expect(
      call(
        "maximum",
        num({ value: 3, unit: metres }),
        num({ value: 1, unit: metres }),
        num({ value: 2, unit: metres }),
      ),
    ).toEqual(num({ value: 3, unit: metres }));
  });

  it("accept a single argument", () => {
    expect(call("minimum", num({ value: 4 }))).toEqual(num({ value: 4 }));
  });

  it("refuse mixed units rather than converting", () => {
    expect(
      domainError(
        call(
          "maximum",
          num({ value: 1, unit: { m: 1 } }),
          num({ value: 1, unit: { s: 1 } }),
        ),
      ),
    ).toMatch(/same unit/);
  });

  it("refuse no arguments and non-numbers", () => {
    expect(domainError(call("minimum"))).toMatch(/at least one/);
    expect(
      domainError(
        call("minimum", num({ value: 1 }), { kind: "text", value: "a" }),
      ),
    ).toMatch(/number arguments only/);
  });
});

describe("absoluteValue", () => {
  it("drops the sign and keeps the unit", () => {
    expect(call("absoluteValue", num({ value: -2.5, unit: { A: 1 } }))).toEqual(
      num({ value: 2.5, unit: { A: 1 } }),
    );
  });

  it("requires exactly one number", () => {
    expect(
      domainError(call("absoluteValue", num({ value: 1 }), num({ value: 2 }))),
    ).toMatch(/exactly one/);
    expect(
      domainError(call("absoluteValue", { kind: "boolean", value: true })),
    ).toMatch(/exactly one/);
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
      call("round", num({ value: 1.2345, unit: { m: 1 } }), num({ value: 2 })),
    ).toEqual(num({ value: 1.23, unit: { m: 1 } }));
  });

  it("refuses decimal places that are not a dimensionless integer", () => {
    expect(
      domainError(call("round", num({ value: 1 }), num({ value: 1.5 }))),
    ).toMatch(/dimensionless integer/);
    expect(
      domainError(
        call("round", num({ value: 1 }), num({ value: 1, unit: { m: 1 } })),
      ),
    ).toMatch(/dimensionless integer/);
  });

  it("refuses a result that is not finite", () => {
    expect(
      domainError(call("round", num({ value: 1 }), num({ value: 400 }))),
    ).toMatch(/not a finite number/);
  });

  it("refuses a missing value and surplus arguments", () => {
    expect(domainError(call("round"))).toMatch(/optional count/);
    expect(
      domainError(
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

  it("refuses a negative number", () => {
    expect(domainError(call("squareRoot", num({ value: -1 })))).toMatch(
      /negative/,
    );
  });

  it("refuses an odd unit exponent", () => {
    expect(
      domainError(call("squareRoot", num({ value: 4, unit: { m: 1 } }))),
    ).toMatch(/even/);
  });
});

describe("exponential", () => {
  it("is e to the power of a dimensionless number", () => {
    expect(call("exponential", num({ value: 0 }))).toEqual(num({ value: 1 }));
    expect(call("exponential", num({ value: 1 }))).toEqual(
      num({ value: Math.E }),
    );
  });

  it("refuses a unit and an overflow", () => {
    expect(
      domainError(call("exponential", num({ value: 1, unit: { m: 1 } }))),
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
    expect(call("logarithm", num({ value: 8 }), num({ value: 2 }))).toEqual(
      num({ value: 3 }),
    );
  });

  it("refuses zero, negatives and a unit", () => {
    expect(domainError(call("logarithm", num({ value: 0 })))).toMatch(
      /above zero/,
    );
    expect(domainError(call("logarithm", num({ value: -1 })))).toMatch(
      /above zero/,
    );
    expect(
      domainError(call("logarithm", num({ value: 2, unit: { m: 1 } }))),
    ).toMatch(/dimensionless/);
  });

  it("refuses a base of one, below zero or with a unit", () => {
    expect(
      domainError(call("logarithm", num({ value: 2 }), num({ value: 1 }))),
    ).toMatch(/base/);
    expect(
      domainError(call("logarithm", num({ value: 2 }), num({ value: -2 }))),
    ).toMatch(/base/);
    expect(
      domainError(
        call("logarithm", num({ value: 2 }), num({ value: 2, unit: { m: 1 } })),
      ),
    ).toMatch(/base/);
  });

  it("refuses a missing value and surplus arguments", () => {
    expect(domainError(call("logarithm"))).toMatch(/optional base/);
    expect(
      domainError(
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
