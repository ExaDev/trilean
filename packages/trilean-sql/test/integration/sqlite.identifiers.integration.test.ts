import Database from "better-sqlite3";
import type { PredicateNode } from "trilean";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import { InvalidColumnError, UnsupportedNodeError } from "../../src/errors";

/**
 * A compiled statement reaches the engine only when its identifiers can all be carried: a tree whose column cannot is refused at compile time and nothing is prepared or run, so the statement SQLite parses is always the statement that was compiled.
 */
const exists: PredicateNode = {
  kind: "exists",
  operand: { kind: "reference", key: "note" },
};

let db: Database.Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY, note TEXT);`);
  db.prepare("INSERT INTO subjects (id, note) VALUES (?, ?)").run("a", "x");
});

afterAll(() => {
  db.close();
});

/** Compiles for a column and runs the statement, as a caller does. */
function select(column: string): string[] {
  const compiled = compilePredicateNode(exists, {
    dialect: "sqlite",
    columnFor: () => ({ column }),
  });

  return db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM subjects WHERE ${compiled.sql}`,
    )
    .all(...compiled.params)
    .map((row) => row.id);
}

describe("an identifier SQLite cannot carry", () => {
  it.each([
    ["a NUL character", "no\u0000te"],
    ["a NUL character after the name", "note\u0000 OR 1"],
    ["an unpaired surrogate", "no\ud800te"],
  ])(
    "with %s is refused and the statement is never prepared",
    (_label, column) => {
      const prepare = vi.spyOn(db, "prepare");
      expect(() => select(column)).toThrow(InvalidColumnError);
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    },
  );

  it("does not stop a name that can be carried from running", () => {
    const prepare = vi.spyOn(db, "prepare");
    expect(select("note")).toEqual(["a"]);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRestore();
  });
});

describe("a text value holding a NUL", () => {
  it("is bound and compared as text by SQLite, which carries it", () => {
    const compiled = compilePredicateNode(
      {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "note" },
        right: { kind: "textLiteral", value: "x\u0000y" },
      },
      { dialect: "sqlite", columnFor: () => ({ column: "note" }) },
    );
    db.prepare("INSERT INTO subjects (id, note) VALUES (?, ?)").run(
      "nul",
      "x\u0000y",
    );
    const rows = db
      .prepare<unknown[], { id: string }>(
        `SELECT id FROM subjects WHERE ${compiled.sql}`,
      )
      .all(...compiled.params);
    expect(rows.map((row) => row.id)).toEqual(["nul"]);
  });
});

describe("a pattern or a subject with a NUL, which GLOB reads only up to", () => {
  const portable = (value: string): PredicateNode => ({
    kind: "textCompare",
    op: "portableMatches",
    left: { kind: "reference", key: "note" },
    right: { kind: "textLiteral", value },
  });
  const options = {
    dialect: "sqlite",
    columnFor: () => ({ column: "note" }),
  } as const;

  function rows(tree: PredicateNode): string[] {
    const compiled = compilePredicateNode(tree, options);

    return db
      .prepare<unknown[], { id: string }>(
        `SELECT id FROM subjects WHERE ${compiled.sql} ORDER BY id`,
      )
      .all(...compiled.params)
      .map((row) => row.id);
  }

  it("refuses a pattern with a NUL, which GLOB would read as a shorter one", () => {
    const prepare = vi.spyOn(db, "prepare");
    expect(() => rows(portable("^a\u0000b$"))).toThrow(UnsupportedNodeError);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it("matches a stored value without a NUL as the evaluator does, and never selects one with a NUL", () => {
    const insert = db.prepare("INSERT INTO subjects (id, note) VALUES (?, ?)");
    insert.run("glob-plain", "abc");
    insert.run("glob-nul", "a\u0000bc");
    insert.run("glob-nul-tail", "abc\u0000");
    // The evaluator matches `^a.*c$` against "a\u0000bc" and selects it; SQLite's GLOB would read it as "a". The value is unknown, so it is not selected, and its negation does not select it either.
    expect(rows(portable("^a.*c$"))).toEqual(["glob-plain"]);
    expect(rows({ kind: "not", operand: portable("^a.*c$") })).not.toContain(
      "glob-nul",
    );
    expect(rows(portable("^a.*c$"))).not.toContain("glob-nul-tail");
  });
});
