import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import pg from "pg";
import type { PredicateNode } from "trilean";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import { InvalidColumnError, UnsupportedNodeError } from "../../src/errors";

/**
 * The PostgreSQL counterpart of `sqlite.identifiers.integration.test.ts`: a tree whose column cannot be carried in a quoted identifier is refused at compile time and nothing is sent to the engine.
 */
const exists: PredicateNode = {
  kind: "exists",
  operand: { kind: "reference", key: "note" },
};

let container: StartedPostgreSqlContainer;
let db: pg.Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  db = new pg.Client({ connectionString: container.getConnectionUri() });
  await db.connect();
  await db.query(`CREATE TABLE subjects (id text PRIMARY KEY, note text);`);
  await db.query("INSERT INTO subjects (id, note) VALUES ($1, $2)", ["a", "x"]);
});

afterAll(async () => {
  await db.end();
  await container.stop();
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

describe("a text value holding a NUL", () => {
  it("is refused at compile time, so the engine never sees it", async () => {
    const query = vi.spyOn(db, "query");
    expect(() =>
      compilePredicateNode(
        {
          kind: "textCompare",
          op: "equals",
          left: { kind: "reference", key: "note" },
          right: { kind: "textLiteral", value: "x\u0000y" },
        },
        { dialect: "postgres", columnFor: () => ({ column: "note" }) },
      ),
    ).toThrow(UnsupportedNodeError);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
    // The engine's own verdict on the same value, which is why the compiler refuses it.
    await expect(db.query("SELECT $1::text", ["x\u0000y"])).rejects.toThrow(
      /invalid byte sequence|null character/iu,
    );
  });
});

describe("a timestamp column whose name holds a quote", () => {
  it("is quoted once and the instant comparison runs and selects the later row", async () => {
    await db.query(
      `CREATE TABLE stamped (id text PRIMARY KEY, "a""b" timestamptz);`,
    );
    await Promise.all(
      [
        ["early", "2019-12-31T23:59:59Z"],
        ["late", "2020-01-01T02:00:00+02:00"],
        ["later", "2020-01-02T00:00:00Z"],
      ].map(async ([id, at]) =>
        db.query(`INSERT INTO stamped (id, "a""b") VALUES ($1, $2)`, [id, at]),
      ),
    );
    const compiled = compilePredicateNode(
      {
        kind: "compare",
        op: "gt",
        left: { kind: "reference", key: "k" },
        right: { kind: "instantLiteral", value: "2020-01-01T00:00:00Z" },
      },
      {
        dialect: "postgres",
        columnFor: () => ({ column: 'a"b', paramType: "timestamp" }),
      },
    );
    const result = await db.query<{ id: string }>(
      `SELECT id FROM stamped WHERE ${compiled.sql} ORDER BY id`,
      compiled.params,
    );
    expect(result.rows.map((row) => row.id)).toEqual(["later"]);
  });
});
