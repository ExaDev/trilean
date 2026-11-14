import { describe, expect, it } from "vitest";
import {
  jsonEquals,
  subsetMatches,
  ulpDistance,
} from "./test-support/json-equal";
import { decodeNumbers } from "./test-support/values";

/**
 * The comparison rules the corpus README states for numbers, as the TypeScript runner applies them.
 */
const BOUND = 0.5;
const INSIDE = 1.4999;
const OUTSIDE = 1.5;
const NEAR = 1.0000000001;
const NANOS = 1e-9;
const HUGE = Number.MAX_VALUE;
const LARGE_BOUND = Number.MAX_VALUE;

describe("comparing numbers", () => {
  it("is exact without a tolerance, a negative zero included", () => {
    expect(jsonEquals(-0, 0)).toBe(false);
    expect(jsonEquals(0, { $number: "-0" })).toBe(false);
    expect(jsonEquals(-0, { $number: "-0" })).toBe(true);
    expect(jsonEquals(Number.NaN, { $number: "NaN" })).toBe(true);
  });

  it("holds an absolute tolerance strictly, so the bound itself is not within it", () => {
    expect(jsonEquals(OUTSIDE, 1, { absolute: BOUND })).toBe(false);
    expect(jsonEquals(INSIDE, 1, { absolute: BOUND })).toBe(true);
    expect(jsonEquals(1, 1, { absolute: 0 })).toBe(true);
  });

  it("compares a number that is not finite exactly, whatever the tolerance", () => {
    expect(
      jsonEquals(
        Number.POSITIVE_INFINITY,
        { $number: "Infinity" },
        { absolute: 1 },
      ),
    ).toBe(true);
    expect(jsonEquals(Number.NaN, { $number: "NaN" }, { absolute: 1 })).toBe(
      true,
    );
    expect(
      jsonEquals(HUGE, { $number: "Infinity" }, { absolute: LARGE_BOUND }),
    ).toBe(false);
    expect(
      jsonEquals(Number.MAX_VALUE, { $number: "Infinity" }, { ulps: 4 }),
    ).toBe(false);
    expect(jsonEquals(Number.NaN, 1, { ulps: 4 })).toBe(false);
  });

  it("counts representable doubles for ulps, both zeros being one point", () => {
    expect(ulpDistance(1, 1 + Number.EPSILON)).toBe(1);
    expect(ulpDistance(0, -0)).toBe(0);
    expect(ulpDistance(-Number.MIN_VALUE, Number.MIN_VALUE)).toBe(2);
    expect(jsonEquals(-0, 0, { ulps: 0 })).toBe(true);
    expect(jsonEquals(1 + 2 * Number.EPSILON, 1, { ulps: 1 })).toBe(false);
    expect(jsonEquals(1 + Number.EPSILON, 1, { ulps: 1 })).toBe(true);
  });

  it("applies a tolerance to every number in the compared value", () => {
    expect(
      jsonEquals(
        { a: [NEAR], b: { c: 2 } },
        { a: [1], b: { c: 2 } },
        { absolute: NANOS },
      ),
    ).toBe(true);
    expect(
      subsetMatches({ a: NEAR, z: 5 }, { a: 1 }, { absolute: NANOS }),
    ).toBe(true);
  });
});

describe("reading a number a corpus file names", () => {
  it("accepts only the four forms and refuses a name an object inherits", () => {
    expect(decodeNumbers({ $number: "-Infinity" })).toBe(
      Number.NEGATIVE_INFINITY,
    );
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(() => decodeNumbers({ $number: name })).toThrow();
    }
    expect(decodeNumbers({ $number: "NaN", other: 1 })).toEqual({
      $number: "NaN",
      other: 1,
    });
  });
});
