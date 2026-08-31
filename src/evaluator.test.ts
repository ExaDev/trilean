import { describe, expect, it } from "vitest";
import { evaluatePredicate, evaluateValue } from "./evaluator";
import type { Evaluation } from "./evaluation";
import type { ExpressionNode, PredicateNode } from "./tree";
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

function expectDefinite<T>(evaluation: Evaluation<T>, expected: T): void {
  expect(evaluation).toEqual({ status: "definite", value: expected });
}

function expectIndeterminate<T>(
  evaluation: Evaluation<T>,
  code: "not-found" | "wrong-type" | "domain-error",
): void {
  expect(evaluation.status).toBe("indeterminate");
  if (evaluation.status === "indeterminate") {
    expect(evaluation.reason.code).toBe(code);
  }
}

/** A narrowing type guard for the golden-example checkpoint's resolver context below, following this repo's `object -> Record<string, unknown>` narrowing convention rather than an `as Record<string, unknown>` assertion. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray`'s own lib.es5.d.ts type predicate narrows to `any[]`, not `unknown[]` -- this re-typed wrapper is what lets `resolveCollection` below return a properly `unknown[]`-typed result instead of an implicit `any[]`. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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

describe("compare", () => {
  it.each([
    { op: "gt", left: 5, right: 3, expected: true },
    { op: "gt", left: 3, right: 5, expected: false },
    { op: "gte", left: 5, right: 5, expected: true },
    { op: "gte", left: 3, right: 5, expected: false },
    { op: "lt", left: 3, right: 5, expected: true },
    { op: "lt", left: 5, right: 3, expected: false },
    { op: "lte", left: 5, right: 5, expected: true },
    { op: "lte", left: 5, right: 3, expected: false },
    { op: "eq", left: 5, right: 5, expected: true },
    { op: "eq", left: 5, right: 3, expected: false },
    { op: "neq", left: 5, right: 3, expected: true },
    { op: "neq", left: 5, right: 5, expected: false },
  ] as const)(
    "$op($left, $right) => $expected",
    async ({ op, left, right, expected }) => {
      const result = await evaluatePredicate(
        {
          kind: "compare",
          op,
          left: { kind: "numberLiteral", value: left },
          right: { kind: "numberLiteral", value: right },
        },
        undefined,
        resolvers,
      );
      expectDefinite(result, expected);
    },
  );

  it("compares instants by parsed timestamp ordering", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "lt",
        left: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
        right: { kind: "instantLiteral", value: "2026-01-02T00:00:00.000Z" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("compares durations by magnitude, normalising different units to the same base", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "durationLiteral", value: 1, unit: "min" },
        right: { kind: "durationLiteral", value: 60, unit: "s" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("is wrong-type when comparing across different computed-value kinds", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "textLiteral", value: "1" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("is wrong-type when comparing an instant against a duration", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "instantLiteral", value: "2026-01-01T00:00:00.000Z" },
        right: { kind: "durationLiteral", value: 1, unit: "min" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("is wrong-type when two numbers have incompatible units", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "gt",
        left: { kind: "numberLiteral", value: 5, unit: { m: 1 } },
        right: { kind: "numberLiteral", value: 3, unit: { s: 1 } },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("propagates an indeterminate left operand", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "missing" },
        right: { kind: "numberLiteral", value: 1 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("propagates an indeterminate right operand", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "reference", key: "missing" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("tie-breaks two indeterminate operands to the left's reason, per the declared-operand-order rule", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "missing" },
        right: { kind: "reference", key: "also-missing" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

describe("textCompare", () => {
  it("equals is exact string equality", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "textLiteral", value: "active" },
        right: { kind: "textLiteral", value: "active" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("equals is false for differing strings", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "textLiteral", value: "active" },
        right: { kind: "textLiteral", value: "inactive" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("notEquals is the negation of equals", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "notEquals",
        left: { kind: "textLiteral", value: "active" },
        right: { kind: "textLiteral", value: "inactive" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("matches tests right's text as a regular expression against left's text", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "matches",
        left: { kind: "textLiteral", value: "active-123" },
        right: { kind: "textLiteral", value: "^active-\\d+$" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("matches is false when the pattern does not match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "matches",
        left: { kind: "textLiteral", value: "inactive" },
        right: { kind: "textLiteral", value: "^active$" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("notMatches is the negation of matches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "notMatches",
        left: { kind: "textLiteral", value: "inactive" },
        right: { kind: "textLiteral", value: "^active$" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("is wrong-type when the left operand is not text", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "textLiteral", value: "1" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("is wrong-type when the right operand is not text", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "textLiteral", value: "1" },
        right: { kind: "numberLiteral", value: 1 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("an invalid regular expression pattern is wrong-type, not a thrown exception", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "matches",
        left: { kind: "textLiteral", value: "anything" },
        right: { kind: "textLiteral", value: "(" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("propagates an indeterminate left operand", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "missing" },
        right: { kind: "textLiteral", value: "active" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("propagates an indeterminate right operand", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "textLiteral", value: "active" },
        right: { kind: "reference", key: "missing" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

/** Early integration checkpoint for the README "Worked example" golden example -- just the `isActive equals 1` half (a `compare`/`eq` node over a `reference` and a `numberLiteral`), against the same resolvers shown there. The full golden example, including the `fold` half, arrives once `fold` itself is implemented. */
describe("golden example checkpoint (isActive equals 1)", () => {
  it("a compare/eq node comparing a reference against a numberLiteral composes correctly", async () => {
    const data = {
      isActive: 1,
      x: 10,
      y: 5,
      items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
    };
    const goldenExampleResolvers: Resolvers = {
      resolveValue: async (key, context) => {
        if (
          typeof key !== "string" ||
          !isPlainRecord(context) ||
          !(key in context)
        ) {
          return Promise.resolve({ found: false });
        }
        const value = context[key];
        return Promise.resolve(
          typeof value === "number"
            ? { found: true, value: { kind: "number", value } }
            : { found: false },
        );
      },
      resolveLookup: async () => Promise.resolve({ found: false }),
      resolveCollection: async (collection, context) => {
        if (collection !== "items" || !isPlainRecord(context)) {
          return Promise.resolve([]);
        }
        const items = context.items;
        return Promise.resolve(isUnknownArray(items) ? items : []);
      },
    };
    const node: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: { kind: "reference", key: "isActive" },
      right: { kind: "numberLiteral", value: 1 },
    };

    const result = await evaluatePredicate(node, data, goldenExampleResolvers);

    expect(result).toEqual({ status: "definite", value: true });
  });
});
