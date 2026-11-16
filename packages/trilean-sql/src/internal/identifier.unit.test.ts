import { describe, expect, it } from "vitest";
import { POSTGRES_IDENTIFIER_BYTES, identifierProblem } from "./identifier";

/**
 * PostgreSQL keeps at most 63 bytes of an identifier and cuts the rest silently, so a name past it is refused for that dialect, by bytes in UTF-8 and per dot-separated segment. SQLite has no such limit.
 */

/** What PostgreSQL documents: NAMEDATALEN is 64, so an identifier keeps 63 bytes. */
const DOCUMENTED_BYTES = 63;

/** A name far past the limit, to show the refusal does not depend on it. */
const FAR_PAST = 1000;

/** The length of a name the longest-segment test uses, and the number of bytes it has beyond a marker. */
const MARKER_NAME_BYTES = 86;
const MARKER_FILLER = MARKER_NAME_BYTES - "Marker".length;

/** A name of exactly `bytes` bytes in UTF-8, made of `unit`. */
function nameOf(bytes: number, unit: string): string {
  const width = new TextEncoder().encode(unit).length;

  return unit.repeat(bytes / width);
}

describe("the byte limit of a PostgreSQL identifier", () => {
  it("is the 63 bytes PostgreSQL documents", () => {
    expect(POSTGRES_IDENTIFIER_BYTES).toBe(DOCUMENTED_BYTES);
  });

  it.each(["column", "table"] as const)(
    "accepts a %s segment of exactly the limit and refuses one a byte over",
    (role) => {
      expect(
        identifierProblem(
          role,
          nameOf(POSTGRES_IDENTIFIER_BYTES, "a"),
          "postgres",
        ),
      ).toBe(undefined);
      expect(
        identifierProblem(
          role,
          `${nameOf(POSTGRES_IDENTIFIER_BYTES, "a")}a`,
          "postgres",
        ),
      ).toMatch(/64 bytes in UTF-8 and PostgreSQL keeps at most 63 bytes/u);
    },
  );

  it.each([
    ["two-byte", "é"],
    ["three-byte", "€"],
    ["four-byte", "😀"],
  ] as const)(
    "counts bytes and not characters: %s characters",
    (_label, unit) => {
      const width = new TextEncoder().encode(unit).length;
      expect(
        identifierProblem(
          "column",
          unit.repeat(Math.floor(POSTGRES_IDENTIFIER_BYTES / width)),
          "postgres",
        ),
      ).toBe(undefined);
      expect(
        identifierProblem(
          "column",
          unit.repeat(Math.floor(POSTGRES_IDENTIFIER_BYTES / width) + 1),
          "postgres",
        ),
      ).toMatch(/bytes in UTF-8/u);
    },
  );

  it("counts each dot-separated segment on its own", () => {
    const segment = nameOf(POSTGRES_IDENTIFIER_BYTES, "a");
    expect(
      identifierProblem(
        "column",
        `${segment}.${segment}.${segment}`,
        "postgres",
      ),
    ).toBe(undefined);
    expect(
      identifierProblem(
        "column",
        `${segment}.${segment}a.${segment}`,
        "postgres",
      ),
    ).toMatch(/64 bytes/u);
  });

  it("reports the longest segment and never repeats the name", () => {
    const name = `Marker${"x".repeat(MARKER_FILLER)}`;
    const problem = identifierProblem("table", name, "postgres");
    expect(problem).toMatch(
      new RegExp(`${String(MARKER_NAME_BYTES)} bytes`, "u"),
    );
    expect(problem).not.toContain("Marker");
  });

  it("is a rule of PostgreSQL only: SQLite carries a longer name", () => {
    expect(identifierProblem("column", "a".repeat(FAR_PAST), "sqlite")).toBe(
      undefined,
    );
  });
});
