import Database from "better-sqlite3";
import type {
  ComputedValue,
  JsonValue,
  PredicateNode,
  Resolution,
  Resolvers,
} from "trilean";
import { evaluatePredicate } from "trilean";
import { afterAll, beforeAll, expect } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import type { SqlCompileOptions } from "../../src/options";
import { sqliteSubjectOptions } from "../../src/test-support/columns";

/**
 * The shared harness the split `sqlite.*.test.ts` files below all import: the schema, the seeded rows, the resolver bridging a row to the evaluator's own notion of "known", and the `agreeingRows` comparison every case in those files is built on.
 *
 * Splitting the original single file by tested concern (predicates, edge cases, quantifiers) is purely a file-size matter -- vitest still gives each split file its own isolated module instance, so each one opens, seeds, and closes its own in-memory connection via the `beforeAll`/`afterAll` registered here, exactly as the unsplit file did for itself.
 */

/** Exported for `sqlite.predicates.test.ts`'s own REGEXP-registration proofs, which need a second, bare connection sharing this same schema but not this file's registered `regexp` function or seeded rows. */
export const SCHEMA = `
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
 * A second, deliberately tiny table whose only purpose is the coercion proofs in `sqlite.edge-cases.test.ts`.
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

/**
 * The one correlated child table the `some`/`every`/`fold` parity suite in `sqlite.quantifiers.test.ts` needs, matching `sqliteSubjectOptionsWithTags`'s own `collectionFor` mapping (`src/test-support/columns.ts`): a subject's own tags, each carrying an optional `weight`. `"subjectId"` is quoted throughout -- schema, insert, and the mapping's own `join` string -- matching the same quoted-identifier convention the PostgreSQL/PGlite suites use for it.
 */
const TAGS_SCHEMA = `
  CREATE TABLE subject_tags (
    id          TEXT PRIMARY KEY,
    "subjectId" TEXT NOT NULL,
    tag         TEXT,
    weight      REAL
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
export const SUBJECTS: readonly SubjectRow[] = [
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

interface TagRow {
  id: string;
  subjectId: string;
  tag: string;
  weight: number | null;
}

/**
 * Every subject's own tags, seeded to exercise a distinct shape of participation each: `ada` has none (the empty-collection case); `grace`'s two weights (3, 9) straddle the `[RANGE_LOW, RANGE_HIGH]` window used in `sqlite.quantifiers.test.ts` without either one falling inside it, and one alone fails `MATCH_THRESHOLD` while the other passes; `lin` pairs one clean, participating vote with one whose `weight` is unknown; `unknown` has a single tag whose `weight` is unknown, the sole-participant indeterminate case.
 */
const TAGS: readonly TagRow[] = [
  { id: "t1", subjectId: "grace", tag: "junior", weight: 3 },
  { id: "t2", subjectId: "grace", tag: "senior", weight: 9 },
  { id: "t3", subjectId: "lin", tag: "solo", weight: 9 },
  { id: "t4", subjectId: "lin", tag: "unsure", weight: null },
  { id: "t5", subjectId: "unknown", tag: "pending", weight: null },
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a reference key against one row, mapping a NULL column to `found: false`.
 *
 * That mapping is the correspondence the whole design rests on, and stating it in one place here is what makes the parity assertions below meaningful: the evaluator is being given exactly the knowledge SQLite has about the same row, so any disagreement between them is the compiler's, not the fixture's.
 *
 * `resolveValue` also has to answer for a reference *inside* a `some`/`every`/`fold` item or filter, where `context` is the collection item itself (a plain `{ tag, weight }` object, mirroring how `evaluatePredicate` re-points its own `EvaluationContext` there) rather than the outer subject row -- `context !== undefined` is what tells the two apart, since the root evaluation is always called with `context: undefined`.
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
    resolveValue: async (key: JsonValue, context: unknown) => {
      if (context !== undefined) {
        if (typeof key !== "string" || !isPlainRecord(context)) {
          return Promise.resolve<Resolution>({ found: false });
        }
        const value = context[key];
        if (typeof value === "number") {
          return Promise.resolve<Resolution>({
            found: true,
            value: { kind: "number", value },
          });
        }
        if (typeof value === "string") {
          return Promise.resolve<Resolution>({
            found: true,
            value: { kind: "text", value },
          });
        }
        return Promise.resolve<Resolution>({ found: false });
      }
      const value = typeof key === "string" ? known[key] : undefined;
      return Promise.resolve<Resolution>(
        value === undefined ? { found: false } : { found: true, value },
      );
    },
    resolveLookup: () => {
      throw new Error("no tree in this suite uses a lookup");
    },
    resolveCollection: async (collection: JsonValue) => {
      if (collection !== "tags") return Promise.resolve([]);
      return Promise.resolve(
        TAGS.filter((tagRow) => tagRow.subjectId === row.id).map((tagRow) => ({
          tag: tagRow.tag,
          weight: tagRow.weight,
        })),
      );
    },
  };
}

/** The threshold the coercion proofs compare against: greater than the text '9' sorts, and less than the number 9 is, so a coerced comparison and an honest one disagree about it. */
export const COERCION_THRESHOLD = 5;

/** The lower of the two integers SQLite stores a boolean as, so `flag > FALSE_AS_INTEGER` is the ordering comparison trilean has no answer for. */
export const FALSE_AS_INTEGER = 0;

/**
 * Maps a compiled parameter onto something SQLite can bind.
 *
 * The one value kind that needs it is `boolean`: SQLite has no boolean type, and better-sqlite3 refuses a JS boolean outright ("SQLite3 can only bind numbers, strings, bigints, buffers, and null") rather than coercing it. That is a property of the driver and the engine, not of the compiled fragment -- `compilePredicateNode` hands back the tree's own literals unchanged in every dialect -- so the conversion belongs to the caller binding them, which is what this suite is standing in for. It is a loud failure rather than a silent one, which is why the compiler leaves it to the caller; README.md documents it alongside the `REGEXP` registration.
 */
export function bindable(value: unknown): unknown {
  return typeof value === "boolean" ? Number(value) : value;
}

export let db: Database.Database;

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
  db.exec(TAGS_SCHEMA);

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

  const insertTag = db.prepare(
    `INSERT INTO subject_tags (id, "subjectId", tag, weight) VALUES (?, ?, ?, ?)`,
  );
  for (const tagRow of TAGS) {
    insertTag.run(tagRow.id, tagRow.subjectId, tagRow.tag, tagRow.weight);
  }
});

afterAll(() => {
  db.close();
});

function selectMatching(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions> = sqliteSubjectOptions,
): string[] {
  const compiled = compilePredicateNode(node, options);
  const rows = db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM subjects WHERE ${compiled.sql} ORDER BY id`,
    )
    .all(...compiled.params.map(bindable));
  return rows.map((row) => row.id);
}

export async function evaluatorMatching(
  node: PredicateNode,
): Promise<string[]> {
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

/** Runs the tree both ways and asserts they agree, then hands back the row set so a case can also state what that set should be. Agreement alone would be satisfied by both being wrong in the same way, so every caller asserts the expected ids too. `options` defaults to `sqliteSubjectOptions`; `sqlite.quantifiers.test.ts` passes `sqliteSubjectOptionsWithTags` instead. */
export async function agreeingRows(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions> = sqliteSubjectOptions,
): Promise<string[]> {
  const viaSql = selectMatching(node, options);
  const viaEvaluator = await evaluatorMatching(node);
  expect(viaSql).toEqual(viaEvaluator);
  return viaSql;
}
