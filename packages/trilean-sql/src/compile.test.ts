import type { PredicateNode } from "trilean";
import { describe, expect, it, vi } from "vitest";
import { compilePredicateNode } from "./compile";
import {
  InvalidColumnError,
  UnknownDialectError,
  UnsupportedNodeError,
} from "./errors";
import { findUnpushableNodeKind } from "./guard";
import type { SqlCompileOptions, SqlDialect } from "./options";
import { sqliteSubjectOptions, subjectOptions } from "./test-support/columns";

function compile(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions> = subjectOptions,
) {
  return compilePredicateNode(node, options);
}

// Named rather than written twice, so each case's expected `params` is the same value the tree was built from rather than a literal that could drift away from it.
const ADULT_AGE = 18;
const SAMPLE_AGE = 40;
const EXCLUDED_AGE = 7;
const LOWER_BOUND = 1;
const UPPER_BOUND = 4;

const ageOver: PredicateNode = {
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "age" },
  right: { kind: "numberLiteral", value: ADULT_AGE },
};

describe("connectives", () => {
  it("compiles and/or/not to their SQL counterparts", () => {
    const node: PredicateNode = {
      kind: "not",
      operand: {
        kind: "and",
        left: ageOver,
        right: {
          kind: "or",
          left: { kind: "exists", operand: { kind: "reference", key: "note" } },
          right: {
            kind: "compare",
            op: "eq",
            left: { kind: "reference", key: "active" },
            right: { kind: "booleanLiteral", value: true },
          },
        },
      },
    };

    expect(compile(node)).toEqual({
      sql: '(NOT (("age" > $1::double precision) AND (("note" IS NOT NULL) OR ("active" = $2::boolean))))',
      params: [ADULT_AGE, true],
    });
  });

  it("compiles allOf and anyOf to n-ary AND and OR", () => {
    const operands: PredicateNode[] = [
      ageOver,
      { kind: "exists", operand: { kind: "reference", key: "note" } },
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "ada" },
      },
    ];

    expect(compile({ kind: "allOf", operands }).sql).toBe(
      '(("age" > $1::double precision) AND ("note" IS NOT NULL) AND ("name" = $2::text))',
    );
    expect(compile({ kind: "anyOf", operands }).sql).toBe(
      '(("age" > $1::double precision) OR ("note" IS NOT NULL) OR ("name" = $2::text))',
    );
  });

  it("compiles an empty allOf and anyOf to each connective's own identity", () => {
    // Matching the evaluator, which folds allOf from definite(true) and anyOf from definite(false).
    expect(compile({ kind: "allOf", operands: [] })).toEqual({
      sql: "(TRUE)",
      params: [],
    });
    expect(compile({ kind: "anyOf", operands: [] })).toEqual({
      sql: "(FALSE)",
      params: [],
    });
  });
});

describe("compare", () => {
  it.each([
    ["gt", ">"],
    ["gte", ">="],
    ["lt", "<"],
    ["lte", "<="],
    ["eq", "="],
    ["neq", "<>"],
  ] as const)("compiles '%s' to '%s'", (op, sqlOperator) => {
    expect(
      compile({
        kind: "compare",
        op,
        left: { kind: "reference", key: "age" },
        right: { kind: "numberLiteral", value: SAMPLE_AGE },
      }),
    ).toEqual({
      sql: `("age" ${sqlOperator} $1::double precision)`,
      params: [SAMPLE_AGE],
    });
  });

  it("casts an instant literal to timestamptz so an offset survives the comparison", () => {
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

  it("casts both sides when neither operand is a column", () => {
    // PostgreSQL rejects `$1 < $2` outright -- it cannot determine either parameter's type -- so a literal-only comparison is only executable because every placeholder carries the cast its own literal kind implies.
    expect(
      compile({
        kind: "compare",
        op: "lt",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "numberLiteral", value: 2 },
      }),
    ).toEqual({
      sql: "($1::double precision < $2::double precision)",
      params: [1, 2],
    });
  });

  it("casts by the literal's own kind, whether or not the column declares one", () => {
    // `age` declares number and `note` declares nothing; the placeholder is identical either way, which is why the compiler does not consult the declaration when casting.
    expect(
      compile({
        kind: "compare",
        op: "gt",
        left: { kind: "reference", key: "age" },
        right: { kind: "numberLiteral", value: 1 },
      }).sql,
    ).toBe('("age" > $1::double precision)');

    expect(
      compile({
        kind: "compare",
        op: "gt",
        left: { kind: "reference", key: "note" },
        right: { kind: "numberLiteral", value: 1 },
      }).sql,
    ).toBe('("note" > $1::double precision)');
  });
});

describe("textCompare", () => {
  it.each([
    ["equals", "="],
    ["notEquals", "<>"],
    ["matches", "~"],
    ["notMatches", "!~"],
  ] as const)("compiles '%s' to '%s'", (op, sqlOperator) => {
    expect(
      compile({
        kind: "textCompare",
        op,
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^a" },
      }),
    ).toEqual({
      sql: `("name" ${sqlOperator} $1::text)`,
      params: ["^a"],
    });
  });

  it("compares two columns without producing a parameter", () => {
    expect(
      compile({
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "name" },
        right: { kind: "reference", key: "note" },
      }),
    ).toEqual({ sql: '("name" = "note")', params: [] });
  });
});

describe("memberOf", () => {
  it("compiles 'in' to IN with one parameter per candidate", () => {
    expect(
      compile({
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "name" },
        candidates: [
          { kind: "textLiteral", value: "ada" },
          { kind: "textLiteral", value: "grace" },
        ],
      }),
    ).toEqual({
      sql: '("name" IN ($1::text, $2::text))',
      params: ["ada", "grace"],
    });
  });

  it("compiles 'notIn' to NOT IN", () => {
    expect(
      compile({
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "reference", key: "age" },
        candidates: [{ kind: "numberLiteral", value: EXCLUDED_AGE }],
      }),
    ).toEqual({
      sql: '("age" NOT IN ($1::double precision))',
      params: [EXCLUDED_AGE],
    });
  });

  it("compiles an empty candidate list to a form that still propagates the operand's NULL", () => {
    // `IN ()` is a syntax error, and folding to a bare FALSE/TRUE would answer definitely for a NULL operand where the evaluator returns indeterminate. The integration suite executes both of these against a real server.
    expect(
      compile({
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "name" },
        candidates: [],
      }),
    ).toEqual({ sql: '("name" IS NULL AND NULL::boolean)', params: [] });

    expect(
      compile({
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "reference", key: "name" },
        candidates: [],
      }),
    ).toEqual({ sql: '("name" IS NOT NULL OR NULL::boolean)', params: [] });
  });
});

describe("exists", () => {
  it("compiles to IS NOT NULL", () => {
    expect(
      compile({ kind: "exists", operand: { kind: "reference", key: "note" } }),
    ).toEqual({ sql: '("note" IS NOT NULL)', params: [] });
  });
});

describe("parameters", () => {
  it("numbers placeholders in emission order across a nested tree", () => {
    const node: PredicateNode = {
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
        {
          kind: "compare",
          op: "lt",
          left: { kind: "reference", key: "age" },
          right: { kind: "numberLiteral", value: UPPER_BOUND },
        },
      ],
    };

    expect(compile(node)).toEqual({
      sql: '(("age" > $1::double precision) AND ("name" IN ($2::text, $3::text)) AND ("age" < $4::double precision))',
      params: [LOWER_BOUND, "b", "c", UPPER_BOUND],
    });
  });

  it("never writes a literal into the SQL text", () => {
    const injection = "'; DROP TABLE subjects; --";
    const compiled = compile({
      kind: "textCompare",
      op: "equals",
      left: { kind: "reference", key: "name" },
      right: { kind: "textLiteral", value: injection },
    });

    expect(compiled.sql).not.toContain("DROP");
    expect(compiled.sql).toBe('("name" = $1::text)');
    expect(compiled.params).toEqual([injection]);
  });
});

describe("column identifiers", () => {
  function optionsReturning(column: string): SqlCompileOptions {
    return { dialect: "postgres", columnFor: () => ({ column }) };
  }

  const noteExists: PredicateNode = {
    kind: "exists",
    operand: { kind: "reference", key: "anything" },
  };

  it("quotes each dot-separated segment separately", () => {
    expect(
      compile(noteExists, optionsReturning("public.subjects.note")).sql,
    ).toBe('("public"."subjects"."note" IS NOT NULL)');
  });

  it("neutralises a column name carrying a quote by doubling it", () => {
    const compiled = compile(
      noteExists,
      optionsReturning('note"; DROP TABLE subjects; --'),
    );
    expect(compiled.sql).toBe(
      '("note""; DROP TABLE subjects; --" IS NOT NULL)',
    );
  });

  it("rejects an empty column name", () => {
    expect(() => compile(noteExists, optionsReturning(""))).toThrow(
      InvalidColumnError,
    );
  });

  it("rejects an empty dot-separated segment", () => {
    expect(() => compile(noteExists, optionsReturning("public..note"))).toThrow(
      InvalidColumnError,
    );
  });

  it("propagates an error thrown by columnFor unchanged", () => {
    expect(() =>
      compile({
        kind: "exists",
        operand: { kind: "reference", key: "unmapped" },
      }),
    ).toThrow("no column mapped for reference key 'unmapped'");
  });

  it("asks columnFor once per distinct reference key", () => {
    const columnFor = vi.fn(() => ({
      column: "age",
      paramType: "number" as const,
    }));
    compile(
      {
        kind: "and",
        left: ageOver,
        right: {
          kind: "compare",
          op: "lt",
          left: { kind: "reference", key: "age" },
          right: { kind: "numberLiteral", value: 65 },
        },
      },
      { dialect: "postgres", columnFor },
    );
    expect(columnFor).toHaveBeenCalledTimes(1);
  });
});

describe("refusal", () => {
  it("throws UnsupportedNodeError carrying the offending kind and path", () => {
    let thrown: unknown;
    try {
      compile({
        kind: "and",
        left: ageOver,
        right: { kind: "treeReference", key: "other" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedNodeError);
    if (!(thrown instanceof UnsupportedNodeError))
      throw new Error("unreachable");
    expect(thrown.name).toBe("UnsupportedNodeError");
    expect(thrown.nodeKind).toBe("treeReference");
    expect(thrown.path).toBe("$.right");
    expect(thrown.message).toContain(
      "cannot compile 'treeReference' at $.right",
    );
  });

  it("emits nothing at all when it refuses", () => {
    // The refusal is total: no partial fragment, no partially-populated parameter list, nothing a caller could mistake for a usable result.
    expect(() =>
      compile({
        kind: "allOf",
        operands: [ageOver, { kind: "some", collection: "xs", item: ageOver }],
      }),
    ).toThrow(UnsupportedNodeError);
  });

  it.each([
    ["some", { kind: "some", collection: "xs", item: ageOver }] satisfies [
      string,
      PredicateNode,
    ],
    ["every", { kind: "every", collection: "xs", item: ageOver }] satisfies [
      string,
      PredicateNode,
    ],
    [
      "fold",
      {
        kind: "compare",
        op: "gt",
        left: {
          kind: "fold",
          collection: "xs",
          combiner: {
            mode: "max",
            item: { kind: "numberLiteral", value: LOWER_BOUND },
          },
        },
        right: { kind: "numberLiteral", value: UPPER_BOUND },
      },
    ] satisfies [string, PredicateNode],
  ])(
    "refuses a '%s' buried several levels down rather than dropping that branch",
    (kind, unsupported) => {
      // The failure mode this rules out is the dangerous one: a branch the compiler has no translation for quietly contributing nothing to the fragment, leaving a WHERE clause strictly more permissive than the tree it claims to stand for. The burial is deliberate -- under an `and`, then an `anyOf`, then a `not` -- because a check that only looks at the root would pass every one of these.
      let thrown: unknown;
      try {
        compile({
          kind: "and",
          left: ageOver,
          right: {
            kind: "anyOf",
            operands: [
              { kind: "exists", operand: { kind: "reference", key: "note" } },
              { kind: "not", operand: unsupported },
            ],
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnsupportedNodeError);
      if (!(thrown instanceof UnsupportedNodeError))
        throw new Error("unreachable");
      expect(thrown.nodeKind).toBe(kind);
      expect(thrown.path).toContain("$.right.operands[1].operand");
    },
  );
});

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

  it("renders an instant literal as a plain parameter, with no timestamp type to cast to", () => {
    expect(
      compileSqlite({
        kind: "compare",
        op: "gte",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "2020-01-01T00:00:00+02:00" },
      }),
    ).toEqual({
      sql: '("joined" >= ?)',
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
