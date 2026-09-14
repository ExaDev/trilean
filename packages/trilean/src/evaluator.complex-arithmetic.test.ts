import { describe, it } from "vitest";
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
  it("raises to a positive integer exponent by repeated multiplication", async () => {
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
