import { PGlite } from "@electric-sql/pglite";
import type { PredicateNode } from "trilean";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import {
  COLLECTIONS,
  MARKS,
  MEMBERSHIPS,
  MOMENTS,
  comparisons,
  evaluatorRows,
  momentOptions,
  reversedComparisons,
} from "./instants-parity";

/**
 * The same cases as `sqlite.instants.integration.test.ts`, against PostgreSQL (PGlite): a comparison over instants selects the rows the evaluator selects whatever offset or precision either side is written with. They show that the row sets the SQLite suite requires are the ones the other engine gives, so the two engines and the evaluator agree.
 */
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE moments (id text PRIMARY KEY, at timestamptz);
    CREATE TABLE marks (id text PRIMARY KEY, "momentId" text NOT NULL, mark timestamptz);
  `);
  await Promise.all(
    MOMENTS.map(async (moment) =>
      db.query("INSERT INTO moments (id, at) VALUES ($1, $2)", [
        moment.id,
        moment.at,
      ]),
    ),
  );
  await Promise.all(
    MARKS.map(async (mark) =>
      db.query(`INSERT INTO marks (id, "momentId", mark) VALUES ($1, $2, $3)`, [
        mark.id,
        mark.momentId,
        mark.mark,
      ]),
    ),
  );
});

afterAll(async () => {
  await db.close();
});

async function viaPostgres(tree: PredicateNode): Promise<string[]> {
  const compiled = compilePredicateNode(tree, momentOptions("postgres"));
  const result = await db.query<{ id: string }>(
    `SELECT id FROM moments WHERE ${compiled.sql} ORDER BY id`,
    compiled.params,
  );

  return result.rows.map((row) => row.id);
}

describe("instants on PostgreSQL select the rows the evaluator selects", () => {
  const cases = [
    ...comparisons(),
    ...reversedComparisons(),
    ...MEMBERSHIPS,
    ...COLLECTIONS,
  ];

  it.each(cases)("$label", async ({ tree }) => {
    await expect(viaPostgres(tree)).resolves.toEqual(await evaluatorRows(tree));
  });
});
