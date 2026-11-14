import type * as RegexModule from "trilean-regex";
import type { CompiledPattern } from "trilean-regex";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compareText } from "./evaluator-operations";

/** The compiled patterns `trilean-regex` handed out and nobody has freed. */
const live = new Set<CompiledPattern>();
let compiledTotal = 0;

vi.mock("trilean-regex", async (importOriginal) => {
  const actual = await importOriginal<typeof RegexModule>();

  return {
    ...actual,
    compilePattern: (pattern: string): CompiledPattern => {
      const compiled = actual.compilePattern(pattern);
      const free = compiled.free.bind(compiled);
      compiledTotal += 1;
      live.add(compiled);
      compiled.free = () => {
        live.delete(compiled);
        free();
      };

      return compiled;
    },
  };
});

beforeEach(() => {
  live.clear();
  compiledTotal = 0;
});

const text = (value: string) => ({ kind: "text" as const, value });

describe("a portableMatches evaluation", () => {
  it.each(["portableMatches", "portableNotMatches"] as const)(
    "frees the pattern it compiled, so %s over many rows in one synchronous pass holds none",
    (op) => {
      const rows = 500;
      for (let row = 0; row < rows; row += 1) {
        compareText(op, text(`row ${String(row)}`), text("^row [0-9]+$"));
      }
      expect(compiledTotal).toBe(rows);
      expect(live.size).toBe(0);
    },
  );

  it("holds no pattern for an answer of false either", () => {
    compareText("portableMatches", text("x"), text("^y$"));
    expect(live.size).toBe(0);
  });

  it("compiles nothing for a pattern that is not in the grammar, and holds nothing", () => {
    const before = compiledTotal;
    const result = compareText("portableMatches", text("x"), text("(a"));
    expect(result.status).toBe("indeterminate");
    expect(compiledTotal).toBe(before);
    expect(live.size).toBe(0);
  });
});
