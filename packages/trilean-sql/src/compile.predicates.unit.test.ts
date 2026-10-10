import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { UnsupportedNodeError } from "./errors";
import { subjectOptionsWithPostgresRegexp } from "./test-support/columns";
import {
  ADULT_AGE,
  ageOver,
  compile,
  EXCLUDED_AGE,
  SAMPLE_AGE,
} from "./compile-test-helpers";

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

  it.each([
    ["matches", "~"],
    ["notMatches", "!~"],
  ] as const)(
    "compiles '%s' to '%s' once postgresRegexpPushdown is set true",
    (op, sqlOperator) => {
      expect(
        compile(
          {
            kind: "textCompare",
            op,
            left: { kind: "reference", key: "name" },
            right: { kind: "textLiteral", value: "^a" },
          },
          subjectOptionsWithPostgresRegexp,
        ),
      ).toEqual({
        sql: `("name" ${sqlOperator} $1::text)`,
        params: ["^a"],
      });
    },
  );

  it.each(["matches", "notMatches"] as const)(
    "refuses '%s' against PostgreSQL by default, since PostgreSQL matches it under its own regular-expression dialect rather than trilean's ECMAScript one",
    (op) => {
      expect(() =>
        compile({
          kind: "textCompare",
          op,
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a" },
        }),
      ).toThrow(UnsupportedNodeError);
    },
  );

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

  it.each([
    ["portableMatches", "~"],
    ["portableNotMatches", "!~"],
  ] as const)(
    "compiles '%s' to '%s' against the pattern translated into PostgreSQL's own syntax",
    (op, sqlOperator) => {
      expect(
        compile({
          kind: "textCompare",
          op,
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a\\dc$" },
        }),
      ).toEqual({
        sql: `("name" ${sqlOperator} $1::text)`,
        // '\d' expands to a '[0-9]' character-class node in trilean-regex's own AST (see shorthand-classes.ts) before this compiler ever sees it, so the bound pattern is that expansion, not the original source text.
        params: ["^a[0-9]c$"],
      });
    },
  );

  it("refuses portableMatches whose pattern is not a compile-time literal", () => {
    expect(() =>
      compile({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "reference", key: "note" },
      }),
    ).toThrow(/must be a literal, known at compile time/);
  });

  it("refuses portableMatches whose pattern is not valid trilean-regex syntax", () => {
    expect(() =>
      compile({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "(a)" },
      }),
    ).toThrow(/capturing groups are not supported/);
  });

  it("refuses portableMatches whose pattern's bound exceeds PostgreSQL's 0-255 limit", () => {
    expect(() =>
      compile({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "a{256}" },
      }),
    ).toThrow(/permit a bound of at most 255/);
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
