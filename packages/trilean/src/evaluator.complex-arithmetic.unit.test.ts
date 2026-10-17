import { describe, expect, it } from "vitest";
import { evaluateValue } from "./evaluator-factory";
import {
  expectDefinite,
  expectIndeterminate,
  resolvers,
} from "./evaluator-test-helpers";

describe("arithmetic on complex values", () => {
  it("add combines component-wise, preserving the shared unit", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "complexLiteral", re: 3, im: 4, unit: { V: 1 } },
        right: { kind: "complexLiteral", re: 1, im: -6, unit: { V: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "complex",
      re: 4,
      im: -2,
      unit: { V: 1 },
    });
  });

  it("subtract combines component-wise", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "subtract",
        left: { kind: "complexLiteral", re: 3, im: 4 },
        right: { kind: "complexLiteral", re: 1, im: -6 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: 2, im: 10 });
  });

  it("add is wrong-type on mismatched units, exactly as it is for real numbers", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "complexLiteral", re: 3, im: 4, unit: { V: 1 } },
        right: { kind: "complexLiteral", re: 1, im: -6, unit: { A: 1 } },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("subtract is wrong-type on mismatched units", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "subtract",
        left: { kind: "complexLiteral", re: 3, im: 4, unit: { V: 1 } },
        right: { kind: "complexLiteral", re: 1, im: -6 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("multiply is real complex multiplication, not component-wise, and combines units dimensionally", async () => {
    // (3 + 4i)(1 - 2i) = (3 + 8) + (4 - 6)i = 11 - 2i -- a component-wise product would have given 3 - 8i instead.
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "multiply",
        left: { kind: "complexLiteral", re: 3, im: 4, unit: { A: 1 } },
        right: { kind: "complexLiteral", re: 1, im: -2, unit: { V: 1, A: -1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "complex",
      re: 11,
      im: -2,
      unit: { V: 1 },
    });
  });

  it("divide is real complex division, and combines units dimensionally", async () => {
    // (11 - 2i) / (1 - 2i) = ((11 + 4) + (-2 + 22)i) / 5 = 3 + 4i -- the exact inverse of the multiply above, chosen so the expected components are exactly representable.
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "divide",
        left: { kind: "complexLiteral", re: 11, im: -2, unit: { V: 1 } },
        right: { kind: "complexLiteral", re: 1, im: -2, unit: { V: 1, A: -1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: 3, im: 4, unit: { A: 1 } });
  });

  it("divide by complex zero is domain-error, the same category as real division by zero", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "divide",
        left: { kind: "complexLiteral", re: 3, im: 4 },
        right: { kind: "complexLiteral", re: 0, im: 0 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });

  it("divide by a purely imaginary value is an ordinary quotient, not a division by zero", async () => {
    // A zero real part alone must not be mistaken for a zero divisor: (4 + 0i) / (0 + 2i) = -2i.
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "divide",
        left: { kind: "complexLiteral", re: 4, im: 0 },
        right: { kind: "complexLiteral", re: 0, im: 2 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: 0, im: -2, unit: {} });
  });

  describe("divide at extreme magnitudes", () => {
    const huge = 1e200;
    const tiny = 1e-200;
    const quotientRe = 1.6;
    const quotientIm = -1.2;
    const precisionDigits = 12;

    async function divide(
      left: Readonly<{ re: number; im: number }>,
      right: Readonly<{ re: number; im: number }>,
    ) {
      return evaluateValue(
        {
          kind: "arithmetic",
          op: "divide",
          left: { kind: "complexLiteral", ...left },
          right: { kind: "complexLiteral", ...right },
        },
        undefined,
        resolvers,
      );
    }

    it("divides a large value by itself to exactly one, where |divisor|^2 would overflow", async () => {
      expectDefinite(
        await divide({ re: huge, im: huge }, { re: huge, im: huge }),
        { kind: "complex", re: 1, im: 0, unit: {} },
      );
    });

    it("divides by a tiny value without mistaking it for zero, where |divisor|^2 would underflow", async () => {
      expectDefinite(await divide({ re: 1, im: 1 }, { re: tiny, im: tiny }), {
        kind: "complex",
        re: huge,
        im: 0,
        unit: {},
      });
    });

    it("divides whichever component of the divisor is larger", async () => {
      // (4 + 2i) / (1 + 2i) = ((4 + 4) + (2 - 8)i) / 5 = 1.6 - 1.2i; the imaginary part leads, so the other branch of the algorithm runs.
      const result = await divide({ re: 4, im: 2 }, { re: 1, im: 2 });

      expect(result).toMatchObject({ status: "definite" });
      const value = result.status === "definite" ? result.value : undefined;
      expect(value).toMatchObject({ kind: "complex" });
      if (value?.kind === "complex") {
        expect(value.re).toBeCloseTo(quotientRe, precisionDigits);
        expect(value.im).toBeCloseTo(quotientIm, precisionDigits);
      }
    });

    it("still reports an exactly zero divisor as a division by zero", async () => {
      const result = await divide({ re: 1, im: 1 }, { re: 0, im: 0 });

      expectIndeterminate(result, "domain-error");
      expect(result).toMatchObject({ reason: { message: "division by zero" } });
    });

    it("still reports a quotient too large to represent as a domain-error", async () => {
      expectIndeterminate(
        await divide({ re: huge, im: huge }, { re: tiny, im: tiny }),
        "domain-error",
      );
    });
  });

  it("modulo is domain-error -- there is no remainder on the complex plane", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "modulo",
        left: { kind: "complexLiteral", re: 7, im: 1 },
        right: { kind: "complexLiteral", re: 3, im: 1 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });
});

describe("complex power -- a real integer exponent only", () => {
  it("raises to a positive integer exponent", async () => {
    // (1 + i)^4 = ((1 + i)^2)^2 = (2i)^2 = -4.
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", re: 1, im: 1 },
        right: { kind: "numberLiteral", value: 4 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: -4, im: 0, unit: {} });
  });

  it("raises to a negative integer exponent as the reciprocal of the positive power", async () => {
    // (1 + i)^-2 = 1 / (1 + i)^2 = 1 / 2i = -0.5i.
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", re: 1, im: 1 },
        right: { kind: "numberLiteral", value: -2 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: 0, im: -0.5, unit: {} });
  });

  it("raises to a zero exponent as the complex unit, exactly as a real base does", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", re: 3, im: 4 },
        right: { kind: "numberLiteral", value: 0 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: 1, im: 0, unit: {} });
  });

  it("is domain-error for a zero base with a negative exponent, the same as a real base", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", re: 0, im: 0 },
        right: { kind: "numberLiteral", value: -1 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });

  it("is wrong-type for a non-integer exponent -- an answer this design does not define, not one that does not exist", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", re: 1, im: 1 },
        right: { kind: "numberLiteral", value: 0.5 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("is wrong-type for a complex exponent, whatever the base", async () => {
    const complexExponent = { kind: "complexLiteral", re: 1, im: 2 } as const;
    const complexBase = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", re: 1, im: 1 },
        right: complexExponent,
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(complexBase, "wrong-type");

    const realBase = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "numberLiteral", value: 2 },
        right: complexExponent,
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(realBase, "wrong-type");
  });

  it("requires dimensionless operands, exactly as a real power does", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", re: 1, im: 1, unit: { V: 1 } },
        right: { kind: "numberLiteral", value: 2 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

describe("arithmetic mixing real and complex operands", () => {
  it("promotes a real operand to the complex plane rather than rejecting the pair", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "numberLiteral", value: 5, unit: { V: 1 } },
        right: { kind: "complexLiteral", re: 1, im: -6, unit: { V: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: 6, im: -6, unit: { V: 1 } });
  });

  it("scales a complex value by a real one, combining units dimensionally", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "multiply",
        left: { kind: "complexLiteral", re: 3, im: 4, unit: { A: 1 } },
        right: { kind: "numberLiteral", value: 2, unit: { V: 1, A: -1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "complex",
      re: 6,
      im: 8,
      unit: { V: 1 },
    });
  });

  it("stays complex even when the result's imaginary part is zero", async () => {
    // The result kind follows the operand kinds, never the runtime values -- a tree's shape would otherwise depend on the data flowing through it.
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "subtract",
        left: { kind: "complexLiteral", re: 3, im: 4 },
        right: { kind: "complexLiteral", re: 1, im: 4 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "complex", re: 2, im: 0 });
  });

  it("is wrong-type when a complex operand meets a temporal one", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "complexLiteral", re: 3, im: 4 },
        right: { kind: "durationLiteral", value: 5, unit: "min" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("is wrong-type when a complex operand meets a text one", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "complexLiteral", re: 3, im: 4 },
        right: { kind: "textLiteral", value: "active" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

describe("complex power by repeated squaring", () => {
  interface Complex {
    re: number;
    im: number;
  }

  async function power({
    base,
    exponent,
  }: Readonly<{
    base: Complex;
    exponent: number;
  }>) {
    return evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "complexLiteral", ...base },
        right: { kind: "numberLiteral", value: exponent },
      },
      undefined,
      resolvers,
    );
  }

  function complexResult(result: Awaited<ReturnType<typeof power>>): Complex {
    if (result.status !== "definite" || result.value.kind !== "complex") {
      throw new Error("expected a definite complex result");
    }

    return result.value;
  }

  /** The loop the implementation replaced: one multiplication per unit of the exponent. */
  function repeatedProduct(base: Readonly<Complex>, exponent: number): Complex {
    let re = 1;
    let im = 0;
    for (let applied = 0; applied < exponent; applied += 1) {
      [re, im] = [re * base.re - im * base.im, re * base.im + im * base.re];
    }

    return { re, im };
  }

  /** Rows are objects so each literal is an object-literal property value, which `no-magic-numbers` exempts. */
  const bases: Complex[] = [
    { re: 1, im: 1 },
    { re: 0.5, im: -1.5 },
    { re: -2, im: 0.25 },
  ];
  const exponents = [
    { exponent: 0 },
    { exponent: 1 },
    { exponent: 2 },
    { exponent: 3 },
    { exponent: 5 },
    { exponent: 8 },
    { exponent: 13 },
  ];
  const cases = bases.flatMap((base) =>
    exponents.map(({ exponent }) => ({ base, exponent })),
  );
  const precisionDigits = 9;
  const huge = 1e15;
  const unit = { re: 1, im: 0 };

  it.each(cases)(
    "matches the repeated product for $base to the power $exponent",
    async ({ base, exponent }) => {
      const value = complexResult(await power({ base, exponent }));
      const expected = repeatedProduct(base, exponent);

      expect(value.re).toBeCloseTo(expected.re, precisionDigits);
      expect(value.im).toBeCloseTo(expected.im, precisionDigits);
    },
  );

  it.each(cases)(
    "a negative exponent inverts the positive power for $base to the power -$exponent",
    async ({ base, exponent }) => {
      const value = complexResult(await power({ base, exponent: -exponent }));
      const product = repeatedProduct(base, exponent);

      // The inverse times the power is one.
      expect(value.re * product.re - value.im * product.im).toBeCloseTo(
        1,
        precisionDigits,
      );
      expect(value.re * product.im + value.im * product.re).toBeCloseTo(
        0,
        precisionDigits,
      );
    },
  );

  it("returns for an exponent a multiplication loop could never finish", async () => {
    expectDefinite(await power({ base: unit, exponent: huge }), {
      kind: "complex",
      ...unit,
      unit: {},
    });
    expectDefinite(await power({ base: unit, exponent: -huge }), {
      kind: "complex",
      ...unit,
      unit: {},
    });
  });

  it("underflows a shrinking base to zero rather than looping", async () => {
    expectDefinite(await power({ base: { re: 0.5, im: 0 }, exponent: huge }), {
      kind: "complex",
      re: 0,
      im: 0,
      unit: {},
    });
  });

  it("reports a power that overflows as a domain-error, large exponent or not", async () => {
    expectIndeterminate(
      await power({ base: { re: 2, im: 0 }, exponent: huge }),
      "domain-error",
    );
    expectIndeterminate(
      await power({ base: { re: 1e200, im: 0 }, exponent: 2 }),
      "domain-error",
    );
  });

  it("keeps a negative power of a large base finite where its positive power would overflow", async () => {
    // (1e160)^-2 is 1e-320, a subnormal; (1e160)^2 overflows, so inverting the positive power would lose it.
    const value = complexResult(
      await power({ base: { re: 1e160, im: 0 }, exponent: -2 }),
    );

    expect(value.re).toBeGreaterThan(0);
  });

  it("still reports a zero base with a negative exponent as a division by zero", async () => {
    expectIndeterminate(
      await power({ base: { re: 0, im: 0 }, exponent: -huge }),
      "domain-error",
    );
  });
});
