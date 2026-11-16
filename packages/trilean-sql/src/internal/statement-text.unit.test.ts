import { describe, expect, it } from "vitest";
import { statementTextProblem } from "./identifier";

/**
 * SQL text a caller wrote and the compiler writes into the statement as given is refused for the two classes a name is refused for, and for nothing else.
 */
describe("the SQL text of a join", () => {
  it.each([
    ["a NUL at the start", "\u0000a = b", /NUL character/u],
    ["a NUL in the middle", "a = \u0000b", /NUL character/u],
    ["a NUL at the end", "a = b\u0000", /NUL character/u],
    ["an unpaired high surrogate", "a = '\ud800'", /unpaired surrogate/u],
    ["an unpaired low surrogate", "a = '\udc00'", /unpaired surrogate/u],
  ])("is refused for %s", (_label, text, reason) => {
    expect(statementTextProblem(text)).toMatch(reason);
  });

  it.each([
    ["plain SQL", '"t"."k" = "o"."id"'],
    ["a quote, a semicolon and a comment", "a = 'x'; -- c"],
    ["a line break and a tab", "a = b\nAND\tc = d"],
    ["a well formed pair", "a = '😀'"],
    ["other control characters", "a = '\u0001\u001f\u007f'"],
  ])("is carried: %s", (_label, text) => {
    expect(statementTextProblem(text)).toBe(undefined);
  });

  it("never repeats the text", () => {
    expect(statementTextProblem("Marker\u0000")).not.toContain("Marker");
    expect(statementTextProblem("Marker\ud800")).not.toContain("Marker");
  });
});
