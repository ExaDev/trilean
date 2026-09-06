import { describe, expect, it } from "vitest";
import { charClassMatches } from "./ast";
import { expandShorthandClass } from "./shorthand-classes";

describe("expandShorthandClass", () => {
  it("\\d expands to the ASCII digit range", () => {
    const digits = expandShorthandClass("d");
    expect(digits.negated).toBe(false);
    expect(charClassMatches(digits, "5".charCodeAt(0))).toBe(true);
    expect(charClassMatches(digits, "a".charCodeAt(0))).toBe(false);
  });

  it("\\D negates \\d rather than owning its own range table", () => {
    const notDigits = expandShorthandClass("D");
    expect(notDigits.negated).toBe(true);
    expect(notDigits.ranges).toEqual(expandShorthandClass("d").ranges);
  });

  it("\\w matches letters, digits, and underscore only", () => {
    const word = expandShorthandClass("w");
    expect(charClassMatches(word, "a".charCodeAt(0))).toBe(true);
    expect(charClassMatches(word, "Z".charCodeAt(0))).toBe(true);
    expect(charClassMatches(word, "5".charCodeAt(0))).toBe(true);
    expect(charClassMatches(word, "_".charCodeAt(0))).toBe(true);
    expect(charClassMatches(word, " ".charCodeAt(0))).toBe(false);
    expect(charClassMatches(word, "-".charCodeAt(0))).toBe(false);
  });

  it("\\s matches the ASCII whitespace set", () => {
    const space = expandShorthandClass("s");
    for (const char of [" ", "\t", "\n", "\r", "\f", "\v"]) {
      expect(charClassMatches(space, char.charCodeAt(0))).toBe(true);
    }
    expect(charClassMatches(space, "a".charCodeAt(0))).toBe(false);
  });
});
