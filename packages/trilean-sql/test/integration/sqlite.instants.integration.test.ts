import Database from "better-sqlite3";
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
 * An instant is a point in time, so a comparison over instants selects the rows the evaluator selects, whatever offset, precision or `Z` form the parameter or the stored value is written with. SQLite has no timestamp type and the column holds text; each case compiles a tree, runs it on a real in-memory SQLite database against stored values in mixed forms, and requires the evaluator's row set.
 */
/** Fewer distinct row sets than this among the comparisons would mean the stored forms and parameters are too alike to tell a wrong comparison from a right one. */
const DISTINCT_ROW_SETS = 8;

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE moments (id TEXT PRIMARY KEY, at TEXT);
    CREATE TABLE marks (id TEXT PRIMARY KEY, "momentId" TEXT NOT NULL, mark TEXT);
  `);
  const insertMoment = db.prepare("INSERT INTO moments (id, at) VALUES (?, ?)");
  for (const moment of MOMENTS) insertMoment.run(moment.id, moment.at);
  const insertMark = db.prepare(
    `INSERT INTO marks (id, "momentId", mark) VALUES (?, ?, ?)`,
  );
  for (const mark of MARKS) insertMark.run(mark.id, mark.momentId, mark.mark);
});

afterAll(() => {
  db.close();
});

function viaSqlite(tree: PredicateNode): string[] {
  const compiled = compilePredicateNode(tree, momentOptions("sqlite"));

  return db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM moments WHERE ${compiled.sql} ORDER BY id`,
    )
    .all(...compiled.params)
    .map((row) => row.id);
}

describe("instants on SQLite select the rows the evaluator selects", () => {
  const cases = [
    ...comparisons(),
    ...reversedComparisons(),
    ...MEMBERSHIPS,
    ...COLLECTIONS,
  ];

  it.each(cases)("$label", async ({ tree }) => {
    expect(viaSqlite(tree)).toEqual(await evaluatorRows(tree));
  });

  it("selects different rows for different instants, so agreement is not agreement on nothing", async () => {
    const selected = await Promise.all(
      comparisons().map(async ({ tree }) => (await evaluatorRows(tree)).join()),
    );
    expect(new Set(selected).size).toBeGreaterThan(DISTINCT_ROW_SETS);
  });
});
