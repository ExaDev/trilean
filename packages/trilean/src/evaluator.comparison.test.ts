import { describe, it } from "vitest";
import { evaluatePredicate } from "./evaluator-factory";
import {
  expectDefinite,
  expectIndeterminate,
  resolvers,
} from "./evaluator-test-helpers";

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

  it.each([
    { op: "eq", left: true, right: true, expected: true },
    { op: "eq", left: true, right: false, expected: false },
    { op: "neq", left: true, right: false, expected: true },
    { op: "neq", left: true, right: true, expected: false },
  ] as const)(
    "boolean $op($left, $right) => $expected",
    async ({ op, left, right, expected }) => {
      const result = await evaluatePredicate(
        {
          kind: "compare",
          op,
          left: { kind: "booleanLiteral", value: left },
          right: { kind: "booleanLiteral", value: right },
        },
        undefined,
        resolvers,
      );
      expectDefinite(result, expected);
    },
  );

  it.each(["gt", "gte", "lt", "lte"] as const)(
    "%s is wrong-type for boolean operands -- no natural ordering",
    async (op) => {
      const result = await evaluatePredicate(
        {
          kind: "compare",
          op,
          left: { kind: "booleanLiteral", value: true },
          right: { kind: "booleanLiteral", value: false },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
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

  it.each([
    { op: "eq", right: { re: 3, im: -4 }, expected: true },
    { op: "eq", right: { re: 3, im: 4 }, expected: false },
    { op: "eq", right: { re: -3, im: -4 }, expected: false },
    { op: "neq", right: { re: 3, im: 4 }, expected: true },
    { op: "neq", right: { re: 3, im: -4 }, expected: false },
  ] as const)(
    "$op against a complex value is exact equality across both components => $expected",
    async ({ op, right, expected }) => {
      const result = await evaluatePredicate(
        {
          kind: "compare",
          op,
          left: { kind: "complexLiteral", re: 3, im: -4 },
          right: { kind: "complexLiteral", ...right },
        },
        undefined,
        resolvers,
      );
      expectDefinite(result, expected);
    },
  );

  it.each(["gt", "gte", "lt", "lte"] as const)(
    "%s is wrong-type on complex operands -- the complex plane carries no total order",
    async (op) => {
      const result = await evaluatePredicate(
        {
          kind: "compare",
          op,
          left: { kind: "complexLiteral", re: 3, im: -4 },
          right: { kind: "complexLiteral", re: 1, im: 1 },
        },
        undefined,
        resolvers,
      );
      expectIndeterminate(result, "wrong-type");
    },
  );

  it("is wrong-type when two complex values have incompatible units", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "complexLiteral", re: 3, im: -4, unit: { V: 1 } },
        right: { kind: "complexLiteral", re: 3, im: -4, unit: { A: 1 } },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("is wrong-type when comparing a complex value against a real one, unlike arithmetic's promotion", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "complexLiteral", re: 3, im: 0 },
        right: { kind: "numberLiteral", value: 3 },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
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

  it("is wrong-type when comparing a boolean against a number", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "booleanLiteral", value: true },
        right: { kind: "numberLiteral", value: 1 },
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

  it("portableMatches tests right's text as a trilean-regex pattern against left's text", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "textLiteral", value: "active-123" },
        right: { kind: "textLiteral", value: "^active-\\d+$" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("portableMatches is false when the pattern does not match", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "textLiteral", value: "inactive" },
        right: { kind: "textLiteral", value: "^active$" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, false);
  });

  it("portableNotMatches is the negation of portableMatches", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "portableNotMatches",
        left: { kind: "textLiteral", value: "inactive" },
        right: { kind: "textLiteral", value: "^active$" },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("an invalid trilean-regex pattern is wrong-type, not a thrown exception", async () => {
    const result = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "textLiteral", value: "anything" },
        right: { kind: "textLiteral", value: "(a)" },
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(result, "wrong-type");
  });

  it("portableMatches accepts only its own restricted grammar, rejecting an ECMAScript-only construct matches would accept", async () => {
    // A lookahead is valid ECMAScript but not a construct trilean-regex's grammar defines -- see packages/trilean-regex/README.md's "Grammar" table. This is the load-bearing case distinguishing the two operator pairs: the same pattern text is accepted by 'matches' and rejected by 'portableMatches'.
    const lookahead = { kind: "textLiteral" as const, value: "^(?=a)a$" };
    const viaMatches = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "matches",
        left: { kind: "textLiteral", value: "a" },
        right: lookahead,
      },
      undefined,
      resolvers,
    );
    expectDefinite(viaMatches, true);

    const viaPortableMatches = await evaluatePredicate(
      {
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "textLiteral", value: "a" },
        right: lookahead,
      },
      undefined,
      resolvers,
    );
    expectIndeterminate(viaPortableMatches, "wrong-type");
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
