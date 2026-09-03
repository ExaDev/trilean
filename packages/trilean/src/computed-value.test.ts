import { describe, expect, it } from "vitest";
import { ComputedValueSchema } from "./computed-value";

describe("the complex computed-value kind", () => {
  it("parses with and without an optional unit", () => {
    const withoutUnit = { kind: "complex", re: 3, im: 4 };
    const withUnit = { kind: "complex", re: 3, im: 4, unit: { V: 1, A: -1 } };
    expect(ComputedValueSchema.parse(withoutUnit)).toEqual(withoutUnit);
    expect(ComputedValueSchema.parse(withUnit)).toEqual(withUnit);
  });

  it("rejects a value carrying only one of the two components", () => {
    expect(
      ComputedValueSchema.safeParse({ kind: "complex", re: 3 }).success,
    ).toBe(false);
    expect(
      ComputedValueSchema.safeParse({ kind: "complex", im: 4 }).success,
    ).toBe(false);
  });
});
