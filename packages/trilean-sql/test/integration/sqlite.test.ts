import Database from "better-sqlite3";
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
import { sqliteSubjectOptions } from "../../src/test-support/columns";

/**
 * The SQLite counterpart of `postgres.test.ts`, and the same claim measured rather than asserted: every case compiles a tree, executes the fragment as a real `WHERE` clause against a real SQLite connection, and compares the rows it returns against the rows trilean's own evaluator judges `definite(true)` for the same tree.
 *
 * Two things make this more than a copy. SQLite reaches its three-valued behaviour from a different starting point -- no boolean type, no timestamp type, no NaN, and a type-affinity system that coerces rather than rejects -- so agreement here is evidence about the dialect rather than a second run of an already-proven one. And the same affinity system is why the guard's refusals carry over unchanged: the last two describe blocks measure the divergences those refusals exist to prevent, against this connection, rather than asserting that a refusal fires.
 *
 * Unlike the PostgreSQL suite this needs no Docker: better-sqlite3 runs the engine in process against an in-memory database.
 */

const SCHEMA = `
  CREATE TABLE subjects (
    id     TEXT PRIMARY KEY,
    age    REAL,
    name   TEXT,
    active INTEGER,
    joined TEXT,
    note   TEXT
  );
`;

/**
 * A second, deliberately tiny table whose only purpose is the coercion proofs at the end of this file.
 *
 * They need a column whose declared affinity does the coercing -- affinity is a property of a column, and two bound parameters compared against each other have none -- and they need values chosen so that the coerced answer and the honest one differ. Keeping them out of `subjects` leaves that fixture identical in shape to the PostgreSQL suite's, so a case comparing the two suites is comparing like with like.
 */
const COERCION_SCHEMA = `
  CREATE TABLE coercion (
    label        TEXT PRIMARY KEY,
    numeric_text TEXT,
    flag         INTEGER
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
 * That mapping is the correspondence the whole design rests on, and stating it in one place here is what makes the parity assertions below meaningful: the evaluator is being given exactly the knowledge SQLite has about the same row, so any disagreement between them is the compiler's, not the fixture's.
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

/** The threshold the coercion proofs compare against: greater than the text '9' sorts, and less than the number 9 is, so a coerced comparison and an honest one disagree about it. */
const COERCION_THRESHOLD = 5;

/** The lower of the two integers SQLite stores a boolean as, so `flag > FALSE_AS_INTEGER` is the ordering comparison trilean has no answer for. */
const FALSE_AS_INTEGER = 0;

/**
 * Maps a compiled parameter onto something SQLite can bind.
 *
 * The one value kind that needs it is `boolean`: SQLite has no boolean type, and better-sqlite3 refuses a JS boolean outright ("SQLite3 can only bind numbers, strings, bigints, buffers, and null") rather than coercing it. That is a property of the driver and the engine, not of the compiled fragment -- `compilePredicateNode` hands back the tree's own literals unchanged in every dialect -- so the conversion belongs to the caller binding them, which is what this suite is standing in for. It is a loud failure rather than a silent one, which is why the compiler leaves it to the caller; README.md documents it alongside the `REGEXP` registration.
 */
function bindable(value: unknown): unknown {
  return typeof value === "boolean" ? Number(value) : value;
}

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  /**
   * SQLite reserves `REGEXP` as syntax for a `regexp(pattern, value)` function it does not itself provide, so the dialect's `matches`/`notMatches` only run on a connection that has registered one. Two details of this registration are load-bearing rather than incidental, and README.md documents both:
   *
   * It returns `null` when either argument is NULL. SQLite does not propagate NULL through a user function on its own, and a function that answered 0 for a NULL value would make `NOT REGEXP` answer TRUE for a row whose value is unknown -- exactly the two-valued collapse this package exists to avoid.
   *
   * It returns 1/0 rather than a JS boolean, which better-sqlite3 rejects from a user function ("returned an invalid value") for the same reason it rejects one as a bound parameter.
   */
  db.function("regexp", (pattern: unknown, text: unknown) =>
    typeof pattern !== "string" || typeof text !== "string"
      ? null
      : new RegExp(pattern).test(text)
        ? 1
        : 0,
  );

  db.exec(SCHEMA);
  db.exec(COERCION_SCHEMA);

  const insert = db.prepare(
    "INSERT INTO subjects (id, age, name, active, joined, note) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const row of SUBJECTS) {
    insert.run(
      row.id,
      row.age,
      row.name,
      row.active === null ? null : Number(row.active),
      row.joined,
      row.note,
    );
  }

  // '9' and '10' straddle 5 differently as text than as numbers, and 1 and 0 are what SQLite stores a boolean as. Both pairs are chosen so a coerced comparison and an honest one disagree.
  const insertCoercion = db.prepare(
    "INSERT INTO coercion (label, numeric_text, flag) VALUES (?, ?, ?)",
  );
  insertCoercion.run("nine", "9", 1);
  insertCoercion.run("ten", "10", FALSE_AS_INTEGER);
});

afterAll(() => {
  db.close();
});

function selectMatching(node: PredicateNode): string[] {
  const compiled = compilePredicateNode(node, sqliteSubjectOptions);
  const rows = db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM subjects WHERE ${compiled.sql} ORDER BY id`,
    )
    .all(...compiled.params.map(bindable));
  return rows.map((row) => row.id);
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
  const viaSql = selectMatching(node);
  const viaEvaluator = await evaluatorMatching(node);
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
    // The load-bearing case. Under two-valued logic every row appears in exactly one of a predicate and its negation, so `lin` would have to turn up here. It does not, in either engine: NOT UNKNOWN is UNKNOWN in SQLite exactly as `not(indeterminate)` is indeterminate in trilean.
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

  it("compares instants across a NULL, as the ISO-8601 text SQLite stores them as", async () => {
    // SQLite has no timestamp type: an instant is stored and compared as text. Offset-bearing ISO-8601 in a common offset sorts chronologically as a string, which is what makes this agree with the evaluator's own instant comparison rather than merely happening to.
    await expect(
      agreeingRows({
        kind: "compare",
        op: "lt",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "2022-01-01T00:00:00Z" },
      }),
    ).resolves.toEqual(["ada", "lin"]);
  });

  it("compares booleans for equality across a NULL, as the integers SQLite stores them as", async () => {
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
  it("matches a pattern through the registered REGEXP function", async () => {
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
    // What a registered function has to get right, and the reason README.md spells the registration out rather than leaving it to the reader: `lin` is here because its name does not match, and `unknown` is absent because its name is not known. A regexp function that answered 0 for a NULL value instead of NULL would put `unknown` here too.
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "notMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^a" },
      }),
    ).resolves.toEqual(["grace", "lin"]);
  });

  it("fails loudly rather than answering wrongly when REGEXP is not registered", () => {
    // The one thing the SQLite dialect asks of its caller, and the reason asking is acceptable: an unregistered REGEXP is a query error naming the missing function, not a fragment that quietly matches nothing.
    const bare = new Database(":memory:");
    try {
      bare.exec(SCHEMA);
      const compiled = compilePredicateNode(
        {
          kind: "textCompare",
          op: "matches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a" },
        },
        sqliteSubjectOptions,
      );
      expect(() =>
        bare
          .prepare(`SELECT id FROM subjects WHERE ${compiled.sql}`)
          .all(...compiled.params.map(bindable)),
      ).toThrow(/no such function: REGEXP/i);
    } finally {
      bare.close();
    }
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
    // The encoding PostgreSQL needs a `::boolean` on and SQLite does not, so this is where the missing annotation is shown not to matter. Executed rather than asserted as a string, because `(x IS NULL AND NULL)` is only the right encoding if SQLite really does evaluate it to FALSE for a known operand and NULL for an unknown one. Negating it is what separates those two outcomes: only the rows with a known name come back.
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
  it("executes a comparison between two literals, which needs no placeholder typed", async () => {
    // The mirror of the PostgreSQL case: there, both placeholders must carry a cast or the server rejects the statement outright; here, two bare `?` are enough, which is why the SQLite dialect emits no cast at all.
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

    const surviving = db
      .prepare<[], { count: number }>("SELECT count(*) AS count FROM subjects")
      .get();
    expect(surviving?.count).toBe(SUBJECTS.length);
  });

  it("neutralises a hostile column name into one identifier the engine rejects", () => {
    // A column name is the one caller-supplied string that has to reach the SQL text, so quoting is what makes it safe rather than parameterisation. Asserting the quoted string is not the same as establishing that SQLite reads it as a single inert identifier: this executes it, and the engine refusing it as a column that does not exist is the proof. The failure it rules out is the opposite outcome -- the injected `OR` taking effect and the fragment matching every row.
    const hostile: SqlCompileOptions = {
      dialect: "sqlite",
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
    expect(compiled.sql).toBe(`("name"" = name OR ""1" = ?)`);

    expect(() =>
      db
        .prepare(`SELECT id FROM subjects WHERE ${compiled.sql}`)
        .all(...compiled.params.map(bindable)),
    ).toThrow(/no such column/i);
  });
});

describe("the divergences the guard's refusals exist to prevent", () => {
  /**
   * Each case here refuses a tree and then measures, against this connection, the wrong answer the refusal avoided. The refusals themselves are inherited unchanged from the PostgreSQL dialect, and that inheritance is exactly what needs evidence: it would be worth nothing if SQLite's affinity system happened to agree with trilean where PostgreSQL's coercion does not.
   */

  it("refuses NaN, and measures the driver substitution that refusal exists to prevent", async () => {
    // A divergence in the opposite direction from PostgreSQL's, which is why the reason text is the dialect's own rather than a shared one. SQLite has no NaN: better-sqlite3 binds one as SQL NULL, so `NaN = NaN` is indeterminate there and matches nothing -- which happens to look like agreement -- while its negation matches nothing either, where trilean's `not(definite(false))` is definitely true and matches every row. The negation is the case that makes the divergence visible, so both are measured.
    const equality: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: { kind: "numberLiteral", value: Number.NaN },
      right: { kind: "numberLiteral", value: Number.NaN },
    };
    expect(() => compilePredicateNode(equality, sqliteSubjectOptions)).toThrow(
      /cannot compile 'numberLiteral'/,
    );

    const bound = db
      .prepare<[number], { storedType: string }>(
        "SELECT typeof(?) AS storedType",
      )
      .get(Number.NaN);
    expect(bound?.storedType).toBe("null");

    const equalityRows = db
      .prepare<[number, number], { id: string }>(
        "SELECT id FROM subjects WHERE (? = ?) ORDER BY id",
      )
      .all(Number.NaN, Number.NaN);
    expect(equalityRows.map((row) => row.id)).toEqual([]);
    await expect(evaluatorMatching(equality)).resolves.toEqual([]);

    const negation: PredicateNode = { kind: "not", operand: equality };
    const negatedRows = db
      .prepare<[number, number], { id: string }>(
        "SELECT id FROM subjects WHERE (NOT (? = ?)) ORDER BY id",
      )
      .all(Number.NaN, Number.NaN);
    expect(negatedRows.map((row) => row.id)).toEqual([]);
    await expect(evaluatorMatching(negation)).resolves.toEqual(
      SUBJECTS.map((row) => row.id).sort(),
    );
  });

  it("refuses an ordered text operand, and measures the lexicographic answer that refusal exists to prevent", () => {
    // 9 and 10 are both greater than 5. Compared under the column's own TEXT affinity, which SQLite applies to the numeric side rather than the other way round, '9' > '5' and '10' > '5' disagree -- so the row that comes back is the wrong one, with no error and no warning. trilean returns wrong-type for the same comparison and directs the caller to `textCompare`.
    const orderedText: PredicateNode = {
      kind: "compare",
      op: "gt",
      left: { kind: "reference", key: "name" },
      right: { kind: "textLiteral", value: "ada" },
    };
    expect(() =>
      compilePredicateNode(orderedText, sqliteSubjectOptions),
    ).toThrow(/cannot compile 'compare'/);

    const coerced = db
      .prepare<[number], { label: string }>(
        "SELECT label FROM coercion WHERE numeric_text > ? ORDER BY label",
      )
      .all(COERCION_THRESHOLD);
    expect(coerced.map((row) => row.label)).toEqual(["nine"]);
  });

  it("refuses an ordered boolean, and measures the integer ordering that refusal exists to prevent", () => {
    // SQLite has no boolean type, so `active > false` is an ordering over the integers 0 and 1 and answers definitely. trilean has no ordering for booleans at all.
    const orderedBoolean: PredicateNode = {
      kind: "compare",
      op: "gt",
      left: { kind: "reference", key: "active" },
      right: { kind: "booleanLiteral", value: false },
    };
    expect(() =>
      compilePredicateNode(orderedBoolean, sqliteSubjectOptions),
    ).toThrow(/cannot compile 'compare'/);

    const ordered = db
      .prepare<[number], { label: string }>(
        "SELECT label FROM coercion WHERE flag > ? ORDER BY label",
      )
      .all(FALSE_AS_INTEGER);
    expect(ordered.map((row) => row.label)).toEqual(["nine"]);
  });

  it("refuses a cross-kind comparison, and measures the coercion that refusal exists to prevent", () => {
    // No column and no affinity involved: SQLite still answers, ordering every text value above every numeric one by storage class rather than reporting a type error. trilean calls the same comparison wrong-type.
    const crossKindTree: PredicateNode = {
      kind: "compare",
      op: "gt",
      left: { kind: "reference", key: "name" },
      right: { kind: "numberLiteral", value: COERCION_THRESHOLD },
    };
    expect(() =>
      compilePredicateNode(crossKindTree, sqliteSubjectOptions),
    ).toThrow(/cannot compile 'compare'/);

    const crossKind = db
      .prepare<[string, number], { answer: number }>("SELECT (? > ?) AS answer")
      .get("abc", COERCION_THRESHOLD);
    expect(crossKind?.answer).toBe(1);
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
