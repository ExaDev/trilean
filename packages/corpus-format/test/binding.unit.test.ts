import { describe, expect, it } from "vitest";
import {
  Completeness,
  CorpusFormatError,
  DecodeError,
  checkCanonical,
  compare,
  decode,
  fragments,
  keyProblems,
  manifestProblems,
  select,
  subset,
  writeCanonical,
} from "../dist/index.js";
import { InternalError } from "../dist-test/index.js";
import * as hooked from "../dist-test/corpus_format.js";

/** What the binding promises beyond the Rust crate's own tests: arguments and results as JavaScript values, the error classes, text as UTF-16 code units, the memory lifecycle and the panic hook. They run in the Node runtime against the built package. */

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

describe("select", () => {
  it("returns the corpus files and the problems, in UTF-16 order", () => {
    expect(
      select(
        [
          { path: "pkg/area/b.json", kind: "file" },
          { path: "pkg/area/a.json", kind: "file" },
          { path: "pkg/area/Upper.json", kind: "file" },
          { path: "pkg/area/link.json", kind: "other" },
          { path: "fixtures/x.json", kind: "file" },
          { path: ".cache", kind: "directory" },
          { path: "manifest.json", kind: "file" },
        ],
        2,
      ),
    ).toEqual({
      files: ["pkg/area/a.json", "pkg/area/b.json"],
      problems: ["pkg/area/Upper.json", "pkg/area/link.json"],
    });
  });

  it("refuses an entry that is not of the declared form", () => {
    expect(() => select([{ path: "a", kind: "socket" }] as never, 2)).toThrow(
      TypeError,
    );
    expect(() => select("not an array" as never, 2)).toThrow(TypeError);
    expect(() => select([{ path: 1, kind: "file" }] as never, 2)).toThrow(
      TypeError,
    );
  });
});

describe("checkCanonical and keyProblems", () => {
  it("accepts canonical bytes and describes what is not", () => {
    expect(checkCanonical(bytes('{\n  "a": 1\n}\n'))).toBeUndefined();
    expect(checkCanonical(bytes('{"a":1}\n'))?.message).toContain(
      "not in canonical form",
    );
    expect(checkCanonical(bytes("97.0\n"))?.message).toContain("shortest");
    const marked = checkCanonical(new Uint8Array([0xef, 0xbb, 0xbf, 0x31]));
    expect(marked?.offset).toBe(0);
    expect(marked?.message).toContain("byte order mark");
    expect(checkCanonical(new Uint8Array([0x31, 0xff]))?.message).toContain(
      "UTF-8",
    );
  });

  it("lists every content problem of a document", () => {
    const problems = keyProblems(
      bytes('{\n  "b": 1,\n  "a": 97.0,\n  "a": "\\ud800"\n}\n'),
    );
    expect(problems).toHaveLength(4);
    expect(keyProblems(bytes('{\n  "a": 1\n}\n'))).toEqual([]);
  });

  it("orders keys by UTF-16 code unit, as a JavaScript sort does", () => {
    const keys = ["\u{1F600}", "\uE000", "10", "2"].sort();
    const text = `{\n${keys.map((key) => `  ${JSON.stringify(key)}: 1`).join(",\n")}\n}\n`;
    expect(checkCanonical(bytes(text))).toBeUndefined();
  });
});

describe("writeCanonical", () => {
  it("writes the form checkCanonical accepts", () => {
    const text = writeCanonical('{"b":[1,{"d":null,"c":"é\\n"}],"a":{}}');
    expect(text).toBe(
      '{\n  "a": {},\n  "b": [\n    1,\n    {\n      "c": "é\\n",\n      "d": null\n    }\n  ]\n}\n',
    );
    expect(checkCanonical(bytes(text))).toBeUndefined();
  });

  it("refuses a document nested past the limit of the reader, which could not be read back", () => {
    const deep = `${"[".repeat(65)}${"]".repeat(65)}`;
    expect(() => writeCanonical(deep)).toThrow(CorpusFormatError);
    expect(writeCanonical(`${"[".repeat(64)}${"]".repeat(64)}`)).toContain(
      "[]",
    );
  });

  it("throws a CorpusFormatError for text that is not JSON, and a TypeError for a value that is not text", () => {
    expect(() => writeCanonical("{")).toThrow(CorpusFormatError);
    expect(() => writeCanonical(1 as never)).toThrow(TypeError);
  });
});

describe("decode", () => {
  it("reads the closed set of encodings", () => {
    expect(Object.is(decode('{"$number":"-0"}'), -0)).toBe(true);
    expect(decode('{"$number":"Infinity"}')).toBe(Number.POSITIVE_INFINITY);
    expect(decode('{"$number":"-Infinity"}')).toBe(Number.NEGATIVE_INFINITY);
    expect(decode('{"$number":"NaN"}')).toBeNaN();
    expect(decode('{"$undefined":true}')).toBeUndefined();
    expect(decode('{"codeUnits":[97,55296]}')).toBe("a\uD800");
    expect(decode('{"a":[1,{"$number":"-0"}]}')).toEqual({ a: [1, -0] });
  });

  it("keeps the order of an ordered object", () => {
    const value = decode('{"$object":[["b",1],["a",{"$undefined":true}]]}');
    expect(Object.keys(value as object)).toEqual(["b", "a"]);
    expect(Object.hasOwn(value as object, "a")).toBe(true);
  });

  it("throws a DecodeError that names the place", () => {
    for (const text of [
      '{"$number":5}',
      '{"$bigint":"1"}',
      '{"$undefined":false}',
      '{"$number":"NaN","x":1}',
      '{"$object":[["1",null]]}',
      '{"$object":[["a",null],["a",null]]}',
      '{"codeUnits":[65536]}',
    ]) {
      expect(() => decode(text), text).toThrow(DecodeError);
    }
    try {
      decode('{"a":[{"$number":"x"}]}');
    } catch (error) {
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).path).toBe("$.a[0].$number");
    }
  });
});

describe("compare and subset", () => {
  it("compares numbers as the same double unless a tolerance is given", () => {
    expect(compare(1.5, 1.5, undefined)).toBeUndefined();
    expect(compare(-0, 0, undefined)).toMatchObject({ path: "$" });
    expect(compare(Number.NaN, Number.NaN, undefined)).toBeUndefined();
    expect(compare(1.01, 1, { absolute: 0.1 })).toBeUndefined();
    expect(compare(1.01, 1, undefined)).toBeDefined();
    expect(compare(1 + Number.EPSILON, 1, { ulps: 1 })).toBeUndefined();
    expect(compare(1 + 3 * Number.EPSILON, 1, { ulps: 1 })).toBeDefined();
  });

  it("treats an undefined member of the actual value as absent", () => {
    expect(
      compare({ a: 1, b: undefined }, { a: 1 }, undefined),
    ).toBeUndefined();
    expect(compare({ a: 1 }, { a: 1, b: 2 }, undefined)).toMatchObject({
      path: "$.b",
    });
    expect(
      compare({ a: undefined }, { a: undefined }, undefined),
    ).toBeUndefined();
    expect(compare({}, { a: undefined }, undefined)).toBeDefined();
  });

  it("names the place of a mismatch", () => {
    const mismatch = compare({ a: [1, 2] }, { a: [1, 3] }, undefined);
    expect(mismatch?.path).toBe("$.a[1]");
    expect(typeof mismatch?.message).toBe("string");
  });

  it("matches a subset of the members", () => {
    expect(subset({ a: 1, b: 2 }, { a: 1 }, undefined)).toBeUndefined();
    expect(subset({ a: 1 }, { b: 1 }, undefined)).toBeDefined();
    expect(subset([1, 2], [1], undefined)).toBeDefined();
  });

  it("compares strings by UTF-16 code unit, an unpaired surrogate included", () => {
    expect(compare("\uD800", "\uD800", undefined)).toBeUndefined();
    expect(compare("\uD800", "\uD801", undefined)).toBeDefined();
  });

  it("refuses a value that is not plain data, and a tolerance of the wrong form", () => {
    expect(() => compare(() => 1, 1, undefined)).toThrow(TypeError);
    expect(() => compare(1n, 1, undefined)).toThrow(TypeError);
    expect(() => compare(1, 1, { ulps: -1 })).toThrow(TypeError);
    expect(() => compare(1, 1, { absolute: 0 })).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => compare(cycle, cycle, undefined)).toThrow(TypeError);
  });
});

describe("fragments", () => {
  it("finds each fragment after the end of the one before", () => {
    expect(
      fragments("invalid pattern: anchors", ["invalid", "anchors"], false),
    ).toBeUndefined();
    expect(
      fragments("invalid pattern: anchors", ["anchors", "invalid"], false),
    ).toContain("does not occur");
    expect(fragments("Anchors", ["aNCHORS"], true)).toBeUndefined();
    expect(fragments("Anchors", ["aNCHORS"], false)).toBeDefined();
    expect(fragments("a", [""], false)).toContain("not empty");
  });

  it("counts UTF-16 code units", () => {
    expect(fragments("\u{1F600}a", ["\uDE00", "a"], false)).toBeUndefined();
  });
});

const MANIFEST = writeCanonical(
  JSON.stringify({
    files: {
      "pkg/area/file.json": {
        cases: 4,
        skip: { rust: ["c"], ts: ["b"] },
        requires: { "ecmascript-regex": ["d"] },
      },
    },
  }),
);

describe("manifestProblems", () => {
  const file = (cases: readonly unknown[]): unknown => ({
    name: "pkg/area/file.json",
    cases,
  });

  it("reports nothing for a corpus that is what the manifest says", () => {
    expect(
      manifestProblems(
        [
          file([
            { id: "a" },
            { id: "b", skip: "ts" },
            { id: "c", skip: "rust", requires: [] },
          ]),
        ] as never,
        writeCanonical(
          JSON.stringify({
            files: {
              "pkg/area/file.json": {
                cases: 3,
                skip: { rust: ["c"], ts: ["b"] },
              },
            },
          }),
        ),
        2,
      ),
    ).toEqual([]);
  });

  it("reports each way the corpus differs", () => {
    expect(
      manifestProblems(
        [file([{ id: "a" }, { id: "a" }])] as never,
        MANIFEST,
        2,
      ),
    ).not.toEqual([]);
  });

  it("refuses a manifest that names a file twice, and one whose files are at another depth than the corpus's", () => {
    const entry = '{"cases": 1, "skip": {"rust": [], "ts": []}}';
    const twice = `{\n  "files": {\n    "pkg/area/file.json": ${entry},\n    "pkg/area/file.json": ${entry}\n  }\n}\n`;
    expect(() => manifestProblems([], twice, 2)).toThrow(CorpusFormatError);
    expect(() => manifestProblems([], MANIFEST, 1)).toThrow(CorpusFormatError);
    expect(() => manifestProblems([], MANIFEST, 3)).toThrow(CorpusFormatError);
  });

  it("throws a CorpusFormatError for a manifest that is not well-formed and a TypeError for a corpus that is not", () => {
    expect(() => manifestProblems([], "{", 2)).toThrow(CorpusFormatError);
    expect(() => manifestProblems([], '{"files":{}}', 2)).toThrow(
      CorpusFormatError,
    );
    expect(() =>
      manifestProblems([{ name: 1, cases: [] }] as never, MANIFEST, 2),
    ).toThrow(TypeError);
    expect(() =>
      manifestProblems(
        [file([{ id: "a", requires: ["other"] }])] as never,
        MANIFEST,
        2,
      ),
    ).toThrow(CorpusFormatError);
  });
});

describe("Completeness", () => {
  function run(): Completeness {
    const completeness = new Completeness("pkg/");
    for (const id of ["a", "b", "c", "d"]) {
      completeness.register(id);
    }
    completeness.started("a");
    completeness.started("b");
    completeness.skipped("c", "marked");
    completeness.skipped("d", "needs ecmascript-regex");

    return completeness;
  }

  it("is empty for a complete run", () => {
    const completeness = run();
    try {
      expect(completeness.finish(MANIFEST, "rust", [], 2)).toEqual([]);
    } finally {
      completeness.free();
    }
  });

  it("fails a run that lost a registration, and says which", () => {
    const completeness = new Completeness("pkg/");
    for (const id of ["a", "b", "c"]) {
      completeness.register(id);
    }
    completeness.started("a");
    completeness.started("b");
    completeness.skipped("c", "marked");
    completeness.skipped("d", "needs ecmascript-regex");
    try {
      expect(completeness.finish(MANIFEST, "rust", [], 2)).toContain(
        "3 cases were registered, the manifest has 4",
      );
    } finally {
      completeness.free();
    }
  });

  it("is held to the list of the implementation it is a run of, and to what the implementation provides", () => {
    const completeness = new Completeness("pkg/");
    for (const id of ["a", "b", "c", "d"]) {
      completeness.register(id);
    }
    for (const id of ["a", "c", "d"]) {
      completeness.started(id);
    }
    completeness.skipped("b", "marked");
    try {
      expect(
        completeness.finish(MANIFEST, "ts", ["ecmascript-regex"], 2),
      ).toEqual([]);
      expect(completeness.finish(MANIFEST, "ts", [], 2)).not.toEqual([]);
      expect(() => completeness.finish(MANIFEST, "go" as never, [], 2)).toThrow(
        TypeError,
      );
      expect(() => completeness.finish(MANIFEST, "ts", ["other"], 2)).toThrow(
        CorpusFormatError,
      );
    } finally {
      completeness.free();
    }
  });

  it("frees its memory idempotently, so `free()` after `using` does not throw", () => {
    const completeness = new Completeness();
    completeness.free();
    expect(() => {
      completeness.free();
    }).not.toThrow();
  });
});

describe("the package surface", () => {
  it("offers no module loader and no hook that exists for the tests of the binding", async () => {
    const names = Object.keys(await import("../dist/index.js"));
    expect(names).not.toContain("registerErrorClasses");
    expect(names).not.toContain("panicForTesting");
    expect(names).not.toContain("initSync");
  });
});

describe("a panic in Rust", () => {
  it("is an InternalError with the panic's message, not a bare trap", () => {
    let thrown: unknown;
    try {
      hooked.panicForTesting();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InternalError);
    expect((thrown as InternalError).message).toContain("deliberate panic");
    expect((thrown as InternalError).message).toContain("lib.rs");
  });
});
