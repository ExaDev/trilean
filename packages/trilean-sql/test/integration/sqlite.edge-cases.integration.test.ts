import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import type { SqlCompileOptions } from "../../src/options";
import { sqliteSubjectOptions } from "../../src/test-support/columns";
import {
  agreeingRows,
  bindable,
  COERCION_THRESHOLD,
  db,
  evaluatorMatching,
  FALSE_AS_INTEGER,
  SUBJECTS,
} from "./sqlite-test-support";

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
