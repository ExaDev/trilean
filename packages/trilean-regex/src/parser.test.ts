import { describe, expect, it } from "vitest";
import type { RegexNode } from "./ast";
import { RegexParseError } from "./errors";
import { parseRegex } from "./parser";

function lit(char: string): RegexNode {
  return { kind: "literal", codeUnit: char.charCodeAt(0) };
}

function concat(...operands: readonly RegexNode[]): RegexNode {
  return { kind: "concat", operands };
}

describe("literals and concatenation", () => {
  it("parses a bare literal", () => {
    expect(parseRegex("a")).toEqual(lit("a"));
  });

  it("parses a run of literals as a concat", () => {
    expect(parseRegex("abc")).toEqual(concat(lit("a"), lit("b"), lit("c")));
  });

  it("parses the empty pattern as an empty concat", () => {
    expect(parseRegex("")).toEqual({ kind: "concat", operands: [] });
  });

  it("unescapes every documented metacharacter escape", () => {
    for (const char of [
      ".",
      "*",
      "+",
      "?",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      "|",
      "^",
      "$",
      "\\",
      "/",
    ]) {
      expect(parseRegex(`\\${char}`)).toEqual(lit(char));
    }
  });

  it("unescapes control-character shorthands", () => {
    expect(parseRegex("\\n")).toEqual(lit("\n"));
    expect(parseRegex("\\t")).toEqual(lit("\t"));
    expect(parseRegex("\\r")).toEqual(lit("\r"));
    expect(parseRegex("\\f")).toEqual(lit("\f"));
    expect(parseRegex("\\v")).toEqual(lit("\v"));
  });

  it("rejects an unknown escape", () => {
    expect(() => parseRegex("\\q")).toThrow(RegexParseError);
    expect(() => parseRegex("\\q")).toThrow(/unknown escape/);
  });

  it("rejects a trailing backslash", () => {
    expect(() => parseRegex("a\\")).toThrow(/trailing backslash/);
  });

  it("treats an unescaped brace as literal when it is not a valid bound", () => {
    expect(parseRegex("a{b")).toEqual(concat(lit("a"), lit("{"), lit("b")));
    expect(parseRegex("{}")).toEqual(concat(lit("{"), lit("}")));
    expect(parseRegex("a{,5}")).toEqual(
      concat(lit("a"), lit("{"), lit(","), lit("5"), lit("}")),
    );
  });

  it("treats an unescaped closing paren or bracket at the top level as an error", () => {
    expect(() => parseRegex("a)")).toThrow(RegexParseError);
  });
});

describe(".", () => {
  it("parses to anyChar", () => {
    expect(parseRegex(".")).toEqual({ kind: "anyChar" });
  });
});

describe("anchors", () => {
  it("parses ^ and $ anywhere in the pattern", () => {
    expect(parseRegex("^a")).toEqual(concat({ kind: "anchorStart" }, lit("a")));
    expect(parseRegex("a$")).toEqual(concat(lit("a"), { kind: "anchorEnd" }));
    expect(parseRegex("^a$")).toEqual(
      concat({ kind: "anchorStart" }, lit("a"), { kind: "anchorEnd" }),
    );
  });

  it("allows an anchor inside an alternation branch", () => {
    expect(parseRegex("^a|b$")).toEqual({
      kind: "alternation",
      branches: [
        concat({ kind: "anchorStart" }, lit("a")),
        concat(lit("b"), { kind: "anchorEnd" }),
      ],
    });
  });

  it("rejects quantifying an anchor", () => {
    expect(() => parseRegex("^*")).toThrow(/anchor.*cannot be quantified/);
    expect(() => parseRegex("$+")).toThrow(/anchor.*cannot be quantified/);
  });
});

describe("alternation", () => {
  it("parses two branches", () => {
    expect(parseRegex("a|b")).toEqual({
      kind: "alternation",
      branches: [lit("a"), lit("b")],
    });
  });

  it("parses more than two branches into one flat alternation", () => {
    expect(parseRegex("a|b|c")).toEqual({
      kind: "alternation",
      branches: [lit("a"), lit("b"), lit("c")],
    });
  });

  it("allows an empty branch", () => {
    expect(parseRegex("a|")).toEqual({
      kind: "alternation",
      branches: [lit("a"), { kind: "concat", operands: [] }],
    });
    expect(parseRegex("|a")).toEqual({
      kind: "alternation",
      branches: [{ kind: "concat", operands: [] }, lit("a")],
    });
  });
});

describe("groups", () => {
  it("parses a non-capturing group as its inner expression", () => {
    expect(parseRegex("(?:ab)")).toEqual(concat(lit("a"), lit("b")));
  });

  it("groups for precedence against alternation", () => {
    expect(parseRegex("a(?:b|c)d")).toEqual(
      concat(
        lit("a"),
        { kind: "alternation", branches: [lit("b"), lit("c")] },
        lit("d"),
      ),
    );
  });

  it("rejects a capturing group", () => {
    expect(() => parseRegex("(a)")).toThrow(RegexParseError);
    expect(() => parseRegex("(a)")).toThrow(
      /capturing groups are not supported/,
    );
  });

  it("rejects an unterminated group", () => {
    expect(() => parseRegex("(?:ab")).toThrow(/expected '\)'/);
  });
});

describe("quantifiers", () => {
  it("parses *, +, ?", () => {
    expect(parseRegex("a*")).toEqual({ kind: "star", operand: lit("a") });
    expect(parseRegex("a+")).toEqual({ kind: "plus", operand: lit("a") });
    expect(parseRegex("a?")).toEqual({ kind: "optional", operand: lit("a") });
  });

  it("applies a quantifier to a preceding group", () => {
    expect(parseRegex("(?:ab)*")).toEqual({
      kind: "star",
      operand: concat(lit("a"), lit("b")),
    });
  });

  it("parses bounded repetition", () => {
    expect(parseRegex("a{3}")).toEqual({
      kind: "repeat",
      operand: lit("a"),
      min: 3,
      max: 3,
    });
    expect(parseRegex("a{2,}")).toEqual({
      kind: "repeat",
      operand: lit("a"),
      min: 2,
      max: undefined,
    });
    expect(parseRegex("a{2,5}")).toEqual({
      kind: "repeat",
      operand: lit("a"),
      min: 2,
      max: 5,
    });
  });

  it("rejects a backwards bound", () => {
    expect(() => parseRegex("a{5,2}")).toThrow(/backwards/);
  });

  it("rejects a dangling quantifier", () => {
    expect(() => parseRegex("*a")).toThrow(/nothing to repeat/);
    expect(() => parseRegex("+")).toThrow(/nothing to repeat/);
  });

  it("rejects stacking two quantifiers", () => {
    expect(() => parseRegex("a**")).toThrow(/cannot itself be quantified/);
    expect(() => parseRegex("a*+")).toThrow(/cannot itself be quantified/);
    expect(() => parseRegex("a*{2}")).toThrow(/cannot itself be quantified/);
  });
});

describe("character classes", () => {
  it("parses a simple class", () => {
    expect(parseRegex("[abc]")).toEqual({
      kind: "charClass",
      negated: false,
      ranges: [
        { from: "a".charCodeAt(0), to: "a".charCodeAt(0) },
        { from: "b".charCodeAt(0), to: "b".charCodeAt(0) },
        { from: "c".charCodeAt(0), to: "c".charCodeAt(0) },
      ],
    });
  });

  it("parses a negated class", () => {
    expect(parseRegex("[^abc]")).toMatchObject({
      kind: "charClass",
      negated: true,
    });
  });

  it("parses a range", () => {
    expect(parseRegex("[a-z]")).toEqual({
      kind: "charClass",
      negated: false,
      ranges: [{ from: "a".charCodeAt(0), to: "z".charCodeAt(0) }],
    });
  });

  it("rejects a reversed range", () => {
    expect(() => parseRegex("[z-a]")).toThrow(/reversed/);
  });

  it("treats a leading or trailing hyphen as literal", () => {
    expect(parseRegex("[-a]")).toEqual({
      kind: "charClass",
      negated: false,
      ranges: [
        { from: "-".charCodeAt(0), to: "-".charCodeAt(0) },
        { from: "a".charCodeAt(0), to: "a".charCodeAt(0) },
      ],
    });
    expect(parseRegex("[a-]")).toEqual({
      kind: "charClass",
      negated: false,
      ranges: [
        { from: "a".charCodeAt(0), to: "a".charCodeAt(0) },
        { from: "-".charCodeAt(0), to: "-".charCodeAt(0) },
      ],
    });
  });

  it("requires ']' to be escaped to appear literally inside a class", () => {
    expect(parseRegex("[\\]]")).toEqual({
      kind: "charClass",
      negated: false,
      ranges: [{ from: "]".charCodeAt(0), to: "]".charCodeAt(0) }],
    });
  });

  it("rejects an empty class", () => {
    expect(() => parseRegex("[]")).toThrow(/at least one item/);
    expect(() => parseRegex("[^]")).toThrow(/at least one item/);
  });

  it("rejects an unterminated class", () => {
    expect(() => parseRegex("[abc")).toThrow(/unterminated character class/);
  });

  it("embeds a positive shorthand class inside brackets", () => {
    expect(parseRegex("[\\da]")).toEqual({
      kind: "charClass",
      negated: false,
      ranges: [
        { from: "0".charCodeAt(0), to: "9".charCodeAt(0) },
        { from: "a".charCodeAt(0), to: "a".charCodeAt(0) },
      ],
    });
  });

  it("rejects embedding a negated shorthand class inside brackets", () => {
    expect(() => parseRegex("[\\Da]")).toThrow(/cannot be embedded/);
  });

  it("rejects a shorthand class as a range endpoint", () => {
    expect(() => parseRegex("[a-\\d]")).toThrow(/cannot be a range endpoint/);
  });
});

describe("shorthand classes as standalone atoms", () => {
  it("parses \\d, \\w, \\s and their negations", () => {
    for (const letter of ["d", "D", "w", "W", "s", "S"]) {
      const node = parseRegex(`\\${letter}`);
      expect(node.kind).toBe("charClass");
    }
  });
});

describe("error positions", () => {
  it("names the exact offending index", () => {
    try {
      parseRegex("ab\\q");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RegexParseError);
      expect((error as RegexParseError).index).toBe(2);
    }
  });
});
