import { PGlite } from "@electric-sql/pglite";
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
import { subjectOptions } from "../../src/test-support/columns";

/**
 * The shared harness the split `pglite.*.test.ts` files below all import: the in-process database lifecycle, the seeded rows, the resolver bridging a row to the evaluator's own notion of "known", and the `agreeingRows` comparison every case in those files is built on.
 *
 * Splitting the original single file by tested concern (predicates, edge cases, quantifiers) is purely a file-size matter -- vitest still gives each split file its own isolated module instance, so each one opens, seeds, and closes its own PGlite instance via the `beforeAll`/`afterAll` registered here, exactly as the unsplit file did for itself.
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

/**
 * The one correlated child table the `some`/`every`/`fold` parity suite in `pglite.quantifiers.test.ts` needs, matching `subjectOptionsWithTags`'s own `collectionFor` mapping (`src/test-support/columns.ts`): a subject's own tags, each carrying an optional `weight`. `"subjectId"` is quoted throughout -- schema, insert, and the mapping's own `join` string -- so its declared case survives PostgreSQL's default unquoted-identifier folding.
 */
const TAGS_SCHEMA = `
  CREATE TABLE subject_tags (
    id          text PRIMARY KEY,
    "subjectId" text NOT NULL,
    tag         text,
    weight      double precision
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
 * Every subject's own tags, seeded to exercise a distinct shape of participation each: `ada` has none (the empty-collection case); `grace`'s two weights (3, 9) straddle the `[RANGE_LOW, RANGE_HIGH]` window used in `pglite.quantifiers.test.ts` without either one falling inside it, and one alone fails `MATCH_THRESHOLD` while the other passes; `lin` pairs one clean, participating vote with one whose `weight` is unknown; `unknown` has a single tag whose `weight` is unknown, the sole-participant indeterminate case.
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
 * That mapping is the correspondence the whole design rests on, and stating it in one place here is what makes the parity assertions below meaningful: the evaluator is being given exactly the knowledge PostgreSQL has about the same row, so any disagreement between them is the compiler's, not the fixture's.
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

export let db: PGlite;

beforeAll(async () => {
  // No connection string, no port, no container: an in-memory database that exists for the lifetime of this process.
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(TAGS_SCHEMA);
  for (const row of SUBJECTS) {
    await db.query(
      "INSERT INTO subjects (id, age, name, active, joined, note) VALUES ($1, $2, $3, $4, $5, $6)",
      [row.id, row.age, row.name, row.active, row.joined, row.note],
    );
  }
  for (const tagRow of TAGS) {
    await db.query(
      `INSERT INTO subject_tags (id, "subjectId", tag, weight) VALUES ($1, $2, $3, $4)`,
      [tagRow.id, tagRow.subjectId, tagRow.tag, tagRow.weight],
    );
  }
});

afterAll(async () => {
  await db.close();
});

async function selectMatching(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions> = subjectOptions,
): Promise<string[]> {
  const compiled = compilePredicateNode(node, options);
  const result = await db.query<{ id: string }>(
    `SELECT id FROM subjects WHERE ${compiled.sql} ORDER BY id`,
    compiled.params,
  );
  return result.rows.map((row) => row.id);
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

/** Runs the tree both ways and asserts they agree, then hands back the row set so a case can also state what that set should be. Agreement alone would be satisfied by both being wrong in the same way, so every caller asserts the expected ids too. `options` defaults to `subjectOptions`; a case exercising `matches`/`notMatches` passes `subjectOptionsWithPostgresRegexp`, since pushdown of those two is refused by default. */
export async function agreeingRows(
  node: PredicateNode,
  options: Readonly<SqlCompileOptions> = subjectOptions,
): Promise<string[]> {
  const [viaSql, viaEvaluator] = await Promise.all([
    selectMatching(node, options),
    evaluatorMatching(node),
  ]);
  expect(viaSql).toEqual(viaEvaluator);
  return viaSql;
}
