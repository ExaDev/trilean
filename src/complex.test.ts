import { describe, expect, it } from "vitest";
import {
  complexFromPolar,
  complexLiteralFromPolar,
  complexMagnitude,
  complexPhase,
} from "./complex";
import { evaluateValue } from "./evaluator";
import type { Resolvers } from "./resolvers";
import { ExpressionNodeSchema } from "./tree";

/** No helper below reaches a resolver at all; these exist only to satisfy `evaluateValue`'s signature for the one node-building check. */
const resolvers: Resolvers = {
  resolveValue: async () => Promise.resolve({ found: false }),
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

/** The 3-4-5 right triangle, used so the magnitude below is exact rather than a floating-point approximation. */
const pythagoreanMagnitude = 5;
const quarterTurn = Math.PI / 2;
const arbitraryPhase = 0.7;

describe("complexFromPolar", () => {
  it("places a zero-phase value entirely on the real axis", () => {
    expect(complexFromPolar(2, 0)).toEqual({
      kind: "complex",
      re: 2,
      im: 0,
    });
  });

  it("carries the unit through unchanged", () => {
    expect(complexFromPolar(2, 0, { V: 1, A: -1 })).toEqual({
      kind: "complex",
      re: 2,
      im: 0,
      unit: { V: 1, A: -1 },
    });
  });
});

describe("complexMagnitude, complexPhase", () => {
  it("reads the magnitude back as a real number carrying the value's own unit", () => {
    expect(
      complexMagnitude({ kind: "complex", re: 3, im: -4, unit: { V: 1 } }),
    ).toEqual({ kind: "number", value: pythagoreanMagnitude, unit: { V: 1 } });
  });

  it("reads the phase back as a dimensionless angle in radians, whatever unit the value carries", () => {
    expect(
      complexPhase({ kind: "complex", re: 0, im: 2, unit: { V: 1 } }),
    ).toEqual({ kind: "number", value: quarterTurn });
  });

  it("round-trips a magnitude and phase through the rectangular form", () => {
    const roundTripped = complexFromPolar(pythagoreanMagnitude, arbitraryPhase);
    expect(complexMagnitude(roundTripped).value).toBeCloseTo(
      pythagoreanMagnitude,
    );
    expect(complexPhase(roundTripped).value).toBeCloseTo(arbitraryPhase);
  });
});

describe("complexLiteralFromPolar", () => {
  it("builds a complexLiteral the expression tree accepts, evaluating to the value complexFromPolar would have produced directly", async () => {
    const node = complexLiteralFromPolar(2, 0, { V: 1 });
    expect(ExpressionNodeSchema.parse(node)).toEqual(node);

    const result = await evaluateValue(node, undefined, resolvers);
    expect(result).toEqual({
      status: "definite",
      value: complexFromPolar(2, 0, { V: 1 }),
    });
  });
});
