import { fileURLToPath } from "node:url";
import { parseRegex } from "trilean-regex";
import {
  ComparisonOperatorSchema,
  ExpressionNodeSchema,
  MembershipOperatorSchema,
  PredicateNodeSchema,
  TextComparisonOperatorSchema,
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

/** The kinds a discriminated or plain union of node schemas defines. */
function kindsOf(schema: unknown): readonly string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!isRecord(value)) {
      return;
    }
    const { options, shape } = value;
    if (Array.isArray(options)) {
      options.forEach(visit);
    }
    if (
      isRecord(shape) &&
      isRecord(shape.kind) &&
      typeof shape.kind.value === "string"
    ) {
      found.add(shape.kind.value);
    }
  };
  visit(schema);

  return [...found];
}

describe("the operator by dialect matrix of sql-compile cases", () => {
  const admitted = compileCases.filter((testCase) => "sql" in testCase.expect);
  const rows: readonly (readonly [string, string])[] = [
    ...ComparisonOperatorSchema.options.map((op) => ["compare", op] as const),
    ...TextComparisonOperatorSchema.options.map(
      (op) => ["textCompare", op] as const,
    ),
    ...MembershipOperatorSchema.options.map((op) => ["memberOf", op] as const),
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
  const kinds = [
    ...new Set([
      ...kindsOf(PredicateNodeSchema),
      ...kindsOf(ExpressionNodeSchema),
      "complexLiteral",
    ]),
  ].sort();

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
      column.push(binding.column);
    }
    for (const collection of Object.values(collections ?? {})) {
      collectionTable.push(collection.table);
      for (const binding of Object.values(collection.columns)) {
        collectionColumn.push(binding.column);
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
