import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import type {
  ComputedValue,
  JsonValue,
  PredicateNode,
  Resolution,
  Resolvers,
} from "trilean";
import { evaluatePredicate } from "trilean";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import type { SqlCompileOptions } from "../../src/options";
import { subjectOptions } from "../../src/test-support/columns";

/**
 * The suite that turns this package's central claim from a design statement into a measured one.
 *
 * A compiled fragment's three-valued behaviour cannot be established by asserting its text: `("age" > $1)` is only indeterminate-preserving because of what PostgreSQL's planner does with a NULL `age`, and that is a fact about PostgreSQL, not about the string. So every case here compiles a tree, executes the fragment as a real `WHERE` clause against a real server, and compares the rows it returns against the rows trilean's own evaluator judges `definite(true)` for the same tree. Agreement on the rows *and* on their absence is the property under test; a divergence is a compiler bug regardless of what the SQL looks like.
 */

const SCHEMA = `
  CREATE TABLE subjects (
    id     text PRIMARY KEY,
    age    double precision,
    name   text,
    active boolean,
    joined timestamptz,
    note   text
  );
`;

interface SubjectRow {
  id: string;
  age: number | null;
  name: string | null;
  active: boolean | null;
  joined: string | null;
  note: string | null;
}

/** `null` in a column means the same thing as a reference that resolves to nothing: the value is not known. Every row below carries at least one, because a table of fully-populated rows would exercise none of what this suite exists to check. */
const SUBJECTS: readonly SubjectRow[] = [
  {
    id: "ada",
    age: 30,
    name: "ada",
    active: true,
    joined: "2020-01-01T00:00:00Z",
    note: "hello",
  },
  {
    id: "grace",
    age: 12,
    name: "grace",
    active: false,
    joined: "2024-06-01T12:00:00Z",
    note: "hi",
  },
  {
    id: "lin",
    age: null,
    name: "lin",
    active: true,
    joined: "2021-03-03T00:00:00Z",
    note: null,
  },
  {
    id: "unknown",
    age: 45,
    name: null,
    active: null,
    joined: null,
    note: null,
  },
];

/**
 * Resolves a reference key against one row, mapping a NULL column to `found: false`.
 *
 * That mapping is the correspondence the whole design rests on, and stating it in one place here is what makes the parity assertions below meaningful: the evaluator is being given exactly the knowledge PostgreSQL has about the same row, so any disagreement between them is the compiler's, not the fixture's.
 */
function resolversFor(row: Readonly<SubjectRow>): Resolvers {
  const known: Record<string, ComputedValue | undefined> = {
    ...(row.age !== null && {
      age: { kind: "number", value: row.age },
    }),
    ...(row.name !== null && { name: { kind: "text", value: row.name } }),
    ...(row.note !== null && { note: { kind: "text", value: row.note } }),
    ...(row.active !== null && {
      active: { kind: "boolean", value: row.active },
    }),
    ...(row.joined !== null && {
      joined: { kind: "instant", value: row.joined },
    }),
  };

  return {
    resolveValue: async (key: JsonValue) => {
      const value = typeof key === "string" ? known[key] : undefined;
      return Promise.resolve<Resolution>(
        value === undefined ? { found: false } : { found: true, value },
      );
    },
    resolveLookup: () => {
      throw new Error("no tree in this suite uses a lookup");
    },
    resolveCollection: () => {
      throw new Error("no tree in this suite uses a collection");
    },
  };
}

let container: StartedPostgreSqlContainer;
let client: pg.Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  await client.query(SCHEMA);
  for (const row of SUBJECTS) {
    await client.query(
      "INSERT INTO subjects (id, age, name, active, joined, note) VALUES ($1, $2, $3, $4, $5, $6)",
      [row.id, row.age, row.name, row.active, row.joined, row.note],
    );
  }
});

afterAll(async () => {
  await client.end();
  await container.stop();
});

async function selectMatching(node: PredicateNode): Promise<string[]> {
  const compiled = compilePredicateNode(node, subjectOptions);
  const result = await client.query<{ id: string }>(
    `SELECT id FROM subjects WHERE ${compiled.sql} ORDER BY id`,
    compiled.params,
  );
  return result.rows.map((row) => row.id);
}

async function evaluatorMatching(node: PredicateNode): Promise<string[]> {
  const matched: string[] = [];
  for (const row of SUBJECTS) {
    const evaluation = await evaluatePredicate(
      node,
      undefined,
      resolversFor(row),
    );
    if (evaluation.status === "definite" && evaluation.value) {
      matched.push(row.id);
    }
  }
  return matched.sort();
}

/** Runs the tree both ways and asserts they agree, then hands back the row set so a case can also state what that set should be. Agreement alone would be satisfied by both being wrong in the same way, so every caller asserts the expected ids too. */
async function agreeingRows(node: PredicateNode): Promise<string[]> {
  const [viaSql, viaEvaluator] = await Promise.all([
    selectMatching(node),
    evaluatorMatching(node),
  ]);
  expect(viaSql).toEqual(viaEvaluator);
  return viaSql;
}

describe("comparisons against a column that can be NULL", () => {
  const olderThan18: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "age" },
    right: { kind: "numberLiteral", value: 18 },
  };

  it("excludes the row whose age is unknown", async () => {
    await expect(agreeingRows(olderThan18)).resolves.toEqual([
      "ada",
      "unknown",
    ]);
  });

  it("still excludes it under negation, which two-valued logic could not do", async () => {
    // The load-bearing case. Under two-valued logic every row appears in exactly one of a predicate and its negation, so `lin` would have to turn up here. It does not, in either engine: NOT UNKNOWN is UNKNOWN in PostgreSQL exactly as `not(indeterminate)` is indeterminate in trilean.
    await expect(
      agreeingRows({ kind: "not", operand: olderThan18 }),
    ).resolves.toEqual(["grace"]);
  });

  it("keeps a row whose unknown comparison is absorbed by a true disjunct", async () => {
    await expect(
      agreeingRows({
        kind: "anyOf",
        operands: [
          olderThan18,
          {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "name" },
            right: { kind: "textLiteral", value: "lin" },
          },
        ],
      }),
    ).resolves.toEqual(["ada", "lin", "unknown"]);
  });

  it("collapses an unknown conjunct absorbed by a false one, observably under negation", async () => {
    // `unknown AND false` has to be FALSE rather than UNKNOWN, and the difference only shows through a NOT: a genuinely FALSE conjunction negates to TRUE and the row appears, whereas an UNKNOWN one would negate to UNKNOWN and it would not. `lin` appearing here is that absorption being exercised.
    await expect(
      agreeingRows({
        kind: "not",
        operand: {
          kind: "allOf",
          operands: [
            olderThan18,
            {
              kind: "textCompare",
              op: "equals",
              left: { kind: "reference", key: "name" },
              right: { kind: "textLiteral", value: "nobody" },
            },
          ],
        },
      }),
    ).resolves.toEqual(["ada", "grace", "lin"]);
  });

  it("compares instants across a NULL", async () => {
    await expect(
      agreeingRows({
        kind: "compare",
        op: "lt",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "2022-01-01T00:00:00Z" },
      }),
    ).resolves.toEqual(["ada", "lin"]);
  });

  it("compares booleans for equality across a NULL", async () => {
    await expect(
      agreeingRows({
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "active" },
        right: { kind: "booleanLiteral", value: true },
      }),
    ).resolves.toEqual(["ada", "lin"]);
  });
});

describe("exists", () => {
  const hasNote: PredicateNode = {
    kind: "exists",
    operand: { kind: "reference", key: "note" },
  };

  it("partitions the table, because it is the one predicate neither engine leaves unknown", async () => {
    const present = await agreeingRows(hasNote);
    const absent = await agreeingRows({ kind: "not", operand: hasNote });
    expect(present).toEqual(["ada", "grace"]);
    expect(absent).toEqual(["lin", "unknown"]);
    expect([...present, ...absent].sort()).toEqual(
      SUBJECTS.map((row) => row.id).sort(),
    );
  });
});

describe("textCompare", () => {
  it("matches a pattern with PostgreSQL's own regular-expression operator", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "matches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^(a|g)" },
      }),
    ).resolves.toEqual(["ada", "grace"]);
  });

  it("leaves a NULL operand unknown under a negated match", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "notMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^a" },
      }),
    ).resolves.toEqual(["grace", "lin"]);
  });
});

describe("memberOf", () => {
  it("matches a candidate list", async () => {
    await expect(
      agreeingRows({
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "name" },
        candidates: [
          { kind: "textLiteral", value: "ada" },
          { kind: "textLiteral", value: "nobody" },
        ],
      }),
    ).resolves.toEqual(["ada"]);
  });

  it("leaves NOT IN unknown for a NULL operand", async () => {
    await expect(
      agreeingRows({
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "reference", key: "name" },
        candidates: [{ kind: "textLiteral", value: "ada" }],
      }),
    ).resolves.toEqual(["grace", "lin"]);
  });

  it("compiles an empty 'in' to something that is false, not unknown, for a known operand", async () => {
    // Executed rather than asserted as a string, because `(x IS NULL AND NULL::boolean)` is only the right encoding if PostgreSQL really does evaluate it to FALSE for a known operand and NULL for an unknown one. Negating it is what separates those two outcomes: only the rows with a known name come back.
    const node: PredicateNode = {
      kind: "memberOf",
      op: "in",
      operand: { kind: "reference", key: "name" },
      candidates: [],
    };
    await expect(agreeingRows(node)).resolves.toEqual([]);
    await expect(agreeingRows({ kind: "not", operand: node })).resolves.toEqual(
      ["ada", "grace", "lin"],
    );
  });

  it("compiles an empty 'notIn' to something that is true, not unknown, for a known operand", async () => {
    const node: PredicateNode = {
      kind: "memberOf",
      op: "notIn",
      operand: { kind: "reference", key: "name" },
      candidates: [],
    };
    await expect(agreeingRows(node)).resolves.toEqual(["ada", "grace", "lin"]);
    await expect(agreeingRows({ kind: "not", operand: node })).resolves.toEqual(
      [],
    );
  });
});

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

describe("a tree deep enough to mix every supported kind", () => {
  it("agrees with the evaluator row for row", async () => {
    const node: PredicateNode = {
      kind: "anyOf",
      operands: [
        {
          kind: "and",
          left: {
            kind: "compare",
            op: "gte",
            left: { kind: "reference", key: "age" },
            right: { kind: "numberLiteral", value: 18 },
          },
          right: {
            kind: "not",
            operand: {
              kind: "memberOf",
              op: "in",
              operand: { kind: "reference", key: "name" },
              candidates: [{ kind: "textLiteral", value: "grace" }],
            },
          },
        },
        {
          kind: "allOf",
          operands: [
            { kind: "exists", operand: { kind: "reference", key: "note" } },
            {
              kind: "or",
              left: {
                kind: "textCompare",
                op: "matches",
                left: { kind: "reference", key: "note" },
                right: { kind: "textLiteral", value: "^h" },
              },
              right: {
                kind: "compare",
                op: "eq",
                left: { kind: "reference", key: "active" },
                right: { kind: "booleanLiteral", value: false },
              },
            },
          ],
        },
      ],
    };

    await expect(agreeingRows(node)).resolves.toEqual(["ada", "grace"]);
  });
});
