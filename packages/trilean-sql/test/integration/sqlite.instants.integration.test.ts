import Database from "better-sqlite3";
import type { PredicateNode } from "trilean";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import {
  COLLECTIONS,
  MARKS,
  MEMBERSHIPS,
  MOMENTS,
  REJECTED,
  SQLITE_ONLY,
  SQLITE_ONLY_PARAMETERS,
  PARAMETERS,
  OPERATORS,
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

/** The number of rejected forms the suite must hold at least, so a list emptied by an edit fails. */
const MINIMUM_REJECTED_FORMS = 30;

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE moments (id TEXT PRIMARY KEY, at TEXT);
    CREATE TABLE rejected (id TEXT PRIMARY KEY, at);
    CREATE TABLE marks (id TEXT PRIMARY KEY, "momentId" TEXT NOT NULL, mark TEXT);
  `);
  const insertMoment = db.prepare("INSERT INTO moments (id, at) VALUES (?, ?)");
  for (const moment of [...MOMENTS, ...SQLITE_ONLY]) {
    insertMoment.run(moment.id, moment.at);
  }
  const insertRejected = db.prepare(
    "INSERT INTO rejected (id, at) VALUES (?, ?)",
  );
  for (const row of REJECTED) insertRejected.run(row.id, row.at);
  const insertMark = db.prepare(
    `INSERT INTO marks (id, "momentId", mark) VALUES (?, ?, ?)`,
  );
  for (const mark of MARKS) insertMark.run(mark.id, mark.momentId, mark.mark);
});

afterAll(() => {
  db.close();
});

function viaSqlite(tree: PredicateNode, table = "moments"): string[] {
  const compiled = compilePredicateNode(tree, momentOptions("sqlite"));

  return db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM ${table} WHERE ${compiled.sql} ORDER BY id`,
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
    expect(viaSqlite(tree).filter((id) => !id.startsWith("x-"))).toEqual(
      await evaluatorRows(tree),
    );
  });

  it.each(comparisons([...PARAMETERS, ...SQLITE_ONLY_PARAMETERS]))(
    "with the grammar's edges: $label",
    async ({ tree }) => {
      expect(viaSqlite(tree)).toEqual(
        await evaluatorRows(tree, [...MOMENTS, ...SQLITE_ONLY]),
      );
    },
  );

  it("selects different rows for different instants, so agreement is not agreement on nothing", async () => {
    const selected = await Promise.all(
      comparisons().map(async ({ tree }) => (await evaluatorRows(tree)).join()),
    );
    expect(new Set(selected).size).toBeGreaterThan(DISTINCT_ROW_SETS);
  });

  it("selects fewer rows when a stored value is out of the grammar than the grammar's rows would", () => {
    expect(REJECTED.length).toBeGreaterThan(MINIMUM_REJECTED_FORMS);
  });
});

describe("a stored value outside the grammar is unknown, whatever SQLite's date functions would make of it", () => {
  const parameters = [...PARAMETERS, ...SQLITE_ONLY_PARAMETERS];
  const trees: readonly { label: string; tree: PredicateNode }[] =
    OPERATORS.flatMap((op) =>
      parameters.flatMap((value) => {
        const compare: PredicateNode = {
          kind: "compare",
          op,
          left: { kind: "reference", key: "at" },
          right: { kind: "instantLiteral", value },
        };

        return [
          { label: `${op} ${value}`, tree: compare },
          {
            label: `not (${op} ${value})`,
            tree: { kind: "not", operand: compare },
          },
        ];
      }),
    );

  it.each(trees)("selects none of them for $label", ({ tree }) => {
    expect(viaSqlite(tree, "rejected")).toEqual([]);
  });

  it("selects none of them for an exists-free membership either", () => {
    const membership = (op: "in" | "notIn"): PredicateNode => ({
      kind: "memberOf",
      op,
      operand: { kind: "reference", key: "at" },
      candidates: [{ kind: "instantLiteral", value: "2020-01-01T00:00:00Z" }],
    });
    expect(viaSqlite(membership("in"), "rejected")).toEqual([]);
    expect(viaSqlite(membership("notIn"), "rejected")).toEqual([]);
  });

  it("gives the same answer on two runs, whatever the clock says", () => {
    const tree = trees.find(({ label }) => label.startsWith("gt "))?.tree;
    if (tree === undefined) throw new Error("no tree");
    expect(viaSqlite(tree, "rejected")).toEqual(viaSqlite(tree, "rejected"));
  });
});
