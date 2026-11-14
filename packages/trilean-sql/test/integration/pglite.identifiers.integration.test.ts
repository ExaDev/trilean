import { PGlite } from "@electric-sql/pglite";
import type { PredicateNode } from "trilean";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import { InvalidColumnError } from "../../src/errors";

/**
 * The PostgreSQL counterpart of `sqlite.identifiers.integration.test.ts`: a tree whose column cannot be carried in a quoted identifier is refused at compile time and nothing is sent to the engine.
 */
const exists: PredicateNode = {
  kind: "exists",
  operand: { kind: "reference", key: "note" },
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE subjects (id text PRIMARY KEY, note text);`);
  await db.query("INSERT INTO subjects (id, note) VALUES ($1, $2)", ["a", "x"]);
});

afterAll(async () => {
  await db.close();
});

/** Compiles for a column and runs the statement, as a caller does. */
async function select(column: string): Promise<string[]> {
  const compiled = compilePredicateNode(exists, {
    dialect: "postgres",
    columnFor: () => ({ column }),
  });
  const result = await db.query<{ id: string }>(
    `SELECT id FROM subjects WHERE ${compiled.sql}`,
    compiled.params,
  );

  return result.rows.map((row) => row.id);
}

describe("an identifier PostgreSQL cannot carry", () => {
  it.each([
    ["a NUL character", "no\u0000te"],
    ["a NUL character after the name", "note\u0000 OR 1"],
    ["an unpaired surrogate", "no\ud800te"],
  ])("with %s is refused and nothing is sent", async (_label, column) => {
    const query = vi.spyOn(db, "query");
    await expect(select(column)).rejects.toThrow(InvalidColumnError);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
  });

  it("does not stop a name that can be carried from running", async () => {
    const query = vi.spyOn(db, "query");
    await expect(select("note")).resolves.toEqual(["a"]);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
  });
});
