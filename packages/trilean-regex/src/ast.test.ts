import { describe, expect, it } from "vitest";
import type { CharClassNode } from "./ast";
import { charClassMatches, rangeContains } from "./ast";

describe("rangeContains", () => {
  const range = { from: "A".charCodeAt(0), to: "F".charCodeAt(0) };

  it("includes both endpoints and everything between them", () => {
    expect(rangeContains(range, "A".charCodeAt(0))).toBe(true);
    expect(rangeContains(range, "F".charCodeAt(0))).toBe(true);
    expect(rangeContains(range, "C".charCodeAt(0))).toBe(true);
  });

  it("excludes values outside the range", () => {
    expect(rangeContains(range, "@".charCodeAt(0))).toBe(false);
    expect(rangeContains(range, "G".charCodeAt(0))).toBe(false);
  });
});

describe("charClassMatches", () => {
  const digits: CharClassNode = {
    kind: "charClass",
    negated: false,
    ranges: [{ from: "0".charCodeAt(0), to: "9".charCodeAt(0) }],
  };

  it("matches membership in the positive form", () => {
    expect(charClassMatches(digits, "5".charCodeAt(0))).toBe(true);
    expect(charClassMatches(digits, "a".charCodeAt(0))).toBe(false);
  });

  it("inverts membership when negated", () => {
    const notDigits: CharClassNode = { ...digits, negated: true };
    expect(charClassMatches(notDigits, "5".charCodeAt(0))).toBe(false);
    expect(charClassMatches(notDigits, "a".charCodeAt(0))).toBe(true);
  });

  it("unions multiple ranges", () => {
    const class1: CharClassNode = {
      kind: "charClass",
      negated: false,
      ranges: [
        { from: "a".charCodeAt(0), to: "c".charCodeAt(0) },
        { from: "x".charCodeAt(0), to: "z".charCodeAt(0) },
      ],
    };
    expect(charClassMatches(class1, "b".charCodeAt(0))).toBe(true);
    expect(charClassMatches(class1, "y".charCodeAt(0))).toBe(true);
    expect(charClassMatches(class1, "m".charCodeAt(0))).toBe(false);
  });
});
