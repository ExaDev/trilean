import type * as RegexModule from "trilean-regex";
import type { CompiledPattern } from "trilean-regex";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compareText } from "./evaluator-operations";

/** The compiled patterns `trilean-regex` handed out and nobody has freed. */
const live = new Set<CompiledPattern>();
let compiledTotal = 0;
/** Stands in for `compilePattern` in a test of what the evaluator does with a module that fails. */
let replacement: ((pattern: string) => CompiledPattern) | undefined;

vi.mock("trilean-regex", async (importOriginal) => {
  const actual = await importOriginal<typeof RegexModule>();

  return {
    ...actual,
    compilePattern: (pattern: string): CompiledPattern => {
      if (replacement !== undefined) {
        return replacement(pattern);
      }
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
  replacement = undefined;
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

/** A compiled pattern whose test and free both throw, as a module that has panicked does. It is a real one, so its memory is released. */
async function spentPattern(
  testError: Error,
  freeError: Error,
): Promise<{ compiled: CompiledPattern; freed: () => number }> {
  const actual = await vi.importActual<typeof RegexModule>("trilean-regex");
  const compiled = actual.compilePattern("a");
  const release = compiled.free.bind(compiled);
  let freed = 0;
  compiled.test = () => {
    throw testError;
  };
  compiled.free = () => {
    freed += 1;
    release();
    throw freeError;
  };

  return { compiled, freed: () => freed };
}

describe("a portableMatches evaluation against a module that fails", () => {
  it("throws the error of the test, not the one of the free that follows it, and frees once", async () => {
    const first = new Error("the panic");
    const spent = await spentPattern(
      first,
      new Error("the trap after the panic"),
    );
    replacement = () => spent.compiled;
    expect(() =>
      compareText("portableMatches", text("x"), text("^x$")),
    ).toThrow(first);
    expect(spent.freed()).toBe(1);
  });

  it("throws what compilePattern throws unless it is a RegexParseError, rather than calling it a bad pattern", () => {
    const fault = new Error("the module is spent");
    replacement = () => {
      throw fault;
    };
    expect(() =>
      compareText("portableMatches", text("x"), text("^x$")),
    ).toThrow(fault);
  });
});
