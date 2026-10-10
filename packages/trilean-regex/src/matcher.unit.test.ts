import { describe, expect, it } from "vitest";
import { testPattern } from "./matcher";

describe("literals and concatenation", () => {
  it("matches a literal substring anywhere in the input", () => {
    expect(testPattern("cat", "concatenate")).toBe(true);
    expect(testPattern("cat", "dog")).toBe(false);
  });

  it("matches the empty pattern against anything, including the empty string", () => {
    expect(testPattern("", "")).toBe(true);
    expect(testPattern("", "anything")).toBe(true);
  });
});

describe("anchors", () => {
  it("^ pins the match to the start of the string", () => {
    expect(testPattern("^cat", "catalogue")).toBe(true);
    expect(testPattern("^cat", "concatenate")).toBe(false);
  });

  it("$ pins the match to the end of the string", () => {
    expect(testPattern("cat$", "bobcat")).toBe(true);
    expect(testPattern("cat$", "catalogue")).toBe(false);
  });

  it("^...$ together require a full match", () => {
    expect(testPattern("^cat$", "cat")).toBe(true);
    expect(testPattern("^cat$", "cats")).toBe(false);
    expect(testPattern("^cat$", "bobcat")).toBe(false);
  });

  it("^ and $ inside an alternation branch apply only to that branch", () => {
    expect(testPattern("^a|z$", "abc")).toBe(true);
    expect(testPattern("^a|z$", "xyz")).toBe(true);
    expect(testPattern("^a|z$", "bcx")).toBe(false);
  });

  it("$ matches the position before a would-be next character, not a literal end marker", () => {
    expect(testPattern("^$", "")).toBe(true);
    expect(testPattern("^$", "x")).toBe(false);
  });
});

describe(".", () => {
  it("matches any single character", () => {
    expect(testPattern("a.c", "abc")).toBe(true);
    expect(testPattern("a.c", "a c")).toBe(true);
    expect(testPattern("a.c", "ac")).toBe(false);
  });
});

describe("alternation", () => {
  it("matches if any branch matches", () => {
    expect(testPattern("cat|dog", "I have a dog")).toBe(true);
    expect(testPattern("cat|dog", "I have a cat")).toBe(true);
    expect(testPattern("cat|dog", "I have a bird")).toBe(false);
  });

  it("supports more than two branches", () => {
    expect(testPattern("red|green|blue", "green")).toBe(true);
    expect(testPattern("red|green|blue", "yellow")).toBe(false);
  });
});

describe("groups", () => {
  it("groups for repetition", () => {
    expect(testPattern("(?:ab)+", "ababab")).toBe(true);
    expect(testPattern("^(?:ab)+$", "aba")).toBe(false);
  });

  it("groups for alternation precedence", () => {
    expect(testPattern("^a(?:b|c)d$", "abd")).toBe(true);
    expect(testPattern("^a(?:b|c)d$", "acd")).toBe(true);
    expect(testPattern("^a(?:b|c)d$", "aed")).toBe(false);
  });
});

describe("quantifiers", () => {
  it("* matches zero or more", () => {
    expect(testPattern("^ab*c$", "ac")).toBe(true);
    expect(testPattern("^ab*c$", "abc")).toBe(true);
    expect(testPattern("^ab*c$", "abbbbc")).toBe(true);
    expect(testPattern("^ab*c$", "abbbbx")).toBe(false);
  });

  it("+ matches one or more, never zero", () => {
    expect(testPattern("^ab+c$", "ac")).toBe(false);
    expect(testPattern("^ab+c$", "abc")).toBe(true);
    expect(testPattern("^ab+c$", "abbbbc")).toBe(true);
  });

  it("? matches zero or one", () => {
    expect(testPattern("^ab?c$", "ac")).toBe(true);
    expect(testPattern("^ab?c$", "abc")).toBe(true);
    expect(testPattern("^ab?c$", "abbc")).toBe(false);
  });

  it("{n} matches exactly n", () => {
    expect(testPattern("^a{3}$", "aaa")).toBe(true);
    expect(testPattern("^a{3}$", "aa")).toBe(false);
    expect(testPattern("^a{3}$", "aaaa")).toBe(false);
  });

  it("{n,} matches at least n", () => {
    expect(testPattern("^a{2,}$", "a")).toBe(false);
    expect(testPattern("^a{2,}$", "aa")).toBe(true);
    expect(testPattern("^a{2,}$", "aaaaaa")).toBe(true);
  });

  it("{n,m} matches between n and m inclusive", () => {
    expect(testPattern("^a{2,4}$", "a")).toBe(false);
    expect(testPattern("^a{2,4}$", "aa")).toBe(true);
    expect(testPattern("^a{2,4}$", "aaa")).toBe(true);
    expect(testPattern("^a{2,4}$", "aaaa")).toBe(true);
    expect(testPattern("^a{2,4}$", "aaaaa")).toBe(false);
  });

  it("{0} and {0,0} match only the empty repetition", () => {
    expect(testPattern("^a{0}$", "")).toBe(true);
    expect(testPattern("^a{0}$", "a")).toBe(false);
    expect(testPattern("^a{0,0}b$", "b")).toBe(true);
    expect(testPattern("^a{0,0}b$", "ab")).toBe(false);
  });

  it("bounded repetition composes with a group", () => {
    expect(testPattern("^(?:ab){2,3}$", "ababab")).toBe(true);
    expect(testPattern("^(?:ab){2,3}$", "ab")).toBe(false);
    expect(testPattern("^(?:ab){2,3}$", "abababab")).toBe(false);
  });
});

describe("character classes", () => {
  it("matches membership and its negation", () => {
    expect(testPattern("^[abc]$", "a")).toBe(true);
    expect(testPattern("^[abc]$", "d")).toBe(false);
    expect(testPattern("^[^abc]$", "d")).toBe(true);
    expect(testPattern("^[^abc]$", "a")).toBe(false);
  });

  it("matches a range", () => {
    expect(testPattern("^[a-z]+$", "hello")).toBe(true);
    expect(testPattern("^[a-z]+$", "Hello")).toBe(false);
  });

  it("matches a union of ranges and singles", () => {
    expect(testPattern("^[a-cx-z0]+$", "abcxyz0")).toBe(true);
    expect(testPattern("^[a-cx-z0]+$", "abcd")).toBe(false);
  });
});

describe("shorthand classes", () => {
  it("\\d matches ASCII digits only", () => {
    expect(testPattern("^\\d+$", "12345")).toBe(true);
    expect(testPattern("^\\d+$", "123a")).toBe(false);
  });

  it("\\D is the negation of \\d", () => {
    expect(testPattern("^\\D+$", "abc")).toBe(true);
    expect(testPattern("^\\D+$", "abc1")).toBe(false);
  });

  it("\\w matches word characters", () => {
    expect(testPattern("^\\w+$", "hello_123")).toBe(true);
    expect(testPattern("^\\w+$", "hello world")).toBe(false);
  });

  it("\\W is the negation of \\w", () => {
    expect(testPattern("^\\W+$", " -!")).toBe(true);
    expect(testPattern("^\\W+$", "a")).toBe(false);
  });

  it("\\s matches whitespace", () => {
    expect(testPattern("^a\\sb$", "a b")).toBe(true);
    expect(testPattern("^a\\sb$", "a\tb")).toBe(true);
    expect(testPattern("^a\\sb$", "ab")).toBe(false);
  });

  it("\\S is the negation of \\s", () => {
    expect(testPattern("^\\S+$", "hello")).toBe(true);
    expect(testPattern("^\\S+$", "he llo")).toBe(false);
  });

  it("embeds a positive shorthand class inside brackets", () => {
    expect(testPattern("^[\\da]+$", "1a2a3")).toBe(true);
    expect(testPattern("^[\\da]+$", "1ab")).toBe(false);
  });
});

describe("realistic composite patterns", () => {
  it("matches a simple email-shaped string", () => {
    const email = "^[\\w.]+@[\\w]+\\.[a-z]{2,}$";
    expect(testPattern(email, "person@example.com")).toBe(true);
    expect(testPattern(email, "not-an-email")).toBe(false);
  });

  it("matches a hex colour code", () => {
    const hex = "^#[0-9a-fA-F]{6}$";
    expect(testPattern(hex, "#1a2b3c")).toBe(true);
    expect(testPattern(hex, "#1a2b3g")).toBe(false);
    expect(testPattern(hex, "1a2b3c")).toBe(false);
  });

  it("matches a UK-style National Grid reference number shape", () => {
    const pattern = "^ENA-\\d{4,6}$";
    expect(testPattern(pattern, "ENA-12345")).toBe(true);
    expect(testPattern(pattern, "ENA-123")).toBe(false);
  });
});

describe("no catastrophic backtracking on adversarial input", () => {
  it("resolves a classically pathological nested-quantifier pattern instantly", () => {
    // A backtracking engine's runtime on `(a+)+b` against a run of `a`s with no trailing `b` is exponential in the run's length -- the textbook "evil regex" example. An NFA simulation's runtime is linear in it instead, by construction (see matcher.ts), so a run long enough to hang a backtracking engine for seconds still resolves within this generous ceiling here.
    const REPEAT_COUNT = 30;
    const TIME_CEILING_MS = 200;
    const pattern = "^(?:a+)+b$";
    const input = "a".repeat(REPEAT_COUNT) + "c";
    const start = performance.now();
    expect(testPattern(pattern, input)).toBe(false);
    expect(performance.now() - start).toBeLessThan(TIME_CEILING_MS);
  });
});

describe("reusing a compiled pattern", () => {
  it("gives the same answers as testPattern across many inputs", async () => {
    const { compilePattern } = await import("./matcher");
    const compiled = compilePattern("^[a-z]+\\d*$");
    expect(compiled.test("abc123")).toBe(true);
    expect(compiled.test("abc")).toBe(true);
    expect(compiled.test("123abc")).toBe(false);
  });
});
