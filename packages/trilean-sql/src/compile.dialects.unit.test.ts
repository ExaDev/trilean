import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "./compile";
import { UnknownDialectError, UnsupportedNodeError } from "./errors";
import { findUnpushableNodeKind } from "./guard";
import type { SqlCompileOptions, SqlDialect } from "./options";
import {
  sqliteSubjectOptions,
  subjectOptionsWithPostgresRegexp,
} from "./test-support/columns";
import {
  ADULT_AGE,
  ageOver,
  compile,
  EXCLUDED_AGE,
  LOWER_BOUND,
} from "./compile-test-helpers";

describe("the sqlite dialect", () => {
  function compileSqlite(node: PredicateNode) {
    return compile(node, sqliteSubjectOptions);
  }

  it("renders every placeholder as a bare '?', with no number and no cast", () => {
    // SQLite binds by position in emission order rather than by an index written into the text, and it has no type to cast a parameter to. Asserted across a nested tree because the numbering is exactly what a bare '?' drops: the three parameters below are told apart only by the order they appear in.
    expect(
      compileSqlite({
        kind: "allOf",
        operands: [
          {
            kind: "compare",
            op: "gt",
            left: { kind: "reference", key: "age" },
            right: { kind: "numberLiteral", value: LOWER_BOUND },
          },
          {
            kind: "memberOf",
            op: "in",
            operand: { kind: "reference", key: "name" },
            candidates: [
              { kind: "textLiteral", value: "b" },
              { kind: "textLiteral", value: "c" },
            ],
          },
        ],
      }),
    ).toEqual({
      sql: '(("age" > ?) AND ("name" IN (?, ?)))',
      params: [LOWER_BOUND, "b", "c"],
    });
  });

  it("compares two literals without either side needing a type", () => {
    // The case PostgreSQL cannot execute uncast at all. SQLite answers it from the bound values themselves, so there is nothing to annotate.
    expect(
      compileSqlite({
        kind: "compare",
        op: "lt",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "numberLiteral", value: 2 },
      }),
    ).toEqual({ sql: "(? < ?)", params: [1, 2] });
  });

  const INSTANT_AT = (column: string): string =>
    `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000 + CAST(substr(strftime('%f', ${column}), 4, 3) AS INTEGER))`;

  it("compares an instant as milliseconds since the epoch, the parameter being the number the evaluator reads from the text", () => {
    expect(
      compileSqlite({
        kind: "compare",
        op: "gte",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "2020-01-01T00:00:00+02:00" },
      }),
    ).toEqual({
      sql: `(${INSTANT_AT('"joined"')} >= ?)`,
      params: [Date.parse("2020-01-01T00:00:00+02:00")],
    });
  });

  it("reads the same parameter whichever way an instant is written", () => {
    const forms = [
      "2020-01-01T00:00:00Z",
      "2020-01-01T00:00:00.000Z",
      "2020-01-01T02:00:00+02:00",
      "2019-12-31T19:00:00-05:00",
    ];
    const parameters = forms.map(
      (value) =>
        compileSqlite({
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "joined" },
          right: { kind: "instantLiteral", value },
        }).params,
    );
    expect(parameters).toEqual(forms.map(() => [Date.parse(forms[0] ?? "")]));
  });

  it("binds a text the evaluator cannot read as an instant as NULL, so the comparison is unknown", () => {
    expect(
      compileSqlite({
        kind: "compare",
        op: "lt",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "not a time" },
      }).params,
    ).toEqual([null]);
  });

  it("compares as instants when the literal is on the left, and against a column with no declared kind", () => {
    expect(
      compileSqlite({
        kind: "compare",
        op: "lt",
        left: { kind: "instantLiteral", value: "2020-01-01T00:00:00Z" },
        right: { kind: "reference", key: "note" },
      }),
    ).toEqual({
      sql: `(? < ${INSTANT_AT('"note"')})`,
      params: [Date.parse("2020-01-01T00:00:00Z")],
    });
  });

  it("compares every operand of a membership as an instant", () => {
    expect(
      compileSqlite({
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "joined" },
        candidates: [
          { kind: "instantLiteral", value: "2020-01-01T00:00:00Z" },
          { kind: "instantLiteral", value: "2021-01-01T00:00:00+01:00" },
        ],
      }),
    ).toEqual({
      sql: `(${INSTANT_AT('"joined"')} IN (?, ?))`,
      params: [
        Date.parse("2020-01-01T00:00:00Z"),
        Date.parse("2021-01-01T00:00:00+01:00"),
      ],
    });
  });

  it("leaves a comparison that has no instant operand as it was", () => {
    expect(
      compileSqlite({
        kind: "compare",
        op: "gt",
        left: { kind: "reference", key: "age" },
        right: { kind: "numberLiteral", value: ADULT_AGE },
      }),
    ).toEqual({ sql: '("age" > ?)', params: [ADULT_AGE] });
  });

  it("leaves an instant as the text it is under PostgreSQL, which compares points in time itself", () => {
    expect(
      compile({
        kind: "compare",
        op: "gte",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "2020-01-01T00:00:00+02:00" },
      }),
    ).toEqual({
      sql: '("joined" >= $1::timestamptz)',
      params: ["2020-01-01T00:00:00+02:00"],
    });
  });

  it.each([
    ["equals", "="],
    ["notEquals", "<>"],
    ["matches", "REGEXP"],
    ["notMatches", "NOT REGEXP"],
  ] as const)("compiles textCompare '%s' to '%s'", (op, sqlOperator) => {
    // `=` and `<>` are ANSI-standard and identical to the PostgreSQL dialect's; only the two pattern operators differ, and SQLite's are the reserved REGEXP syntax for a function the connection registers itself.
    expect(
      compileSqlite({
        kind: "textCompare",
        op,
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^a" },
      }),
    ).toEqual({ sql: `("name" ${sqlOperator} ?)`, params: ["^a"] });
  });

  it.each([
    ["portableMatches", "GLOB"],
    ["portableNotMatches", "NOT GLOB"],
  ] as const)(
    "compiles '%s' to '%s' against the pattern translated into a GLOB wildcard",
    (op, sqlOperator) => {
      expect(
        compileSqlite({
          kind: "textCompare",
          op,
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a.*c$" },
        }),
      ).toEqual({
        sql: `("name" ${sqlOperator} ?)`,
        params: ["a*c"],
      });
    },
  );

  it("refuses a portableMatches pattern outside GLOB's reachable subset", () => {
    // Alternation has no GLOB equivalent at all (see portable-pattern.ts's own reachable-subset doc comment) -- this falls back to in-process evaluation rather than compiling to something that answers a different question.
    expect(() =>
      compileSqlite({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "cat|dog" },
      }),
    ).toThrow(/GLOB has no alternation operator/);
  });

  it("compiles an empty candidate list without a boolean annotation on the NULL", () => {
    // SQLite has no boolean type to annotate, and the annotation is not what the encoding depends on: the integration suite executes both of these and gets the same three-valued answers the `::boolean` forms give PostgreSQL.
    expect(
      compileSqlite({
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "name" },
        candidates: [],
      }),
    ).toEqual({ sql: '("name" IS NULL AND NULL)', params: [] });

    expect(
      compileSqlite({
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "reference", key: "name" },
        candidates: [],
      }),
    ).toEqual({ sql: '("name" IS NOT NULL OR NULL)', params: [] });
  });

  it("emits the dialect-neutral structure identically to PostgreSQL", () => {
    // Everything the two dialects share, in one tree: the connectives, the six comparison operators, `IS NOT NULL`, `NOT IN`, and double-quoted identifiers. The only difference between this expectation and the PostgreSQL one is the placeholders.
    const node: PredicateNode = {
      kind: "not",
      operand: {
        kind: "and",
        left: ageOver,
        right: {
          kind: "or",
          left: { kind: "exists", operand: { kind: "reference", key: "note" } },
          right: {
            kind: "memberOf",
            op: "notIn",
            operand: { kind: "reference", key: "age" },
            candidates: [{ kind: "numberLiteral", value: EXCLUDED_AGE }],
          },
        },
      },
    };

    expect(compileSqlite(node).sql).toBe(
      '(NOT (("age" > ?) AND (("note" IS NOT NULL) OR ("age" NOT IN (?)))))',
    );
    expect(compile(node).sql).toBe(
      '(NOT (("age" > $1::double precision) AND (("note" IS NOT NULL) OR ("age" NOT IN ($2::double precision)))))',
    );
  });

  it("quotes and neutralises identifiers exactly as the PostgreSQL dialect does", () => {
    // Double-quoting with an embedded quote doubled is ANSI-standard, so the injection defence is the same string in both dialects rather than a per-dialect rule.
    const hostile: SqlCompileOptions = {
      dialect: "sqlite",
      columnFor: () => ({ column: 'note"; DROP TABLE subjects; --' }),
    };
    expect(
      compile(
        { kind: "exists", operand: { kind: "reference", key: "anything" } },
        hostile,
      ).sql,
    ).toBe('("note""; DROP TABLE subjects; --" IS NOT NULL)');
  });

  it("compiles an empty allOf and anyOf to the same identities", () => {
    expect(compileSqlite({ kind: "allOf", operands: [] }).sql).toBe("(TRUE)");
    expect(compileSqlite({ kind: "anyOf", operands: [] }).sql).toBe("(FALSE)");
  });
});

describe("sqliteRegexpAvailable", () => {
  const patternMatch: PredicateNode = {
    kind: "textCompare",
    op: "matches",
    left: { kind: "reference", key: "name" },
    right: { kind: "textLiteral", value: "^a" },
  };

  it("still compiles to REGEXP when the flag is unset, preserving existing behaviour", () => {
    expect(compile(patternMatch, sqliteSubjectOptions)).toEqual({
      sql: '("name" REGEXP ?)',
      params: ["^a"],
    });
  });

  it("still compiles to REGEXP when the flag is explicitly true", () => {
    expect(
      compile(patternMatch, {
        ...sqliteSubjectOptions,
        sqliteRegexpAvailable: true,
      }),
    ).toEqual({ sql: '("name" REGEXP ?)', params: ["^a"] });
  });

  it("refuses matches/notMatches at compile time once the flag is false", () => {
    const options: SqlCompileOptions = {
      ...sqliteSubjectOptions,
      sqliteRegexpAvailable: false,
    };
    expect(() => compile(patternMatch, options)).toThrow(UnsupportedNodeError);
    expect(() =>
      compile({ ...patternMatch, op: "notMatches" }, options),
    ).toThrow(UnsupportedNodeError);
  });

  it("agrees with findUnpushableNodeKind rather than only compilePredicateNode's own check", () => {
    const options: SqlCompileOptions = {
      ...sqliteSubjectOptions,
      sqliteRegexpAvailable: false,
    };
    expect(findUnpushableNodeKind(patternMatch, options)).toMatchObject({
      kind: "textCompare",
      path: "$",
    });
    expect(() => compile(patternMatch, options)).toThrow(UnsupportedNodeError);
  });

  it("has no effect on the postgres dialect, which matches natively with '~'", () => {
    expect(
      compile(patternMatch, {
        ...subjectOptionsWithPostgresRegexp,
        sqliteRegexpAvailable: false,
      }),
    ).toEqual({ sql: '("name" ~ $1::text)', params: ["^a"] });
  });
});

describe("a dialect this version does not implement", () => {
  // `SqlDialect` is closed, so this is what a caller reading the name from configuration and asserting it into the union at the boundary reaches -- the only way an unimplemented name gets this far, and the reason the assertion is here rather than in the source under test.
  const unimplemented = "mysql" as SqlDialect;
  const mysqlOptions: SqlCompileOptions = {
    dialect: unimplemented,
    columnFor: () => ({ column: "age", paramType: "number" }),
  };

  const anyTree: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "age" },
    right: { kind: "numberLiteral", value: ADULT_AGE },
  };

  it("is refused by name, not as an internal error from an empty table lookup", () => {
    expect(() => compilePredicateNode(anyTree, mysqlOptions)).toThrow(
      UnknownDialectError,
    );
    expect(() => compilePredicateNode(anyTree, mysqlOptions)).toThrow(
      /unknown dialect "mysql": this version compiles "postgres", "sqlite"/,
    );
  });

  it("carries the offending name and the implemented ones as fields", () => {
    try {
      compilePredicateNode(anyTree, mysqlOptions);
      expect.unreachable("compiling an unimplemented dialect must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownDialectError);
      expect(error).toMatchObject({
        dialect: "mysql",
        implemented: ["postgres", "sqlite"],
      });
    }
  });

  it("is refused before the tree is walked, so the dialect is what gets reported", () => {
    // A tree the guard would object to on its own. The dialect is the earlier problem and has to be the one named, since every refusal reason the walk could produce describes an engine that is not the one asked for.
    expect(() =>
      compilePredicateNode(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "age" },
          right: { kind: "numberLiteral", value: Number.NaN },
        },
        mysqlOptions,
      ),
    ).toThrow(UnknownDialectError);
  });

  it("never reports such a tree as pushable, which would promise a compilation that cannot happen", () => {
    expect(() => findUnpushableNodeKind(anyTree, mysqlOptions)).toThrow(
      UnknownDialectError,
    );
  });
});
