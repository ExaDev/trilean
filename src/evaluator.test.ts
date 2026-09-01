import { describe, expect, it } from "vitest";
import { createEvaluator, evaluatePredicate, evaluateValue } from "./evaluator";
import type { Evaluation } from "./evaluation";
import type { FunctionRegistry } from "./functions";
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

  it("a zero base raised to a negative power is domain-error, not a definite infinity", async () => {
    const result = await evaluateValue(
      {
        kind: "arithmetic",
        op: "power",
        left: { kind: "numberLiteral", value: 0 },
        right: { kind: "numberLiteral", value: -1 },
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

  /** An `instant`'s value is an opaque string until something parses it: nothing in the schema layer checks that it really is an ISO-8601 timestamp, and a resolver can return whatever its backing data holds. Every operation that has to parse one must therefore keep an unparseable value inside the three-outcome model rather than letting `Date.parse`'s `NaN` leak onward -- silently, as a definite result computed from `NaN`, or loudly, as a thrown `RangeError` from `toISOString`. */
  describe("an unparseable instant is wrong-type, never a throw or a NaN-derived definite result", () => {
    const unparseable: ExpressionNode = {
      kind: "instantLiteral",
      value: "not-a-timestamp",
    };
    const parseable: ExpressionNode = {
      kind: "instantLiteral",
      value: "2026-01-01T00:00:00.000Z",
    };
    const oneHour: ExpressionNode = {
      kind: "durationLiteral",
      value: 1,
      unit: "h",
    };

    it("instant - instant", async () => {
      const result = await evaluateValue(
        {
          kind: "arithmetic",
          op: "subtract",
          left: unparseable,
          right: parseable,
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    });

    it("instant + duration", async () => {
      const result = await evaluateValue(
        { kind: "arithmetic", op: "add", left: unparseable, right: oneHour },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    });

    it("duration + instant", async () => {
      const result = await evaluateValue(
        { kind: "arithmetic", op: "add", left: oneHour, right: unparseable },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    });

    it("compare -- neq between two unparseable instants is not definitely true", async () => {
      const result = await evaluatePredicate(
        {
          kind: "compare",
          op: "neq",
          left: unparseable,
          right: unparseable,
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    });

    it("memberOf -- an unparseable candidate is not a definite non-match", async () => {
      const result = await evaluatePredicate(
        {
          kind: "memberOf",
          op: "in",
          operand: parseable,
          candidates: [unparseable],
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    });

    it("shifting a parseable instant beyond the representable timestamp range is domain-error", async () => {
      const result = await evaluateValue(
        {
          kind: "arithmetic",
          op: "add",
          left: parseable,
          right: { kind: "durationLiteral", value: 1e18, unit: "d" },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "domain-error");
    });
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

describe("memberOf", () => {
  it("in: a definite match makes the leaf definitely true", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [
          { kind: "numberLiteral", value: 3 },
          { kind: "numberLiteral", value: 5 },
        ],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("notIn: a definite match makes the leaf definitely false", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [{ kind: "numberLiteral", value: 5 }],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("a definite match short-circuits the result past a later indeterminate candidate", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [
          { kind: "numberLiteral", value: 5 },
          { kind: "reference", key: "missing" },
        ],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("an empty candidates list is never scanned: in is definitely false, notIn is definitely true", async () => {
    const inResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [],
      },
      undefined,
      resolvers,
    );
    expectDefinite(inResult, false);

    const notInResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [],
      },
      undefined,
      resolvers,
    );
    expectDefinite(notInResult, true);
  });

  it("no match among definite, comparable candidates: in is false, notIn is true", async () => {
    const candidates: ExpressionNode[] = [
      { kind: "numberLiteral", value: 1 },
      { kind: "numberLiteral", value: 2 },
    ];

    const inResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates,
      },
      undefined,
      resolvers,
    );
    expectDefinite(inResult, false);

    const notInResult = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "numberLiteral", value: 5 },
        candidates,
      },
      undefined,
      resolvers,
    );
    expectDefinite(notInResult, true);
  });

  it("tie-breaks several indeterminate/incompatible candidates to the first's reason, per declared order", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5 },
        candidates: [
          { kind: "textLiteral", value: "5" }, // incompatible kind -> wrong-type
          { kind: "reference", key: "missing" }, // not-found
        ],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("an indeterminate operand makes the whole leaf indeterminate without ever scanning a candidate", async () => {
    let candidateEvaluations = 0;
    const trackingResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async (key, context) => {
        if (key === "candidate-marker") candidateEvaluations += 1;
        return resolvers.resolveValue(key, context);
      },
    };
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "missing" },
        candidates: [{ kind: "reference", key: "candidate-marker" }],
      },
      undefined,
      trackingResolvers,
    );
    expectIndeterminate(result, "not-found");
    expect(candidateEvaluations).toBe(0);
  });

  it("respects units for numeric candidates -- an incompatible unit is wrong-type, never a plain non-match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: { kind: "numberLiteral", value: 5, unit: { m: 1 } },
        candidates: [{ kind: "numberLiteral", value: 5, unit: { s: 1 } }],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });
});

describe("exists", () => {
  it("a definite operand makes exists definitely true", async () => {
    const result = await evaluatePredicate(
      { kind: "exists", operand: { kind: "numberLiteral", value: 1 } },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("not-found converts to definitely false", async () => {
    const result = await evaluatePredicate(
      { kind: "exists", operand: { kind: "reference", key: "missing" } },
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("wrong-type converts to definitely true -- the data point resolved, it just wasn't usable", async () => {
    const result = await evaluatePredicate(
      {
        kind: "exists",
        operand: { kind: "reference", key: "present", unit: { s: 1 } },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("domain-error converts to definitely true -- the data point resolved, it just wasn't usable", async () => {
    const result = await evaluatePredicate(
      {
        kind: "exists",
        operand: {
          kind: "arithmetic",
          op: "divide",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "numberLiteral", value: 0 },
        },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });
});

describe("some, every", () => {
  /** A resolver whose `resolveCollection` maps a small set of named collection references onto plain-object item arrays, and whose `resolveValue` reads a field straight off whatever item context it's given -- mirroring `resolveCollection`/`resolveValue`'s real relationship: descending into a quantifier replaces the evaluation context with the resolved item itself (see README.md's "Evaluation context" section), so a `reference` inside `item`/`filter` resolves against that one item, not the outer context. */
  const quantifierResolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (
        typeof key !== "string" ||
        !isPlainRecord(context) ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      if (typeof value === "number") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value },
        });
      }
      if (typeof value === "string") {
        return Promise.resolve({ found: true, value: { kind: "text", value } });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection) => {
      if (collection === "amounts") {
        return Promise.resolve([{ amount: 1 }, { amount: 2 }, { amount: 30 }]);
      }
      if (collection === "grouped") {
        return Promise.resolve([
          { group: "keep", amount: 5 },
          { group: "skip", amount: 999 },
        ]);
      }
      if (collection === "flagged") {
        return Promise.resolve([
          { flag: 1, amount: 100 },
          { amount: 5 }, // no `flag` field -- the filter itself is indeterminate for this item
        ]);
      }
      return Promise.resolve([]);
    },
  };

  it("some is definitely true when at least one participating item's item predicate matches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 10 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, true);
  });

  it("some is definitely false when no participating item's item predicate matches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 1000 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, false);
  });

  it("every is definitely true when every participating item's item predicate matches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "every",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 0 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, true);
  });

  it("every is definitely false when at least one participating item's item predicate fails to match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "every",
        collection: "amounts",
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 10 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, false);
  });

  it("filter excludes an item entirely, as if it had never been in the collection", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "grouped",
        filter: {
          kind: "textCompare",
          op: "equals",
          left: { kind: "reference", key: "group" },
          right: { kind: "textLiteral", value: "keep" },
        },
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 500 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    // The only participating item ("keep") has amount 5, well under 500; the excluded item's amount 999 would satisfy `item`, but it never gets to participate.
    expectDefinite(result, false);
  });

  it("a filter-indeterminate item's own vote is absorbed by a different item's clean match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "flagged",
        filter: {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "flag" },
          right: { kind: "numberLiteral", value: 1 },
        },
        item: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "amount" },
          right: { kind: "numberLiteral", value: 10 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    // The second item has no `flag` field, so its filter is indeterminate and its vote is indeterminate too -- but the first item's clean match (flag 1, amount 100 > 10) still absorbs it to a definite true, exactly as OR's own absorption already requires.
    expectDefinite(result, true);
  });

  // Deliberate, settled per README.md: "every over an empty collection is definitely true" -- vacuous truth, the standard convention for universal quantification over an empty set. This must never be "fixed" to false.
  it("every over an empty collection is definitely true", async () => {
    const result = await evaluatePredicate(
      {
        kind: "every",
        collection: "nothing-here",
        item: {
          kind: "compare",
          op: "eq",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "numberLiteral", value: 1 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, true);
  });

  it("some over an empty collection is definitely false", async () => {
    const result = await evaluatePredicate(
      {
        kind: "some",
        collection: "nothing-here",
        item: {
          kind: "compare",
          op: "eq",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "numberLiteral", value: 1 },
        },
      },
      undefined,
      quantifierResolvers,
    );
    expectDefinite(result, false);
  });
});

describe("lookup", () => {
  const lookupResolvers: Resolvers = {
    resolveValue: async (key) => {
      if (key === "region") {
        return Promise.resolve({
          found: true,
          value: { kind: "text", value: "north" },
        });
      }
      if (key === "tier") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value: 2 },
        });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async (table) =>
      Promise.resolve(
        table === "pricing"
          ? { found: true, value: { kind: "number", value: 42 } }
          : { found: false },
      ),
    resolveCollection: async () => Promise.resolve([]),
  };

  it("evaluates every key and passes its resolved value to resolveLookup, in declared order", async () => {
    const receivedKeys: unknown[] = [];
    const trackingResolvers: Resolvers = {
      ...lookupResolvers,
      resolveLookup: async (table, keys, context) => {
        receivedKeys.push(...keys);
        return lookupResolvers.resolveLookup(table, keys, context);
      },
    };
    const result = await evaluateValue(
      {
        kind: "lookup",
        table: "pricing",
        keys: [
          { kind: "reference", key: "region" },
          { kind: "reference", key: "tier" },
        ],
      },
      undefined,
      trackingResolvers,
    );
    expect(receivedKeys).toEqual([
      { kind: "text", value: "north" },
      { kind: "number", value: 2 },
    ]);
    expectDefinite(result, { kind: "number", value: 42 });
  });

  it("is not-found when the resolver reports no match", async () => {
    const result = await evaluateValue(
      {
        kind: "lookup",
        table: "unknown-table",
        keys: [{ kind: "reference", key: "region" }],
      },
      undefined,
      lookupResolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

describe("conditional", () => {
  const whenEquals = (left: number, right: number): PredicateNode => ({
    kind: "compare",
    op: "eq",
    left: { kind: "numberLiteral", value: left },
    right: { kind: "numberLiteral", value: right },
  });
  /** `@typescript-eslint/no-magic-numbers` only exempts -1/0/1/2 -- a third distinctly-numbered case below needs a named constant instead of a bare `3`. */
  const thirdCaseIdentifier = 3;

  it("evaluates the then of the first case whose when is definitely true, skipping earlier false cases", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [
          {
            when: whenEquals(1, 2),
            then: { kind: "numberLiteral", value: 100 },
          },
          {
            when: whenEquals(1, 1),
            then: { kind: "numberLiteral", value: 200 },
          },
          {
            when: whenEquals(1, 1),
            then: { kind: "numberLiteral", value: 300 },
          },
        ],
        fallback: { kind: "numberLiteral", value: 0 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 200 });
  });

  it("evaluates fallback when no case matches", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [
          {
            when: whenEquals(1, 2),
            then: { kind: "numberLiteral", value: 100 },
          },
        ],
        fallback: { kind: "numberLiteral", value: 999 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 999 });
  });

  it("an empty cases list always evaluates to fallback", async () => {
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [],
        fallback: { kind: "numberLiteral", value: 999 },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 999 });
  });

  it("never evaluates a later case's then once an earlier case has already matched", async () => {
    let laterThenEvaluations = 0;
    const trackingResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async (key, context) => {
        if (key === "later-then-marker") laterThenEvaluations += 1;
        return resolvers.resolveValue(key, context);
      },
    };
    const result = await evaluateValue(
      {
        kind: "conditional",
        cases: [
          {
            when: whenEquals(1, 1),
            then: { kind: "numberLiteral", value: 200 },
          },
        ],
        fallback: { kind: "reference", key: "later-then-marker" },
      },
      undefined,
      trackingResolvers,
    );
    expectDefinite(result, { kind: "number", value: 200 });
    expect(laterThenEvaluations).toBe(0);
  });

  // A `when` predicate that is always indeterminate (not-found), used across the hitPolicy tests below to distinguish "this case definitely doesn't match" from "this case's match status is unknown".
  const whenIndeterminate: PredicateNode = {
    kind: "compare",
    op: "eq",
    left: { kind: "reference", key: "missing" },
    right: { kind: "numberLiteral", value: 0 },
  };

  describe("hitPolicy: 'unique'", () => {
    it("exactly one match: returns that case's then, and never evaluates any other case's then", async () => {
      let secondThenEvaluations = 0;
      const trackingResolvers: Resolvers = {
        ...resolvers,
        resolveValue: async (key, context) => {
          if (key === "second-then-marker") secondThenEvaluations += 1;
          return resolvers.resolveValue(key, context);
        },
      };
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 2),
              then: { kind: "reference", key: "second-then-marker" },
            },
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 200 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        trackingResolvers,
      );
      expectDefinite(result, { kind: "number", value: 200 });
      expect(secondThenEvaluations).toBe(0);
    });

    it("zero matches: returns fallback, same as 'first'", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 2),
              then: { kind: "numberLiteral", value: 100 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 999 },
        },
        undefined,
        resolvers,
      );
      expectDefinite(result, { kind: "number", value: 999 });
    });

    it("two matches: domain-error, regardless of case order", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 100 },
            },
            {
              when: whenEquals(2, 2),
              then: { kind: "numberLiteral", value: 200 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "domain-error");
      if (result.status === "indeterminate") {
        expect(result.reason.message).toBe(
          "more than one case matched under the 'unique' hit policy",
        );
      }
    });

    it("three matches: the same domain-error, not a distinct message", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 1 },
            },
            {
              when: whenEquals(2, 2),
              then: { kind: "numberLiteral", value: 2 },
            },
            {
              when: whenEquals(thirdCaseIdentifier, thirdCaseIdentifier),
              then: { kind: "numberLiteral", value: thirdCaseIdentifier },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "domain-error");
      if (result.status === "indeterminate") {
        expect(result.reason.message).toBe(
          "more than one case matched under the 'unique' hit policy",
        );
      }
    });

    it("one match plus one unrelated indeterminate case: the whole node is indeterminate, NOT the match's then -- a single confirmed match does not absorb a remaining unresolved sibling under 'unique'", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 100 },
            },
            {
              when: whenIndeterminate,
              then: { kind: "numberLiteral", value: 200 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "not-found");
    });

    it("two matches plus a third indeterminate case: still the domain-error -- 2+ matches absorbs even a genuine indeterminate elsewhere", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 1),
              then: { kind: "numberLiteral", value: 1 },
            },
            {
              when: whenEquals(2, 2),
              then: { kind: "numberLiteral", value: 2 },
            },
            {
              when: whenIndeterminate,
              then: { kind: "numberLiteral", value: 3 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "domain-error");
    });

    it("zero matches plus one indeterminate case: indeterminate", async () => {
      const result = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            {
              when: whenEquals(1, 2),
              then: { kind: "numberLiteral", value: 1 },
            },
            {
              when: whenIndeterminate,
              then: { kind: "numberLiteral", value: 2 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "not-found");
    });

    it("absent hitPolicy behaves identically to explicit 'first'", async () => {
      const cases = [
        {
          when: whenEquals(1, 2),
          then: { kind: "numberLiteral" as const, value: 100 },
        },
        {
          when: whenEquals(1, 1),
          then: { kind: "numberLiteral" as const, value: 200 },
        },
      ];
      const withoutHitPolicy = await evaluateValue(
        {
          kind: "conditional",
          cases,
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      const withExplicitFirst = await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "first",
          cases,
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        resolvers,
      );
      expect(withoutHitPolicy).toEqual(withExplicitFirst);
      expectDefinite(withoutHitPolicy, { kind: "number", value: 200 });
    });

    it("evaluates every case's when concurrently, not short-circuited on the first match", async () => {
      const caseCount = 3;
      let whenEvaluationCount = 0;
      const trackingResolvers: Resolvers = {
        ...resolvers,
        resolveValue: async (key, context) => {
          if (key === "when-marker") whenEvaluationCount += 1;
          return resolvers.resolveValue(key, context);
        },
      };
      const whenMarker: PredicateNode = {
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "when-marker" },
        right: { kind: "numberLiteral", value: 0 },
      };
      await evaluateValue(
        {
          kind: "conditional",
          hitPolicy: "unique",
          cases: [
            { when: whenMarker, then: { kind: "numberLiteral", value: 1 } },
            { when: whenMarker, then: { kind: "numberLiteral", value: 2 } },
            { when: whenMarker, then: { kind: "numberLiteral", value: 3 } },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        trackingResolvers,
      );
      expect(whenEvaluationCount).toBe(caseCount);
    });
  });
});

describe("fold", () => {
  const foldResolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (
        typeof key !== "string" ||
        !isPlainRecord(context) ||
        !(key in context)
      ) {
        return Promise.resolve({ found: false });
      }
      const value = context[key];
      if (typeof value === "number") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value },
        });
      }
      if (typeof value === "string") {
        return Promise.resolve({ found: true, value: { kind: "text", value } });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection) => {
      if (collection === "amounts") {
        return Promise.resolve([{ amount: 8 }, { amount: 12 }, { amount: 1 }]);
      }
      if (collection === "grouped") {
        return Promise.resolve([
          { group: "keep", amount: 5 },
          { group: "skip", amount: 999 },
        ]);
      }
      if (collection === "empty") return Promise.resolve([]);
      return Promise.resolve([]);
    },
  };

  describe("reduce", () => {
    it("sums participating items, threading the running total through accumulator", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "amounts",
          combiner: {
            mode: "reduce",
            initial: { kind: "numberLiteral", value: 0 },
            combine: {
              kind: "arithmetic",
              op: "add",
              left: { kind: "accumulator" },
              right: { kind: "reference", key: "amount" },
            },
          },
        },
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 21 });
    });

    it("filter narrows which items participate, exactly like some/every's own filter", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "grouped",
          filter: {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "group" },
            right: { kind: "textLiteral", value: "keep" },
          },
          combiner: {
            mode: "reduce",
            initial: { kind: "numberLiteral", value: 0 },
            combine: {
              kind: "arithmetic",
              op: "add",
              left: { kind: "accumulator" },
              right: { kind: "reference", key: "amount" },
            },
          },
        },
        undefined,
        foldResolvers,
      );
      // The excluded item's amount (999) never participates; only the kept item's 5 does.
      expectDefinite(result, { kind: "number", value: 5 });
    });

    it("over an empty (post-filter) collection evaluates to initial directly, without touching combine", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "empty",
          combiner: {
            mode: "reduce",
            initial: { kind: "numberLiteral", value: 7 },
            combine: { kind: "numberLiteral", value: 999 },
          },
        },
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 7 });
    });
  });

  describe("max, min", () => {
    it("max keeps the largest projected value seen", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "amounts",
          combiner: { mode: "max", item: { kind: "reference", key: "amount" } },
        },
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 12 });
    });

    it("min keeps the smallest projected value seen", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "amounts",
          combiner: { mode: "min", item: { kind: "reference", key: "amount" } },
        },
        undefined,
        foldResolvers,
      );
      expectDefinite(result, { kind: "number", value: 1 });
    });

    it("is domain-error over an empty (post-filter) collection -- there is no first item to seed from", async () => {
      const result = await evaluateValue(
        {
          kind: "fold",
          collection: "empty",
          combiner: { mode: "max", item: { kind: "reference", key: "amount" } },
        },
        undefined,
        foldResolvers,
      );
      expectIndeterminate(result, "domain-error");
    });
  });
});

describe("accumulator", () => {
  it("is wrong-type when evaluated outside any fold's combine expression", async () => {
    const result = await evaluateValue(
      { kind: "accumulator" },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("resolves to the running value inside a reduce fold's own combine expression", async () => {
    // The collection has to genuinely resolve to items: over an empty one `combine` is never evaluated at all and the fold returns `initial` untouched, so an assertion against `initial`'s own value would hold whether or not `accumulator` resolved correctly. Stepping the accumulator once per item is what makes the expected value depend on it.
    const twoItemResolvers: Resolvers = {
      ...resolvers,
      resolveCollection: async () => Promise.resolve([{}, {}]),
    };
    const result = await evaluateValue(
      {
        kind: "fold",
        collection: "items",
        combiner: {
          mode: "reduce",
          initial: { kind: "numberLiteral", value: 5 },
          combine: {
            kind: "arithmetic",
            op: "add",
            left: { kind: "accumulator" },
            right: { kind: "numberLiteral", value: 1 },
          },
        },
      },
      undefined,
      twoItemResolvers,
    );
    expectDefinite(result, { kind: "number", value: 7 });
  });
});

describe("delegate", () => {
  it("is wrong-type when no delegate handler is registered", async () => {
    const result = await evaluateValue(
      { kind: "delegate", system: "tax-engine", payload: { rate: 0.2 } },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("resolves via the registered handler when one is provided", async () => {
    const delegateResolvers: Resolvers = {
      ...resolvers,
      resolveDelegate: async (system) =>
        Promise.resolve(
          system === "tax-engine"
            ? { found: true, value: { kind: "number", value: 42 } }
            : { found: false },
        ),
    };
    const result = await evaluateValue(
      { kind: "delegate", system: "tax-engine", payload: null },
      undefined,
      delegateResolvers,
    );
    expectDefinite(result, { kind: "number", value: 42 });
  });

  it("is not-found when the registered handler itself reports absence", async () => {
    const delegateResolvers: Resolvers = {
      ...resolvers,
      resolveDelegate: async () => Promise.resolve({ found: false }),
    };
    const result = await evaluateValue(
      { kind: "delegate", system: "tax-engine", payload: null },
      undefined,
      delegateResolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

describe("treeReference", () => {
  it("evaluatePredicate: is wrong-type when no tree resolver is registered", async () => {
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "eligibility" },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("evaluateValue: is wrong-type when no tree resolver is registered", async () => {
    const result = await evaluateValue(
      { kind: "treeReference", key: "pricing" },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("evaluatePredicate: is not-found when the resolver reports absence", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () => Promise.resolve({ found: false }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "eligibility" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "not-found");
  });

  it("evaluatePredicate: resolves and evaluates the referenced predicate tree, with context passed through unchanged", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve(
          key === "eligibility"
            ? {
                found: true,
                node: {
                  kind: "compare",
                  op: "eq",
                  left: { kind: "reference", key: "age" },
                  right: { kind: "numberLiteral", value: 21 },
                },
              }
            : { found: false },
        ),
      resolveValue: async (key, context) =>
        Promise.resolve(
          key === "age" && isPlainRecord(context) && "age" in context
            ? {
                found: true,
                value: { kind: "number", value: context.age as number },
              }
            : { found: false },
        ),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "eligibility" },
      { age: 21 },
      treeResolvers,
    );
    expectDefinite(result, true);
  });

  it("evaluateValue: resolves and evaluates the referenced expression tree, with the enclosing fold's accumulator passed through unchanged", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve(
          key === "double-accumulator"
            ? {
                found: true,
                node: {
                  kind: "arithmetic",
                  op: "multiply",
                  left: { kind: "accumulator" },
                  right: { kind: "numberLiteral", value: 2 },
                },
              }
            : { found: false },
        ),
      resolveCollection: async (collection) =>
        Promise.resolve(collection === "items" ? [{}] : []),
    };
    const result = await evaluateValue(
      {
        kind: "fold",
        collection: "items",
        combiner: {
          mode: "reduce",
          initial: { kind: "numberLiteral", value: 5 },
          combine: { kind: "treeReference", key: "double-accumulator" },
        },
      },
      undefined,
      treeResolvers,
    );
    expectDefinite(result, { kind: "number", value: 10, unit: {} });
  });

  it("evaluatePredicate: is wrong-type when the resolved node fails to parse as a PredicateNode", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () =>
        Promise.resolve({ found: true, node: { kind: "not-a-real-kind" } }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "malformed" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("evaluateValue: is wrong-type when the resolved node fails to parse as an ExpressionNode", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () =>
        Promise.resolve({ found: true, node: "just a string, not a node" }),
    };
    const result = await evaluateValue(
      { kind: "treeReference", key: "malformed" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("direct self-reference is a domain-error: circular treeReference detected", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () =>
        Promise.resolve({
          found: true,
          node: { kind: "treeReference", key: "self" },
        }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "self" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "domain-error");
    if (result.status === "indeterminate") {
      expect(result.reason.message).toBe("circular treeReference detected");
    }
  });

  it("indirect A -> B -> A cycle is a domain-error", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve({
          found: true,
          node: {
            kind: "treeReference",
            key: key === "ruleA" ? "ruleB" : "ruleA",
          },
        }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "ruleA" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "domain-error");
    if (result.status === "indeterminate") {
      expect(result.reason.message).toBe("circular treeReference detected");
    }
  });

  it("a long acyclic chain past the maximum depth is a domain-error, not a cycle", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async (key) =>
        Promise.resolve({
          found: true,
          node: {
            kind: "treeReference",
            key: `${typeof key === "string" ? key : "chain"}-next`,
          },
        }),
    };
    const result = await evaluatePredicate(
      { kind: "treeReference", key: "chain-0" },
      undefined,
      treeResolvers,
    );
    expectIndeterminate(result, "domain-error");
    if (result.status === "indeterminate") {
      expect(result.reason.message).toBe(
        "treeReference chain exceeds the maximum depth of 100",
      );
    }
  });

  it("a treeReference nested inside a some/every filter still participates in cycle detection correctly", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveCollection: async (collection) =>
        Promise.resolve(collection === "items" ? [{}] : []),
      resolveTree: async () =>
        Promise.resolve({
          found: true,
          node: { kind: "treeReference", key: "self-in-filter" },
        }),
    };
    await expect(
      evaluatePredicate(
        {
          kind: "some",
          collection: "items",
          item: {
            kind: "exists",
            operand: { kind: "numberLiteral", value: 1 },
          },
          filter: { kind: "treeReference", key: "self-in-filter" },
        },
        undefined,
        treeResolvers,
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: {
        code: "domain-error",
        message: "circular treeReference detected",
      },
    });
  });

  it("a treeReference nested inside a conditional's when still participates in cycle detection correctly", async () => {
    const treeResolvers: Resolvers = {
      ...resolvers,
      resolveTree: async () =>
        Promise.resolve({
          found: true,
          node: { kind: "treeReference", key: "self-in-when" },
        }),
    };
    await expect(
      evaluateValue(
        {
          kind: "conditional",
          cases: [
            {
              when: { kind: "treeReference", key: "self-in-when" },
              then: { kind: "numberLiteral", value: 1 },
            },
          ],
          fallback: { kind: "numberLiteral", value: 0 },
        },
        undefined,
        treeResolvers,
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      reason: {
        code: "domain-error",
        message: "circular treeReference detected",
      },
    });
  });
});

describe("call", () => {
  const doubleFn: FunctionRegistry = {
    double: (args) => {
      const [arg] = args;
      if (arg?.kind !== "number") {
        return { domainError: "double requires a single number argument" };
      }
      return { kind: "number", value: arg.value + arg.value };
    },
  };

  it("invokes the registered function with the resolved arguments", async () => {
    const { evaluateValue: evaluate } = createEvaluator({
      functions: doubleFn,
    });
    const result = await evaluate(
      {
        kind: "call",
        fn: "double",
        args: [{ kind: "numberLiteral", value: 21 }],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 42 });
  });

  it("is wrong-type for an unregistered function name", async () => {
    const result = await evaluateValue(
      { kind: "call", fn: "doesNotExist", args: [] },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  /** A `FunctionRegistry` is an ordinary object, so `Object.prototype`'s own members answer a bare index lookup on it. A tree naming one of those is naming a function nobody registered, and must be reported as such rather than reaching a prototype method -- which would either throw or produce a "definite" result that is not a `ComputedValue` at all. */
  it.each(["toString", "valueOf", "constructor", "hasOwnProperty"])(
    "treats the inherited Object.prototype member '%s' as an unregistered function name",
    async (fn) => {
      const result = await evaluateValue(
        { kind: "call", fn, args: [] },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    },
  );

  it("is domain-error when the registered function reports one", async () => {
    const { evaluateValue: evaluate } = createEvaluator({
      functions: doubleFn,
    });
    const result = await evaluate(
      {
        kind: "call",
        fn: "double",
        args: [{ kind: "textLiteral", value: "x" }],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "domain-error");
  });

  it("evaluates every argument concurrently, tie-breaking an indeterminate outcome to the first in declared order", async () => {
    const { evaluateValue: evaluate } = createEvaluator({
      functions: doubleFn,
    });
    const result = await evaluate(
      {
        kind: "call",
        fn: "double",
        args: [
          { kind: "reference", key: "missing" },
          { kind: "reference", key: "also-missing" },
        ],
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "not-found");
  });
});

/** README.md's own "Worked example" (§ Worked example), verbatim: `isActive equals 1` AND `sum(items.amount) > x + y`, where the sum is exactly the `fold` tree the `sum` derived-aggregate builder assembles. Both variations from the README are included, exercising the propagation rules the worked example is there to demonstrate -- absorption via `and`'s definitely-false right operand, versus a missing reference surfacing all the way to the top because `true` is not absorbing for `and`. */
describe("golden example (README Worked example)", () => {
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
    kind: "and",
    left: {
      kind: "compare",
      op: "eq",
      left: { kind: "reference", key: "isActive" },
      right: { kind: "numberLiteral", value: 1 },
    },
    right: {
      kind: "compare",
      op: "gt",
      left: {
        kind: "fold",
        collection: "items",
        combiner: {
          mode: "reduce",
          initial: { kind: "numberLiteral", value: 0 },
          combine: {
            kind: "arithmetic",
            op: "add",
            left: { kind: "accumulator" },
            right: { kind: "reference", key: "amount" },
          },
        },
      },
      right: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "reference", key: "x" },
        right: { kind: "reference", key: "y" },
      },
    },
  };

  it("base case: isActive=1, sum(items.amount)=21 > x+y=15 => definitely true", async () => {
    const data = {
      isActive: 1,
      x: 10,
      y: 5,
      items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
    };
    const result = await evaluatePredicate(node, data, goldenExampleResolvers);
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("empty items: the sum-over-empty identity (0) is not > 15, and false absorbs regardless of the left branch", async () => {
    const data = { isActive: 1, x: 10, y: 5, items: [] as unknown[] };
    const result = await evaluatePredicate(node, data, goldenExampleResolvers);
    expect(result).toEqual({ status: "definite", value: false });
  });

  it("missing x: not-found surfaces to the top, since true is not absorbing for and", async () => {
    const data = {
      isActive: 1,
      y: 5,
      items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
    };
    const result = await evaluatePredicate(node, data, goldenExampleResolvers);
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });
});
