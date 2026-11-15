import { caseLimit } from "../../../corpus-time-limit";
import { fileURLToPath } from "node:url";
import { parseRegex } from "trilean-regex";
import {
  comparisonOperators,
  expressionKinds,
  membershipOperators,
  predicateKinds,
  textComparisonOperators,
} from "trilean";
import { describe, expect, it } from "vitest";
import {
  renderPostgresPattern,
  renderSqliteGlobPattern,
} from "./portable-pattern";
import { checkCorpus } from "./test-support/corpus";
import type {
  SqlCompileCase,
  SqlExecuteCase,
  SqlGuardCase,
  SqlPatternCase,
} from "./test-support/corpus-types";
import { textToString } from "./test-support/text";
import {
  evaluatorRows,
  mostEvaluationsAtOnce,
  setZone,
} from "../test/integration/corpus-engines";
import { readFixture } from "../test/integration/corpus-fixtures";
import { treeOf } from "./test-support/run-sql";

/**
 * What the sql corpus must cover, each class derived from something other than the corpus: the operators and node kinds from the trilean schemas, the characters a pattern renderer escapes from the renderers themselves, and the hostile shapes a number or an identifier can take from the lists below. A class with a member no case uses fails here, so a missing cell cannot go unnoticed.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../conformance/", import.meta.url),
);
const DIALECTS = ["postgres", "sqlite"] as const;
/** The printable ASCII range the renderers are asked about, space to tilde. */
const FIRST_PRINTABLE = 0x20;
const LAST_PRINTABLE = 0x7e;
/** A set of escaped characters smaller than this means the probe found almost nothing. */
const FEWEST_ESCAPED = 3;
/** The length of the longest identifier a case must hold. */
const LONG_NAME = 300;

const checked = checkCorpus(CORPUS_ROOT);
const cases = checked.files
  .filter(({ name }) => name.startsWith("trilean-sql/"))
  .flatMap(({ file }) => file.cases);
const compileCases = cases.filter(
  (testCase): testCase is SqlCompileCase => testCase.kind === "sql-compile",
);
const guardCases = cases.filter(
  (testCase): testCase is SqlGuardCase => testCase.kind === "sql-guard",
);
const patternCases = cases.filter(
  (testCase): testCase is SqlPatternCase => testCase.kind === "sql-pattern",
);
const executeCases = cases.filter(
  (testCase): testCase is SqlExecuteCase => testCase.kind === "sql-execute",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every object under a value, the value itself included. */
function nodesOf(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(nodesOf);
  }
  if (!isRecord(value)) {
    return [];
  }

  return [value, ...Object.values(value).flatMap(nodesOf)];
}

function dialectOf(testCase: {
  readonly options?: { readonly dialect: string };
}): string {
  return testCase.options?.dialect ?? "postgres";
}

describe("the operator by dialect matrix of sql-compile cases", () => {
  const admitted = compileCases.filter((testCase) => "sql" in testCase.expect);
  const rows: readonly (readonly [string, string])[] = [
    ...comparisonOperators.map((op) => ["compare", op] as const),
    ...textComparisonOperators.map((op) => ["textCompare", op] as const),
    ...membershipOperators.map((op) => ["memberOf", op] as const),
  ];

  it.each(
    rows.flatMap(([kind, op]) => DIALECTS.map((d) => [kind, op, d] as const)),
  )("has an exact fragment for %s %s under %s", (kind, op, dialect) => {
    expect(
      admitted.filter(
        (testCase) =>
          dialectOf(testCase) === dialect &&
          nodesOf(testCase.tree).some(
            (node) => node.kind === kind && node.op === op,
          ),
      ).length,
    ).toBeGreaterThan(0);
  });

  it.each(DIALECTS)(
    "has an exact fragment for every other node kind a tree compiles to under %s",
    (dialect) => {
      for (const kind of [
        "not",
        "and",
        "or",
        "allOf",
        "anyOf",
        "exists",
        "some",
        "every",
        "fold",
        "reference",
        "numberLiteral",
        "textLiteral",
        "booleanLiteral",
        "instantLiteral",
      ]) {
        expect(
          admitted.some(
            (testCase) =>
              dialectOf(testCase) === dialect &&
              nodesOf(testCase.tree).some((node) => node.kind === kind),
          ),
          `${kind} under ${dialect}`,
        ).toBe(true);
      }
    },
  );
});

describe("the guard, on each side of the line, for every node kind", () => {
  /** Kinds the guard always refuses, which need a refusal at that node. */
  const REFUSED = new Set([
    "treeReference",
    "durationLiteral",
    "complexLiteral",
    "arithmetic",
    "negate",
    "call",
    "lookup",
    "conditional",
    "accumulator",
    "delegate",
  ]);
  /** Kinds the guard admits in one form and refuses in another, which need both. */
  const BOTH = new Set([
    "reference",
    "numberLiteral",
    "compare",
    "textCompare",
    "memberOf",
    "some",
    "every",
    "fold",
  ]);
  /** Kinds the guard admits whenever what is inside them is admitted. */
  const ADMITTED = new Set([
    "not",
    "and",
    "or",
    "allOf",
    "anyOf",
    "exists",
    "textLiteral",
    "booleanLiteral",
    "instantLiteral",
  ]);
  const kinds = [...new Set([...predicateKinds, ...expressionKinds])].sort();

  it("classifies every node kind the trilean schemas define, and no other", () => {
    const classified = [...REFUSED, ...BOTH, ...ADMITTED].sort();
    expect(kinds).toEqual(classified);
  });

  const hasKind = (testCase: SqlGuardCase, kind: string): boolean =>
    nodesOf(testCase.tree).some((node) => node.kind === kind);
  const admits = (testCase: SqlGuardCase): boolean => testCase.expect === null;
  const refusesAt = (testCase: SqlGuardCase, kind: string): boolean =>
    testCase.expect !== null &&
    "nodeKind" in testCase.expect &&
    testCase.expect.nodeKind === kind;

  it.each(kinds.flatMap((kind) => DIALECTS.map((d) => [kind, d] as const)))(
    "%s has the cases its class needs under %s",
    (kind, dialect) => {
      const here = guardCases.filter(
        (testCase) => dialectOf(testCase) === dialect,
      );
      const sides = {
        admitted: here.some(
          (testCase) => admits(testCase) && hasKind(testCase, kind),
        ),
        refused: here.some((testCase) => refusesAt(testCase, kind)),
      };
      if (REFUSED.has(kind)) {
        expect(sides.refused, `a refusal of ${kind}`).toBe(true);
      } else if (BOTH.has(kind)) {
        expect(sides, `both sides of ${kind}`).toEqual({
          admitted: true,
          refused: true,
        });
      } else {
        expect(sides.admitted, `an admission of ${kind}`).toBe(true);
      }
    },
  );

  it.each(DIALECTS)(
    "covers each regular expression option, set and unset, under %s",
    (dialect) => {
      const here = guardCases.filter(
        (testCase) => dialectOf(testCase) === dialect,
      );
      const flag =
        dialect === "postgres"
          ? "postgresRegexpPushdown"
          : "sqliteRegexpAvailable";
      for (const value of [true, false, undefined]) {
        expect(
          here.filter((testCase) => testCase.options?.[flag] === value).length,
          `${flag} ${String(value)}`,
        ).toBeGreaterThan(0);
      }
      for (const withCollections of [true, false]) {
        expect(
          here.filter(
            (testCase) =>
              (testCase.options?.collections !== undefined) === withCollections,
          ).length,
          `collections ${String(withCollections)}`,
        ).toBeGreaterThan(0);
      }
    },
  );
});

describe("the characters a pattern renderer escapes", () => {
  const PRINTABLE = Array.from(
    { length: LAST_PRINTABLE - FIRST_PRINTABLE + 1 },
    (_, index) => String.fromCodePoint(FIRST_PRINTABLE + index),
  );

  /** The characters whose rendering of the literal `\c` differs from the character itself, found by asking the renderer. */
  function escaped(
    render: (pattern: string) => string,
    pattern: (c: string) => string,
    plain: (c: string) => string,
  ): readonly string[] {
    // Letters and digits after a backslash are classes and escapes (`\d`, `\n`), which the parser expands and no renderer escapes.
    return PRINTABLE.filter((c) => !/[A-Za-z0-9]/u.test(c)).filter((c) => {
      try {
        return render(pattern(c)) !== plain(c);
      } catch {
        return false;
      }
    });
  }
  /** A hyphen written first is the one a class holds literally, the others take a backslash. */
  const classMember = (c: string): string => (c === "-" ? "[-x]" : `[\\${c}x]`);
  const postgres = (pattern: string): string =>
    renderPostgresPattern(parseRegex(pattern));
  const glob = (pattern: string): string =>
    renderSqliteGlobPattern(parseRegex(pattern));
  const sets = {
    "PostgreSQL literals": escaped(
      postgres,
      (c) => `a\\${c}b`,
      (c) => `a${c}b`,
    ),
    "PostgreSQL class members": escaped(
      postgres,
      classMember,
      (c) => `[${c}x]`,
    ),
    "GLOB literals": escaped(
      glob,
      (c) => `^a\\${c}b$`,
      (c) => `a${c}b`,
    ),
  };

  it("has found some characters in each set, so that the probe is not vacuous", () => {
    for (const [name, set] of Object.entries(sets)) {
      expect(set.length, name).toBeGreaterThanOrEqual(FEWEST_ESCAPED);
    }
  });

  const patternsOf = (dialect: string): readonly string[] =>
    patternCases
      .filter((testCase) => testCase.dialect === dialect)
      .map((testCase) => textToString(testCase.pattern));

  it.each(sets["PostgreSQL literals"])(
    "has a PostgreSQL pattern case for the literal %s",
    (c) => {
      expect(patternsOf("postgres")).toContain(`a\\${c}b`);
    },
  );
  it.each(sets["PostgreSQL class members"])(
    "has a PostgreSQL pattern case for the class member %s",
    (c) => {
      expect(
        patternsOf("postgres").some(
          (pattern) =>
            pattern === `[\\${c}x]` ||
            pattern === `[${c}x]` ||
            pattern === `[\\${c}]`,
        ),
      ).toBe(true);
    },
  );
  it.each(sets["GLOB literals"])(
    "has a GLOB pattern case for the literal %s",
    (c) => {
      expect(patternsOf("sqlite")).toContain(`a\\${c}b`);
    },
  );

  it.each(DIALECTS)(
    "has a portableMatches and a portableNotMatches fragment for every escaped literal under %s",
    (dialect) => {
      const set =
        dialect === "postgres"
          ? sets["PostgreSQL literals"]
          : sets["GLOB literals"];
      const operators = (c: string): readonly (string | undefined)[] =>
        compileCases
          .filter(
            (testCase) =>
              dialectOf(testCase) === dialect && "sql" in testCase.expect,
          )
          .flatMap((testCase) =>
            nodesOf(testCase.tree).flatMap((node) =>
              isRecord(node.right) && node.right.value === `a\\${c}b`
                ? [typeof node.op === "string" ? node.op : undefined]
                : [],
            ),
          );
      for (const c of set) {
        expect(
          ["portableMatches", "portableNotMatches"].filter((op) =>
            operators(c).includes(op),
          ),
          `${c} under ${dialect}`,
        ).toEqual(["portableMatches", "portableNotMatches"]);
      }
    },
  );
});

describe("numbers", () => {
  const values = new Set<string>();
  for (const testCase of compileCases) {
    for (const node of nodesOf(testCase.tree)) {
      if (node.kind === "numberLiteral") {
        values.add(JSON.stringify(node.value));
      }
    }
  }
  const required: readonly [string, string][] = [
    ["a fraction", "0.5"],
    ["a negative fraction", "-1.5"],
    ["a decimal that is not exact in binary", "0.1"],
    ["negative zero", '{"$number":"-0"}'],
    ["zero", "0"],
    ["2 to the 53", "9007199254740992"],
    ["a value beyond 2 to the 53", "9007199254740994"],
    ["a negative value beyond 2 to the 53", "-9007199254740994"],
    ["2 to the 63", "9223372036854776000"],
    ["minus 2 to the 63", "-9223372036854776000"],
    ["a large exponent", "1e+21"],
    ["a small exponent", "1e-7"],
    ["the smallest positive double", "5e-324"],
    ["the largest double", "1.7976931348623157e+308"],
    ["positive infinity", '{"$number":"Infinity"}'],
    ["negative infinity", '{"$number":"-Infinity"}'],
    ["not a number", '{"$number":"NaN"}'],
  ];

  it.each(
    required.flatMap(([name, value]) =>
      DIALECTS.map((d) => [name, d, value] as const),
    ),
  )("has %s as a literal under %s", (_name, dialect, value) => {
    expect(
      compileCases.some(
        (testCase) =>
          dialectOf(testCase) === dialect &&
          nodesOf(testCase.tree).some(
            (node) =>
              node.kind === "numberLiteral" &&
              JSON.stringify(node.value) === value,
          ),
      ),
    ).toBe(true);
  });

  it.each(DIALECTS)(
    "has execute cases over fractions, negatives and large values under %s",
    (dialect) => {
      const here = executeCases.filter(
        (testCase) =>
          testCase.dialect === dialect && testCase.fixture === "numbers",
      );
      for (const value of [
        "0.5",
        "-1.5",
        "9007199254740994",
        "1e+21",
        '{"$number":"Infinity"}',
      ]) {
        expect(
          here.some((testCase) =>
            nodesOf(testCase.run).some(
              (node) =>
                node.kind === "numberLiteral" &&
                JSON.stringify(node.value) === value,
            ),
          ),
          value,
        ).toBe(true);
      }
    },
  );
});

describe("identifiers", () => {
  const SHAPES: readonly [string, (name: string) => boolean][] = [
    ["an embedded double quote", (name) => name.includes('"')],
    ["a backslash", (name) => name.includes("\\")],
    ["a newline", (name) => name.includes("\n")],
    ["a carriage return", (name) => name.includes("\r")],
    ["a tab", (name) => name.includes("\t")],
    ["a dot between segments", (name) => /^[^.]+\.[^.]+$/u.test(name)],
    ["a leading digit", (name) => /^\d/u.test(name)],
    ["a reserved word", (name) => name === "select"],
    ["an empty name", (name) => name === ""],
    ["an empty segment", (name) => name === "a..b"],
    ["a very long name", (name) => name.length >= LONG_NAME],
    [
      "a name outside the basic multilingual plane",
      (name) => /[\u{10000}-\u{10ffff}]/u.test(name),
    ],
    ["a single quote", (name) => name.includes("'")],
    ["a percent sign", (name) => name === "%"],
    ["an underscore", (name) => name === "_"],
  ];

  /** The identifiers a case's options hand the compiler, by the position they are used in. */
  function identifiers(testCase: SqlCompileCase): Record<string, string[]> {
    const column: string[] = [];
    const collectionColumn: string[] = [];
    const collectionTable: string[] = [];
    const { columns, collections } = testCase.options;
    for (const binding of Object.values(columns ?? {})) {
      column.push(textToString(binding.column));
    }
    for (const collection of Object.values(collections ?? {})) {
      collectionTable.push(textToString(collection.table));
      for (const binding of Object.values(collection.columns)) {
        collectionColumn.push(textToString(binding.column));
      }
    }

    return { column, collectionColumn, collectionTable };
  }

  it.each(
    SHAPES.flatMap(([shape, test]) =>
      DIALECTS.flatMap((d) =>
        ["column", "collectionColumn", "collectionTable"].map(
          (position) => [shape, d, position, test] as const,
        ),
      ),
    ),
  )(
    "has %s under %s as the %s of an identifier",
    (_shape, dialect, position, test) => {
      expect(
        compileCases.some(
          (testCase) =>
            dialectOf(testCase) === dialect &&
            (identifiers(testCase)[position] ?? []).some(test),
        ),
      ).toBe(true);
    },
  );
});

describe("the instant cases would tell a wrong comparison from a right one", () => {
  /** Fewer distinct row sets than this among the SQLite instant comparisons would mean the stored forms and parameters are too alike to tell a wrong comparison from a right one. */
  const DISTINCT_ROW_SETS = 8;
  /** The number of stored values outside the grammar the fixture must hold at least, so a list emptied by an edit fails. */
  const MINIMUM_REJECTED_FORMS = 30;
  const instants = executeCases.filter(
    (testCase) =>
      testCase.dialect === "sqlite" && testCase.fixture === "moments",
  );

  it("select different rows for different instants, so agreement is not agreement on nothing", () => {
    const rowSets = new Set(
      instants.map((testCase) =>
        "rows" in testCase.expect ? testCase.expect.rows.join() : "",
      ),
    );
    expect(rowSets.size).toBeGreaterThan(DISTINCT_ROW_SETS);
  });

  it("have stored values outside the grammar to leave out, and values inside it to select", () => {
    const fixture = readFixture("rejected-moments");
    const rows =
      fixture.tables.find(({ name }) => name === "rejected")?.rows ?? [];
    const ids = rows.map(({ id }) => (typeof id === "string" ? id : ""));
    const inside = ids.filter((id) => id.startsWith("in-grammar"));
    expect(rows.length - inside.length).toBeGreaterThan(MINIMUM_REJECTED_FORMS);
    expect(inside.length).toBeGreaterThan(0);
    const selected = executeCases
      .filter((testCase) => testCase.fixture === "rejected-moments")
      .flatMap((testCase) =>
        "rows" in testCase.expect ? testCase.expect.rows : [],
      );
    expect(new Set(selected)).toEqual(new Set(inside));
  });
});

describe("a harness exception is never recorded in place of a behaviour", () => {
  /** The cases that are about the exception itself: the options' callback throws for a key it does not map, and the error must reach the caller unchanged. */
  const ABOUT_CALLBACKS = /\bcolumnFor\b/u;

  it("holds no case that expects an unmapped reference key unless it is about the callback", () => {
    const offending = [...compileCases, ...guardCases]
      .filter((testCase) => {
        const { expect: expected } = testCase;
        const error =
          expected !== null && "error" in expected ? expected.error : undefined;

        return (
          error?.name === "CallerError" &&
          error.message.includes("no column mapped for reference key") &&
          !ABOUT_CALLBACKS.test(testCase.from)
        );
      })
      .map((testCase) => testCase.id);
    expect(offending).toEqual([]);
  });
});

describe("the ids the evaluator selects do not depend on the zone of the host", () => {
  /** How many evaluations the overlap test starts at once. */
  const OVERLAPPING = 12;
  /** The zones the evaluation is repeated in, away from UTC in both directions. */
  const ZONES = ["America/New_York", "Asia/Tokyo"] as const;
  const stated = executeCases.filter(
    (testCase) =>
      (testCase.expectEvaluator !== undefined ||
        testCase.expectEvaluatorLenient !== undefined) &&
      "tree" in testCase.run,
  );

  it("has cases whose evaluator rows are stated", () => {
    expect(stated.length).toBeGreaterThan(0);
  });

  it("is a test that could fail: a stored instant with no zone reads differently away from UTC", () => {
    const read = (zone: string): number => {
      const restore = setZone(zone);
      try {
        return Date.parse("2020-01-01T00:00:00");
      } finally {
        restore();
      }
    };
    const inUtc = read("UTC");
    expect(ZONES.every((zone) => read(zone) !== inUtc)).toBe(true);
  });

  it("runs the evaluations one at a time and leaves the zone of the process as it found it", async () => {
    const reading = (): number => Date.parse("2020-01-01T00:00:00");
    const restore = setZone("Asia/Tokyo");
    try {
      const before = { zone: process.env.TZ, time: reading() };
      await Promise.all(
        stated
          .slice(0, OVERLAPPING)
          .map(async (testCase) =>
            evaluatorRows(
              readFixture(testCase.fixture),
              treeOf("tree" in testCase.run ? testCase.run.tree : null),
            ),
          ),
      );
      expect({ zone: process.env.TZ, time: reading() }).toEqual(before);
      expect(mostEvaluationsAtOnce()).toBe(1);
    } finally {
      restore();
    }
  });

  it.each(ZONES)(
    "selects the recorded ids when the host zone is %s",
    async (zone) => {
      const restore = setZone(zone);
      try {
        const mismatched = (
          await Promise.all(
            stated.map(async (testCase) => {
              const rows = await evaluatorRows(
                readFixture(testCase.fixture),
                treeOf("tree" in testCase.run ? testCase.run.tree : null),
              );

              return JSON.stringify(rows) ===
                JSON.stringify(
                  testCase.expectEvaluator ?? testCase.expectEvaluatorLenient,
                )
                ? undefined
                : testCase.id;
            }),
          )
        ).filter((id) => id !== undefined);
        expect(mismatched).toEqual([]);
      } finally {
        restore();
      }
    },
    caseLimit({ cases: stated.length }),
  );
});
