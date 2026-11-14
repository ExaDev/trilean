import { describe, expect, it } from "vitest";
import { evaluateValue } from "./evaluator-factory";
import type { ExpressionNode } from "./tree";
import { resolvers } from "./evaluator-test-helpers";

/**
 * What complex arithmetic evaluates to is in the conformance corpus (`conformance/trilean/evaluate/evaluator.complex-arithmetic.json`). What stays here asserts a property the corpus cannot state without an exact digit of the implementation's: that a quotient is not zero, and that two evaluations agree.
 */
interface Complex {
  re: number;
  im: number;
}

const literal = ({ re, im }: Complex): ExpressionNode => ({
  kind: "complexLiteral",
  re,
  im,
});

async function power({
  base,
  exponent,
}: Readonly<{ base: Complex; exponent: number }>) {
  return evaluateValue(
    {
      kind: "arithmetic",
      op: "power",
      left: literal(base),
      right: { kind: "numberLiteral", value: exponent },
    },
    undefined,
    resolvers,
  );
}

describe("complex division", () => {
  it("does not report a subnormal quotient as equal to zero", async () => {
    const quotient = await evaluateValue(
      {
        kind: "arithmetic",
        op: "divide",
        left: literal({
          re: -7.124494562846174e-209,
          im: -8.343164103148207e-219,
        }),
        right: literal({
          re: 2.50063496577604e114,
          im: -1.8086225038951245e105,
        }),
      },
      undefined,
      resolvers,
    );
    const value = quotient.status === "definite" ? quotient.value : undefined;
    if (value?.kind !== "complex") throw new Error("expected a complex result");
    expect(value.re).not.toBe(0);
  });
});

describe("complex power by repeated squaring", () => {
  const bases: Complex[] = [
    { re: 1, im: 1 },
    { re: 0.5, im: -1.5 },
    { re: -2, im: 0.25 },
  ];
  const exponents = [
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

  it.each(cases)(
    "a negative exponent is exactly the reciprocal of the positive power when that is representable, for $base to the power -$exponent",
    async ({ base, exponent }) => {
      const inverted = await power({ base, exponent: -exponent });
      const reciprocal = await evaluateValue(
        {
          kind: "arithmetic",
          op: "divide",
          left: literal({ re: 1, im: 0 }),
          right: {
            kind: "arithmetic",
            op: "power",
            left: literal(base),
            right: { kind: "numberLiteral", value: exponent },
          },
        },
        undefined,
        resolvers,
      );
      expect(inverted).toEqual(reciprocal);
    },
  );
});
