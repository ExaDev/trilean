import { describe, expect, it } from "vitest";
import { evaluateValue } from "./evaluator-factory";
import { expectIndeterminate, resolvers } from "./evaluator-test-helpers";
import type { ArithmeticOperator, ExpressionNode } from "./tree";

const largest: ExpressionNode = {
  kind: "numberLiteral",
  value: Number.MAX_VALUE,
};
const negativeLargest: ExpressionNode = {
  kind: "numberLiteral",
  value: -Number.MAX_VALUE,
};
const smallest: ExpressionNode = {
  kind: "numberLiteral",
  value: Number.MIN_VALUE,
};

async function evaluateArithmetic(
  op: ArithmeticOperator,
  left: ExpressionNode,
  right: ExpressionNode,
) {
  return evaluateValue(
    { kind: "arithmetic", op, left, right },
    undefined,
    resolvers,
  );
}

describe("an arithmetic result outside the finite range", () => {
  it.each([
    ["add", largest, largest],
    ["subtract", largest, negativeLargest],
    ["multiply", largest, largest],
    ["divide", largest, smallest],
    ["power", largest, { kind: "numberLiteral", value: 2 }],
  ] as const)(
    "is a domain-error for %s, never a definite Infinity",
    async (op, left, right) => {
      const result = await evaluateArithmetic(op, left, right);

      expectIndeterminate(result, "domain-error");
      expect(result).toMatchObject({
        reason: { message: "result is not a finite number" },
      });
    },
  );

  it("is a domain-error for a duration sum, which reports in milliseconds", async () => {
    const duration: ExpressionNode = {
      kind: "durationLiteral",
      value: Number.MAX_VALUE,
      unit: "ms",
    };

    expectIndeterminate(
      await evaluateArithmetic("add", duration, duration),
      "domain-error",
    );
  });

  it("is a domain-error when either complex component overflows", async () => {
    const complex: ExpressionNode = {
      kind: "complexLiteral",
      re: Number.MAX_VALUE,
      im: 0,
    };

    expectIndeterminate(
      await evaluateArithmetic("multiply", complex, complex),
      "domain-error",
    );
  });

  it("leaves a finite result at the edge of the range definite", async () => {
    const result = await evaluateArithmetic("add", largest, smallest);

    expect(result).toEqual({
      status: "definite",
      value: { kind: "number", value: Number.MAX_VALUE, unit: undefined },
    });
  });
});
