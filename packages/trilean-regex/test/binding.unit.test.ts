import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CompiledPattern,
  RegexInputError,
  RegexParseError,
  UnsupportedConstructError,
  charClassMatches,
  compileEcmascriptSubset,
  compilePattern,
  expandShorthandClass,
  parseRegex,
  rangeContains,
  testPattern,
} from "../dist/index.js";
import * as generated from "../dist/trilean_regex.js";
import { InternalError } from "../dist-test/index.js";
import * as hooked from "../dist-test/trilean_regex.js";

/** What the binding promises beyond the corpus: refusal before allocation, argument types, the memory lifecycle and the panic hook. They run in the Node runtime against the built package. */

const WASM_PAGE_BYTES = 65536;
/** The most the module's memory may grow while refusing the patterns below, in pages. A refused pattern allocates nothing proportional to its counts, so the allowance is for the parser's own tree and the error. */
const REFUSAL_GROWTH_PAGES = 64;

interface Instance {
  readonly memory: { readonly buffer: { readonly byteLength: number } };
}

function isStart(
  value: unknown,
): value is (options: { module: Uint8Array }) => Instance {
  return typeof value === "function";
}

/** The size of the module's memory in pages. The generated module's `initSync` is not part of the package's declarations, and returns the running instance's exports without starting another. */
function memoryPages(): number {
  const start: unknown = Reflect.get(generated, "initSync");
  if (!isStart(start)) {
    throw new Error("the generated module has no initSync");
  }

  return (
    start({ module: new Uint8Array() }).memory.buffer.byteLength /
    WASM_PAGE_BYTES
  );
}

describe("a pattern whose counts would need the automaton to be huge", () => {
  it.each([
    "a{4294967295}",
    "(?:a{65535}){65535}",
    "(?:a{1000}){1000}",
    "a{100000}",
    "(?:(?:a{100}){100}){100}",
  ])(
    "is refused as %j with a RegexParseError before any memory is asked for",
    (pattern) => {
      const before = memoryPages();
      for (const compile of [
        compilePattern,
        compileEcmascriptSubset,
        parseRegex,
      ]) {
        try {
          compile(pattern);
        } catch (error) {
          if (compile !== parseRegex) {
            expect(error).toBeInstanceOf(RegexParseError);
            expect((error as RegexParseError).message).toContain(
              "automaton states",
            );
          }
        }
      }
      expect(() => compilePattern(pattern)).toThrow(RegexParseError);
      expect(memoryPages() - before).toBeLessThanOrEqual(REFUSAL_GROWTH_PAGES);
      expect(compilePattern("a+").test("caab")).toBe(true);
    },
  );

  it("accepts a count at the limit", () => {
    // A subject as long as the pattern would take the bound of states times length in visits, which is not a thing to wait for.
    const compiled = compilePattern("a{99999}");
    expect(compiled.test("a".repeat(10))).toBe(false);
    compiled.free();
  });
});

describe("a call with an argument that is not a string", () => {
  const notStrings: readonly unknown[] = [
    123,
    {},
    [],
    null,
    undefined,
    true,
    Symbol("x"),
    new String("a+"),
  ];
  const calls: readonly [string, (value: never) => unknown][] = [
    ["parseRegex", parseRegex],
    ["compilePattern", compilePattern],
    ["compileEcmascriptSubset", compileEcmascriptSubset],
    ["testPattern pattern", (value) => testPattern(value, "a")],
    ["testPattern input", (value) => testPattern("a", value)],
    ["test", (value) => compilePattern("a").test(value)],
    ["expandShorthandClass", expandShorthandClass],
  ];
  it.each(calls)("throws a TypeError from %s", (_name, call) => {
    for (const value of notStrings) {
      expect(() => call(value as never), typeof value).toThrow(TypeError);
    }
  });
});

describe("a refusal of the ECMAScript subset", () => {
  it.each([
    [".", 0, "."],
    ["a\\s", 1, "\\s"],
    ["[\\s]", 1, "\\s"],
    ["x|{2}", 2, "{"],
  ] as const)(
    "is an UnsupportedConstructError with the index and the construct, for %j",
    (pattern, index, construct) => {
      try {
        compileEcmascriptSubset(pattern);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedConstructError);
        expect(error).toMatchObject({ index, construct });

        return;
      }
      throw new Error(`${pattern} compiled`);
    },
  );
});

describe("the class helpers", () => {
  it("answer for a negated shorthand and a range, and refuse a malformed one", () => {
    expect(charClassMatches(expandShorthandClass("D"), 53)).toBe(false);
    expect(charClassMatches(expandShorthandClass("D"), 97)).toBe(true);
    expect(rangeContains({ from: 1, to: 3 }, 3)).toBe(true);
    expect(rangeContains({ from: 1, to: 3 }, 4)).toBe(false);
    expect(rangeContains({ from: 1, to: 3 }, 1.5)).toBe(false);
    expect(() => rangeContains({ from: -1, to: 3 }, 1)).toThrow(TypeError);
  });
});

describe("the memory a compiled pattern holds", () => {
  it("is returned by free, which may be called any number of times", () => {
    const compiled = compilePattern("a+");
    compiled.free();
    expect(() => {
      compiled.free();
    }).not.toThrow();
    expect(() => compiled.test("a")).toThrow();
  });

  it("is freed by dispose after a free", () => {
    const compiled = compilePattern("a+");
    compiled.free();
    expect(() => {
      (compiled as unknown as { [Symbol.dispose]: () => void })[
        Symbol.dispose
      ]();
    }).not.toThrow();
  });

  it("does not grow the module's memory over many patterns freed after use", () => {
    const before = memoryPages();
    for (let count = 0; count < 20000; count += 1) {
      const compiled = compilePattern("^(?:a|ab)+c$");
      compiled.test("aabac");
      compiled.free();
    }
    expect(memoryPages() - before).toBeLessThanOrEqual(1);
    expect(compilePattern("a").test("a")).toBe(true);
  });

  it("is a class of the package", () => {
    expect(compilePattern("a")).toBeInstanceOf(CompiledPattern);
  });
});

describe("the published build", () => {
  it("does not carry the deliberate panic that only the tests of the binding call", () => {
    for (const file of ["trilean_regex.js", "trilean_regex.d.ts", "index.js"]) {
      expect(
        readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8"),
      ).not.toContain("panicForTesting");
    }
  });
});

/** How many pages the module's memory grows by while `source` runs, in a process of its own, so nothing an earlier test grew and freed hides it. */
function growthInFreshProcess(source: string): number {
  const entry = JSON.stringify(
    fileURLToPath(new URL("../dist/index.js", import.meta.url)),
  );
  const glue = JSON.stringify(
    fileURLToPath(new URL("../dist/trilean_regex.js", import.meta.url)),
  );
  const script = `import * as p from ${entry}; import * as g from ${glue};
const pages = () => g.initSync({ module: new Uint8Array() }).memory.buffer.byteLength / ${String(WASM_PAGE_BYTES)};
const before = pages();
${source}
console.log(pages() - before);`;

  return Number(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    }),
  );
}

describe("a pattern longer than the length limit", () => {
  it.each([400001, 500000, 2000000])(
    "of %i atoms is a RegexParseError that echoes none of it, and the module's memory does not grow",
    (atoms) => {
      const pattern = "a".repeat(atoms);
      expect(
        growthInFreshProcess(
          `for (const compile of [p.compilePattern, p.compileEcmascriptSubset, p.parseRegex]) { try { compile("a".repeat(${String(atoms)})); } catch {} }`,
        ),
      ).toBeLessThanOrEqual(1);
      for (const compile of [
        compilePattern,
        compileEcmascriptSubset,
        parseRegex,
      ]) {
        try {
          compile(pattern);
        } catch (error) {
          expect(error).toBeInstanceOf(RegexParseError);
          expect((error as RegexParseError).message).toContain(
            "code units long",
          );
          expect((error as RegexParseError).message.length).toBeLessThan(400);
          expect((error as RegexParseError).pattern).toBe(pattern);

          continue;
        }
        throw new Error("a pattern over the limit was read");
      }
      expect(compilePattern("a+").test("caab")).toBe(true);
    },
  );

  it.each([150000, 399999])(
    "within the limit but over the state limit, %i atoms, is a RegexParseError whose long message is built without overflowing the stack",
    (atoms) => {
      const pattern = "a".repeat(atoms);
      expect(() => compilePattern(pattern)).toThrow(RegexParseError);
      expect(() => compilePattern(pattern)).toThrow("automaton states");
      expect(compilePattern("a+").test("caab")).toBe(true);
    },
  );
});

describe("an input beyond a limit", () => {
  /** The largest pattern the state limit allows, which a thousand code units are over the work limit for. */
  const largest = "a{99999}";

  it("is refused at the work limit by the compiled pattern and by testPattern, one unit over and not one under", () => {
    const compiled = compilePattern(largest);
    expect(compiled.test("a".repeat(999))).toBe(false);
    expect(testPattern(largest, "a".repeat(999))).toBe(false);
    for (const refuse of [
      () => compiled.test("a".repeat(1000)),
      () => testPattern(largest, "a".repeat(1000)),
    ]) {
      expect(refuse).toThrow(RegexInputError);
      expect(refuse).toThrow("state visits");
    }
    expect(compilePattern("a+").test("caab")).toBe(true);
  });

  it("is refused at the length limit whatever the pattern, and the refusal echoes none of it", () => {
    const compiled = compilePattern("^a$");
    expect(compiled.test("a".repeat(1_000_000))).toBe(false);
    const input = "secret".repeat(200_000);
    let thrown: unknown;
    try {
      compiled.test(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegexInputError);
    expect((thrown as RegexInputError).message).toContain("1000000");
    expect((thrown as RegexInputError).message).not.toContain("secret");
    expect((thrown as RegexInputError).name).toBe("RegexInputError");
    expect(compiled.test("a")).toBe(true);
  });

  it("is refused before it is copied: the module's memory does not grow for a refused input", () => {
    const pages = memoryPages();
    for (let round = 0; round < 3; round += 1) {
      expect(() => compilePattern("a").test("a".repeat(20_000_000))).toThrow(
        RegexInputError,
      );
    }
    expect(memoryPages() - pages).toBeLessThanOrEqual(REFUSAL_GROWTH_PAGES);
  });
});

// Last in the file: a panic that throws from the hook never finishes unwinding, so the instance is spent afterwards.
describe("a panic in Rust", () => {
  it("is an InternalError with the panic's message, not a bare trap", () => {
    let thrown: unknown;
    try {
      hooked.panicForTesting();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InternalError);
    expect((thrown as InternalError).message).toContain(
      "deliberate panic for the test of the panic hook",
    );
    expect((thrown as InternalError).message).toContain("lib.rs");
  });
});
