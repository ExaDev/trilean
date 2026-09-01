import { describe, expect, it } from "vitest";
import {
  ComplexPolarSchema,
  ComplexRectangularSchema,
  ComplexValueSchema,
  toRectangular,
} from "./computed-value";

/** `toBeCloseTo`'s own precision-digits argument, named individually since `@typescript-eslint/no-magic-numbers` only exempts -1/0/1/2 and object-literal property values, not a plain call argument. */
const closeToPrecisionDigits = 10;

describe("toRectangular", () => {
  it("a rectangular value passes its own re/im straight through", () => {
    expect(toRectangular({ kind: "complex", re: 3, im: -4 })).toEqual({
      re: 3,
      im: -4,
    });
  });

  it("a polar value converts magnitude/phase to re/im via cos/sin", () => {
    const magnitude = 2;
    const phase = Math.PI / 2;
    const { re, im } = toRectangular({ kind: "complex", magnitude, phase });
    expect(re).toBeCloseTo(0, closeToPrecisionDigits);
    expect(im).toBeCloseTo(2, closeToPrecisionDigits);
  });

  it("a zero-magnitude polar value converts to the origin regardless of phase", () => {
    expect(
      toRectangular({ kind: "complex", magnitude: 0, phase: 1.23 }),
    ).toEqual({ re: 0, im: 0 });
  });
});

describe("ComplexRectangularSchema", () => {
  it("parses a rectangular value with and without an optional unit", () => {
    const withoutUnit = { kind: "complex", re: 1, im: 2 };
    const withUnit = { kind: "complex", re: 1, im: 2, unit: { m: 1 } };
    expect(ComplexRectangularSchema.parse(withoutUnit)).toEqual(withoutUnit);
    expect(ComplexRectangularSchema.parse(withUnit)).toEqual(withUnit);
  });

  it("rejects a missing im and a polar-shaped payload", () => {
    expect(
      ComplexRectangularSchema.safeParse({ kind: "complex", re: 1 }).success,
    ).toBe(false);
    expect(
      ComplexRectangularSchema.safeParse({
        kind: "complex",
        magnitude: 1,
        phase: 2,
      }).success,
    ).toBe(false);
  });
});

describe("ComplexPolarSchema", () => {
  it("parses a polar value with and without an optional unit", () => {
    const withoutUnit = { kind: "complex", magnitude: 1, phase: 2 };
    const withUnit = {
      kind: "complex",
      magnitude: 1,
      phase: 2,
      unit: { s: -1 },
    };
    expect(ComplexPolarSchema.parse(withoutUnit)).toEqual(withoutUnit);
    expect(ComplexPolarSchema.parse(withUnit)).toEqual(withUnit);
  });

  it("rejects a missing phase and a rectangular-shaped payload", () => {
    expect(
      ComplexPolarSchema.safeParse({ kind: "complex", magnitude: 1 }).success,
    ).toBe(false);
    expect(
      ComplexPolarSchema.safeParse({ kind: "complex", re: 1, im: 2 }).success,
    ).toBe(false);
  });
});

describe("ComplexValueSchema", () => {
  it("accepts a valid rectangular value", () => {
    const valid = { kind: "complex", re: 1, im: 2 };
    expect(ComplexValueSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a valid polar value", () => {
    const valid = { kind: "complex", magnitude: 1, phase: 2 };
    expect(ComplexValueSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a payload carrying both rectangular and polar fields at once", () => {
    expect(
      ComplexValueSchema.safeParse({
        kind: "complex",
        re: 1,
        im: 2,
        magnitude: 3,
        phase: 4,
      }).success,
    ).toBe(false);
  });

  it("rejects a payload carrying neither rectangular nor polar fields", () => {
    expect(ComplexValueSchema.safeParse({ kind: "complex" }).success).toBe(
      false,
    );
  });

  it("rejects a partial rectangular payload (re without im)", () => {
    expect(
      ComplexValueSchema.safeParse({ kind: "complex", re: 1 }).success,
    ).toBe(false);
  });

  it("rejects a mixed payload (one rectangular field, one polar field)", () => {
    expect(
      ComplexValueSchema.safeParse({ kind: "complex", re: 1, phase: 2 })
        .success,
    ).toBe(false);
  });
});
