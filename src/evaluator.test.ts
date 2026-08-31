import { describe, expect, it } from "vitest";
import { evaluateValue } from "./evaluator";
import type { Evaluation } from "./evaluation";
import type { ComputedValue } from "./computed-value";
import type { ExpressionNode } from "./tree";
import type { Resolvers } from "./resolvers";

/** A resolver reporting a fixed `{ kind: "number", value: 10, unit: { m: 1 } }` for key `"present"`, and not-found for anything else -- `resolveLookup`/`resolveCollection` are never exercised by expression-level nodes and are stubbed only to satisfy `Resolvers`. */
const resolvers: Resolvers = {
  resolveValue: async (key) =>
    Promise.resolve(
      key === "present"
        ? { found: true, value: { kind: "number", value: 10, unit: { m: 1 } } }
        : { found: false },
    ),
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

function expectDefinite(
  evaluation: Evaluation<ComputedValue>,
  expected: ComputedValue,
): void {
  expect(evaluation).toEqual({ status: "definite", value: expected });
}

function expectIndeterminate(
  evaluation: Evaluation<ComputedValue>,
  code: "not-found" | "wrong-type" | "domain-error",
): void {
  expect(evaluation.status).toBe("indeterminate");
  if (evaluation.status === "indeterminate") {
    expect(evaluation.reason.code).toBe(code);
  }
}

describe("literals", () => {
  it("numberLiteral is always definite", async () => {
    const result = await evaluateValue(
      { kind: "numberLiteral", value: 42, unit: { kg: 1 } },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 42, unit: { kg: 1 } });
  });

  it("textLiteral is always definite", async () => {
    const result = await evaluateValue(
      { kind: "textLiteral", value: "active" },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "text", value: "active" });
  });

  it("instantLiteral is always definite", async () => {
    const result = await evaluateValue(
      { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "instant",
      value: "2026-01-01T00:00:00.000Z",
    });
  });

  it("durationLiteral is always definite", async () => {
    const result = await evaluateValue(
      { kind: "durationLiteral", value: 5, unit: "min" },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "duration", value: 5, unit: "min" });
  });
});

describe("reference", () => {
  it("resolves a found value with no expected unit", async () => {
    const result = await evaluateValue(
      { kind: "reference", key: "present" },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 10, unit: { m: 1 } });
  });

  it("resolves a found value whose unit matches the expected unit", async () => {
    const result = await evaluateValue(
      { kind: "reference", key: "present", unit: { m: 1 } },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 10, unit: { m: 1 } });
  });

  it("is not-found for an unresolved key", async () => {
    const result = await evaluateValue(
      { kind: "reference", key: "missing" },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("is wrong-type when the expected unit does not match the resolved unit", async () => {
    const result = await evaluateValue(
      { kind: "reference", key: "present", unit: { s: 1 } },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

/** `arithmetic`'s own indeterminate-propagation table -- contrast this against `and`/`or`'s absorption (see truth-tables.test.ts and `combineAnd`/`combineOr` in evaluator.ts): arithmetic has no absorbing value at all, so a definite operand on one side never rescues an indeterminate operand on the other, unlike OR's absorbing `true` or AND's absorbing `false`. */
describe("arithmetic indeterminate propagation (no absorbing value)", () => {
  const definiteOperand: ExpressionNode = { kind: "numberLiteral", value: 1 };
  const indeterminateOperand: ExpressionNode = {
    kind: "reference",
    key: "missing",
  };

  it("definite + definite => definite", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: definiteOperand,
        right: definiteOperand,
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 2 });
  });

  it("indeterminate + definite => indeterminate (left's reason, unlike OR's absorbing true)", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: indeterminateOperand,
        right: definiteOperand,
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("definite + indeterminate => indeterminate (right's reason)", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: definiteOperand,
        right: indeterminateOperand,
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("indeterminate + indeterminate => indeterminate, tie-broken left before right", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: indeterminateOperand,
        right: { kind: "reference", key: "also-missing" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

describe("arithmetic on numbers -- units", () => {
  it("add requires identical unit maps", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "numberLiteral", value: 3, unit: { m: 1 } },
        right: { kind: "numberLiteral", value: 4, unit: { m: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 7, unit: { m: 1 } });
  });

  it("subtract is wrong-type on mismatched units", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "subtract",
        left: { kind: "numberLiteral", value: 3, unit: { m: 1 } },
        right: { kind: "numberLiteral", value: 4, unit: { s: 1 } },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("multiply combines units dimensionally", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "multiply",
        left: { kind: "numberLiteral", value: 3, unit: { m: 1 } },
        right: { kind: "numberLiteral", value: 4, unit: { s: -1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "number",
      value: 12,
      unit: { m: 1, s: -1 },
    });
  });

  it("divide combines units dimensionally", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "divide",
        left: { kind: "numberLiteral", value: 10, unit: { m: 1 } },
        right: { kind: "numberLiteral", value: 2, unit: { s: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "number",
      value: 5,
      unit: { m: 1, s: -1 },
    });
  });

  it("dividing a unit by itself normalises to dimensionless", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "divide",
        left: { kind: "numberLiteral", value: 10, unit: { m: 1 } },
        right: { kind: "numberLiteral", value: 2, unit: { m: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 5, unit: {} });
  });
});

describe("arithmetic domain errors", () => {
  it("division by zero is domain-error", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "divide",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "numberLiteral", value: 0 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });

  it("modulo by zero is domain-error", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "modulo",
        left: { kind: "numberLiteral", value: 7 },
        right: { kind: "numberLiteral", value: 0 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });

  it("a negative base raised to a non-integer power is domain-error", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "numberLiteral", value: -1 },
        right: { kind: "numberLiteral", value: 0.5 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });

  it("power and modulo are otherwise ordinary numeric operations", async () => {
    const power = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "numberLiteral", value: 2 },
        right: { kind: "numberLiteral", value: 3 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(power, { kind: "number", value: 8 });

    const modulo = await evaluateValue(
      {
        kind: "arithmetic",
        op: "modulo",
        left: { kind: "numberLiteral", value: 7 },
        right: { kind: "numberLiteral", value: 3 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(modulo, { kind: "number", value: 1 });
  });
});

describe("arithmetic on non-numeric, non-temporal operands", () => {
  it("is wrong-type when an operand is text", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "textLiteral", value: "active" },
        right: { kind: "numberLiteral", value: 1 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

describe("negate", () => {
  it("flips a number's sign, preserving its unit", async () => {
    const result = await evaluateValue(
      {
        kind: "negate",
        operand: { kind: "numberLiteral", value: 5, unit: { m: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: -5, unit: { m: 1 } });
  });

  it("reverses a duration's magnitude, preserving its unit -- not sugar for zero minus the value", async () => {
    const result = await evaluateValue(
      {
        kind: "negate",
        operand: { kind: "durationLiteral", value: 5, unit: "min" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "duration", value: -5, unit: "min" });
  });

  it("is wrong-type on an instant", async () => {
    const result = await evaluateValue(
      {
        kind: "negate",
        operand: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("propagates an indeterminate operand", async () => {
    const result = await evaluateValue(
      { kind: "negate", operand: { kind: "reference", key: "missing" } },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

describe("temporal arithmetic -- the four well-defined combination rules", () => {
  it("instant - instant => duration, in milliseconds", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "subtract",
        left: { kind: "instantLiteral", value: "2026-01-01T00:01:00.000Z" },
        right: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "duration", value: 60_000, unit: "ms" });
  });

  it("instant + duration => instant", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
        right: { kind: "durationLiteral", value: 1, unit: "min" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "instant",
      value: "2026-01-01T00:01:00.000Z",
    });
  });

  it("duration + instant => instant", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "durationLiteral", value: 1, unit: "min" },
        right: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "instant",
      value: "2026-01-01T00:01:00.000Z",
    });
  });

  it("duration + duration => duration, normalising different units to milliseconds", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "durationLiteral", value: 1, unit: "min" },
        right: { kind: "durationLiteral", value: 30, unit: "s" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "duration", value: 90_000, unit: "ms" });
  });
});

describe("temporal arithmetic -- wrong-type violations", () => {
  it("adding two instants is wrong-type (only instant - instant is defined)", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
        right: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("subtracting a duration from an instant is wrong-type (not one of the defined combinations)", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "subtract",
        left: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
        right: { kind: "durationLiteral", value: 1, unit: "min" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("comparing an instant against a plain number is wrong-type", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
        right: { kind: "numberLiteral", value: 1 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("multiplying two durations is wrong-type (no representable result unit)", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "multiply",
        left: { kind: "durationLiteral", value: 1, unit: "min" },
        right: { kind: "durationLiteral", value: 2, unit: "s" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});
