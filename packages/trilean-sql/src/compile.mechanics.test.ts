import type { PredicateNode } from "trilean";
import { describe, expect, it, vi } from "vitest";
import { InvalidColumnError, UnsupportedNodeError } from "./errors";
import type { SqlCompileOptions } from "./options";
import {
  ageOver,
  compile,
  LOWER_BOUND,
  UPPER_BOUND,
} from "./compile-test-helpers";

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
            mode: "reduce",
            initial: { kind: "numberLiteral", value: LOWER_BOUND },
            combine: { kind: "numberLiteral", value: LOWER_BOUND },
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
