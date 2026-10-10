import { parseRegex } from "trilean-regex";
import { describe, expect, it } from "vitest";
import {
  PortablePatternUnsupportedError,
  renderPostgresPattern,
  renderSqliteGlobPattern,
} from "./portable-pattern";

function postgres(pattern: string): string {
  return renderPostgresPattern(parseRegex(pattern));
}

function glob(pattern: string): string {
  return renderSqliteGlobPattern(parseRegex(pattern));
}

describe("renderPostgresPattern", () => {
  it("passes literals through unchanged", () => {
    expect(postgres("abc")).toBe("abc");
  });

  it("escapes a literal metacharacter", () => {
    expect(postgres("\\.")).toBe("\\.");
    expect(postgres("\\*")).toBe("\\*");
  });

  it("translates anchors, alternation, and quantifiers structurally", () => {
    expect(postgres("^a$")).toBe("^a$");
    expect(postgres("a|b")).toBe("a|b");
    expect(postgres("a*")).toBe("a*");
    expect(postgres("a+")).toBe("a+");
    expect(postgres("a?")).toBe("a?");
    expect(postgres("a{2,5}")).toBe("a{2,5}");
    expect(postgres("a{3}")).toBe("a{3}");
    expect(postgres("a{2,}")).toBe("a{2,}");
  });

  it("translates a character class directly, escaping ']'/'^'/'-'/'\\\\' inside it", () => {
    expect(postgres("[a-z]")).toBe("[a-z]");
    expect(postgres("[^abc]")).toBe("[^abc]");
    expect(postgres("[\\]]")).toBe("[\\]]");
    // '-' is trilean-regex's own leading/trailing-hyphen-is-literal convention (see trilean-regex's README), not a backslash escape -- '[-]' is the valid way to write a class containing just a hyphen.
    expect(postgres("[-]")).toBe("[\\-]");
  });

  it("translates '.' directly -- PostgreSQL's own '.' already matches a newline by default under '~'/'!~' (confirmed against a real server, see test/integration/postgres.test.ts)", () => {
    expect(postgres(".")).toBe(".");
  });

  it("wraps a grouped concatenation before quantifying it", () => {
    expect(postgres("(?:ab)*")).toBe("(?:ab)*");
    expect(postgres("(?:ab)+")).toBe("(?:ab)+");
  });

  it("wraps a grouped alternation before quantifying it", () => {
    expect(postgres("(?:a|b)*")).toBe("(?:a|b)*");
  });

  it("wraps a nested concat operand defensively, though associativity would make it safe not to", () => {
    expect(postgres("(?:ab)c")).toBe("(?:ab)c");
  });

  it("never wraps an alternation branch, flattening nested alternation instead", () => {
    // Alternation is associative, so a branch that is itself an alternation (produced by a group, e.g. '(?:a|b)|c') flattens to an equivalent, ungrouped rendering rather than needing its own parentheses.
    expect(postgres("(?:a|b)|c")).toBe("a|b|c");
  });

  it("refuses a bound exceeding PostgreSQL's 0-255 limit", () => {
    expect(() => postgres("a{256}")).toThrow(PortablePatternUnsupportedError);
    expect(() => postgres("a{2,256}")).toThrow(PortablePatternUnsupportedError);
  });

  it("accepts a bound exactly at PostgreSQL's limit", () => {
    expect(() => postgres("a{255}")).not.toThrow();
    expect(() => postgres("a{2,255}")).not.toThrow();
  });
});

describe("renderSqliteGlobPattern", () => {
  it("wraps an unanchored literal pattern in '*' on both sides", () => {
    expect(glob("abc")).toBe("*abc*");
  });

  it("adds no leading '*' when the pattern is start-anchored", () => {
    expect(glob("^abc")).toBe("abc*");
  });

  it("adds no trailing '*' when the pattern is end-anchored", () => {
    expect(glob("abc$")).toBe("*abc");
  });

  it("adds no wildcard on either side when the pattern is fully anchored", () => {
    expect(glob("^abc$")).toBe("abc");
  });

  it("translates '.' to '?' and a star of '.' to '*'", () => {
    expect(glob("^a.c$")).toBe("a?c");
    expect(glob("^a.*c$")).toBe("a*c");
  });

  it("escapes a literal wildcard character with a single-member bracket", () => {
    expect(glob("^a\\*c$")).toBe("a[*]c");
    expect(glob("^a\\?c$")).toBe("a[?]c");
    expect(glob("^a\\[c$")).toBe("a[[]c");
  });

  it("leaves a literal ']' unescaped, since it is never inside an open bracket", () => {
    expect(glob("^a\\]c$")).toBe("a]c");
  });

  it("translates a safe, non-negated character class directly", () => {
    expect(glob("^[a-z]$")).toBe("[a-z]");
    expect(glob("^[0-9a-f]$")).toBe("[0-9a-f]");
  });

  it("collapses adjacent '*' from an unanchored pattern that itself starts or ends with a '.*'", () => {
    expect(glob(".*abc")).toBe("*abc*");
    expect(glob("abc.*")).toBe("*abc*");
  });

  it("refuses a negated character class", () => {
    expect(() => glob("^[^a]$")).toThrow(PortablePatternUnsupportedError);
  });

  it("refuses a character class containing ']'/'^'/'-'/'[' as a member", () => {
    expect(() => glob("^[\\]]$")).toThrow(PortablePatternUnsupportedError);
    expect(() => glob("^[\\^]$")).toThrow(PortablePatternUnsupportedError);
    expect(() => glob("^[-]$")).toThrow(PortablePatternUnsupportedError);
  });

  it("refuses alternation", () => {
    expect(() => glob("a|b")).toThrow(PortablePatternUnsupportedError);
  });

  it("refuses bounded, optional, and one-or-more repetition", () => {
    expect(() => glob("a{2,3}")).toThrow(PortablePatternUnsupportedError);
    expect(() => glob("a?")).toThrow(PortablePatternUnsupportedError);
    expect(() => glob("a+")).toThrow(PortablePatternUnsupportedError);
  });

  it("refuses a star of anything other than '.'", () => {
    expect(() => glob("a*")).toThrow(PortablePatternUnsupportedError);
  });

  it("refuses an anchor that is not at the very start or end of the whole pattern", () => {
    expect(() => glob("a^b")).toThrow(PortablePatternUnsupportedError);
    expect(() => glob("a$b")).toThrow(PortablePatternUnsupportedError);
  });
});
