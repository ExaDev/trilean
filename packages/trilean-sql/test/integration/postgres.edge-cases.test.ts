import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import type { SqlCompileOptions } from "../../src/options";
import { subjectOptions } from "../../src/test-support/columns";

import {
  agreeingRows,
  client,
  evaluatorMatching,
  SUBJECTS,
} from "./postgres-test-support";

describe("degenerate and adversarial fragments", () => {
  it("executes a comparison between two literals, which needs both placeholders typed", async () => {
    await expect(
      agreeingRows({
        kind: "compare",
        op: "lt",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "numberLiteral", value: 2 },
      }),
    ).resolves.toEqual(["ada", "grace", "lin", "unknown"]);
  });

  it("executes an empty allOf and anyOf as their identities", async () => {
    await expect(
      agreeingRows({ kind: "allOf", operands: [] }),
    ).resolves.toEqual(["ada", "grace", "lin", "unknown"]);
    await expect(
      agreeingRows({ kind: "anyOf", operands: [] }),
    ).resolves.toEqual([]);
  });

  it("refuses NaN, and measures the divergence that refusal exists to prevent", async () => {
    // The refusal is in the guard, so this could have been a unit test -- but a unit test could only assert that NaN is refused, not that refusing it was right. What makes it right is a fact about PostgreSQL: it defines NaN as equal to itself, so `NaN = NaN` there is TRUE and would have selected the whole table, while trilean's `===` makes the same tree match nothing. Both halves are measured here.
    const node: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: { kind: "numberLiteral", value: Number.NaN },
      right: { kind: "numberLiteral", value: Number.NaN },
    };
    expect(() => compilePredicateNode(node, subjectOptions)).toThrow(
      /cannot compile 'numberLiteral'/,
    );

    const wouldHaveMatched = await client.query<{ id: string }>(
      "SELECT id FROM subjects WHERE ($1::double precision = $2::double precision) ORDER BY id",
      [Number.NaN, Number.NaN],
    );
    expect(wouldHaveMatched.rows.map((row) => row.id)).toEqual(
      SUBJECTS.map((row) => row.id).sort(),
    );
    await expect(evaluatorMatching(node)).resolves.toEqual([]);
  });

  it("treats an injection attempt as data and leaves the table standing", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "name" },
        right: {
          kind: "textLiteral",
          value: "ada'; DROP TABLE subjects; --",
        },
      }),
    ).resolves.toEqual([]);

    const surviving = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM subjects",
    );
    expect(surviving.rows[0]?.count).toBe(String(SUBJECTS.length));
  });

  it("neutralises a hostile column name into one identifier the server rejects", async () => {
    // A column name is the one caller-supplied string that has to reach the SQL text, so quoting is what makes it safe rather than parameterisation. Asserting the quoted string is not the same as establishing that PostgreSQL reads it as a single inert identifier: this executes it, and the server refusing it as a column that does not exist is the proof. The failure it rules out is the opposite outcome -- the injected `OR` taking effect and the fragment matching every row.
    const hostile: SqlCompileOptions = {
      dialect: "postgres",
      columnFor: () => ({ column: `name" = name OR "1` }),
    };
    const compiled = compilePredicateNode(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "ada" },
      },
      hostile,
    );
    expect(compiled.sql).toBe(`("name"" = name OR ""1" = $1::text)`);

    await expect(
      client.query(
        `SELECT id FROM subjects WHERE ${compiled.sql}`,
        compiled.params,
      ),
    ).rejects.toThrow(/does not exist/i);
  });
});
