import { describe, it } from "vitest";
import { evaluatePredicate, evaluateValue } from "./evaluator";
import type { ExpressionNode } from "./tree";
import {
  expectDefinite,
  expectIndeterminate,
  resolvers,
} from "./evaluator-test-helpers";

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
