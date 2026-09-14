import { describe, expect, it } from "vitest";
import { evaluatePredicate, evaluateValue } from "./evaluator-factory";
import type { Resolvers } from "./resolvers";
import {
  expectDefinite,
  expectIndeterminate,
  resolvers,
} from "./evaluator-test-helpers";

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

  it("booleanLiteral is always definite", async () => {
    const result = await evaluateValue(
      { kind: "booleanLiteral", value: true },
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "boolean", value: true });
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

describe("complexLiteral", () => {
  it("is always definite, preserving both components and the optional unit", async () => {
    const result = await evaluateValue(
      { kind: "complexLiteral", re: 3, im: -4, unit: { V: 1, A: -1 } },
      undefined,
      resolvers,
    );
    expectDefinite(result, {
      kind: "complex",
      re: 3,
      im: -4,
      unit: { V: 1, A: -1 },
    });
  });

  it("normalises a polar literal to rectangular on evaluation, preserving the optional unit", async () => {
    const result = await evaluateValue(
      {
        kind: "complexLiteral",
        magnitude: 1,
        phase: Math.PI / 2,
        unit: { V: 1 },
      },
      undefined,
      resolvers,
    );
    expect(result.status).toBe("definite");
    if (result.status !== "definite") return;
    expect(result.value.kind).toBe("complex");
    if (result.value.kind !== "complex") return;
    expect(result.value.re).toBeCloseTo(0);
    expect(result.value.im).toBeCloseTo(1);
    expect(result.value.unit).toEqual({ V: 1 });
  });

  it("eq: a rectangular literal and a polar literal representing the same underlying complex number compare as equal", async () => {
    // A deliberately non-trivial phase (not a multiple of pi/2), with the rectangular side computed from the raw trig formula independently of the evaluator/complexFromPolar under test -- a sin/cos swap, or a bug that ignored `phase` entirely, would each produce a rectangular value that differs from this one, unlike phase 0's trivial identity.
    const arbitraryPhase = 0.7;
    const magnitude = 2;
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "eq",
        left: {
          kind: "complexLiteral",
          re: magnitude * Math.cos(arbitraryPhase),
          im: magnitude * Math.sin(arbitraryPhase),
        },
        right: { kind: "complexLiteral", magnitude, phase: arbitraryPhase },
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
  });

  it("memberOf: a rectangular operand matches a candidate list containing a polar literal representing the same number", async () => {
    // Same non-trivial-phase, independently-computed-rectangular reasoning as the `eq` test above applies here.
    const arbitraryPhase = 0.7;
    const magnitude = 1;
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: {
          kind: "complexLiteral",
          re: magnitude * Math.cos(arbitraryPhase),
          im: magnitude * Math.sin(arbitraryPhase),
        },
        candidates: [
          { kind: "complexLiteral", re: 0, im: 1 },
          { kind: "complexLiteral", magnitude, phase: arbitraryPhase },
        ],
      },
      undefined,
      resolvers,
    );
    expectDefinite(result, true);
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

  it("resolves a boolean value with no schema change beyond the ComputedValue union itself -- reference carries no kind restriction of its own", async () => {
    const booleanResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async (key, context) =>
        key === "active"
          ? Promise.resolve({
              found: true,
              value: { kind: "boolean", value: true },
            })
          : resolvers.resolveValue(key, context),
    };
    const result = await evaluateValue(
      { kind: "reference", key: "active" },
      undefined,
      booleanResolvers,
    );
    expectDefinite(result, { kind: "boolean", value: true });
  });

  it("checks an expected unit against a complex resolution too, since a complex value carries one as well", async () => {
    const complexResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async () =>
        Promise.resolve({
          found: true,
          value: { kind: "complex", re: 3, im: -4, unit: { V: 1, A: -1 } },
        }),
    };

    const matching = await evaluateValue(
      { kind: "reference", key: "impedance", unit: { V: 1, A: -1 } },
      undefined,
      complexResolvers,
    );
    expectDefinite(matching, {
      kind: "complex",
      re: 3,
      im: -4,
      unit: { V: 1, A: -1 },
    });

    const mismatched = await evaluateValue(
      { kind: "reference", key: "impedance", unit: { V: 1 } },
      undefined,
      complexResolvers,
    );
    expectIndeterminate(mismatched, "wrong-type");
  });
});
