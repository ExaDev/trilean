import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "./compile";
import { InvalidCollectionTableError, InvalidColumnError } from "./errors";
import type { SqlCompileOptions, SqlDialect } from "./options";

/**
 * An identifier the dialect cannot carry inside a quoted identifier is refused when the tree is compiled, with a named error, in every position the compiler quotes one and for both dialects: a column and a column inside a collection, a table, and each dot-separated segment of a qualified name, whichever of schema, table or column it is.
 *
 * The characters are the NUL character, which a quoted identifier cannot contain in either engine and which ends the statement text a driver passes to SQLite, and an unpaired UTF-16 surrogate, which has no UTF-8 form, the encoding both engines read the statement in.
 */
const UNCARRIABLE: readonly (readonly [string, string])[] = [
  ["a NUL character", "\u0000"],
  ["an unpaired high surrogate", "\ud800"],
  ["an unpaired low surrogate", "\udc00"],
];

const DIALECTS: readonly SqlDialect[] = ["postgres", "sqlite"];

function columnOptions(dialect: SqlDialect, column: string): SqlCompileOptions {
  return { dialect, columnFor: () => ({ column }) };
}

function collectionOptions(
  dialect: SqlDialect,
  table: string,
  column: string,
): SqlCompileOptions {
  return {
    dialect,
    columnFor: () => ({ column: "outer" }),
    collectionFor: () => ({
      table,
      join: "TRUE",
      columnFor: () => ({ column }),
    }),
  };
}

const exists: PredicateNode = {
  kind: "exists",
  operand: { kind: "reference", key: "k" },
};

const someItem: PredicateNode = {
  kind: "some",
  collection: "c",
  item: { kind: "exists", operand: { kind: "reference", key: "k" } },
};

const foldMax: PredicateNode = {
  kind: "exists",
  operand: {
    kind: "fold",
    collection: "c",
    combiner: { mode: "max", item: { kind: "reference", key: "k" } },
  },
};

/** Where an uncarriable character is put in a qualified name: alone, at either end, in the middle, and in each segment of a schema, table and column. */
const PLACEMENTS: readonly (readonly [string, (bad: string) => string])[] = [
  ["the whole name", (bad) => bad],
  ["the start of a name", (bad) => `${bad}col`],
  ["the end of a name", (bad) => `col${bad}`],
  ["the middle of a name", (bad) => `co${bad}l`],
  ["the schema of a qualified name", (bad) => `sch${bad}.tbl.col`],
  ["the table of a qualified name", (bad) => `sch.t${bad}bl.col`],
  ["the column of a qualified name", (bad) => `sch.tbl.c${bad}ol`],
];

describe.each(DIALECTS)(
  "the %s dialect refuses an identifier it cannot carry",
  (dialect) => {
    describe.each(UNCARRIABLE)("%s", (_label, bad) => {
      it.each(PLACEMENTS)("in a column name, at %s", (_where, place) => {
        expect(() =>
          compilePredicateNode(exists, columnOptions(dialect, place(bad))),
        ).toThrow(InvalidColumnError);
      });

      it.each(PLACEMENTS)(
        "in the column of a collection's item, at %s",
        (_where, place) => {
          expect(() =>
            compilePredicateNode(
              someItem,
              collectionOptions(dialect, "tbl", place(bad)),
            ),
          ).toThrow(InvalidColumnError);
        },
      );

      it.each(PLACEMENTS)(
        "in the column of a fold's item, at %s",
        (_where, place) => {
          expect(() =>
            compilePredicateNode(
              foldMax,
              collectionOptions(dialect, "tbl", place(bad)),
            ),
          ).toThrow(InvalidColumnError);
        },
      );

      it.each(PLACEMENTS)(
        "in a collection's table name, at %s",
        (_where, place) => {
          expect(() =>
            compilePredicateNode(
              someItem,
              collectionOptions(dialect, place(bad), "col"),
            ),
          ).toThrow(InvalidCollectionTableError);
        },
      );
    });

    it("names the identifier and says what is wrong with it", () => {
      expect(() =>
        compilePredicateNode(exists, columnOptions(dialect, "a\u0000b")),
      ).toThrow(/not a usable column identifier: .*NUL/u);
      expect(() =>
        compilePredicateNode(
          someItem,
          collectionOptions(dialect, "t\ud800", "col"),
        ),
      ).toThrow(/not a usable table identifier: .*surrogate/u);
    });

    it("still compiles a name with every other character, a well formed pair, a quote and a space", () => {
      const name = 'a "b" 😀 c';
      expect(
        compilePredicateNode(exists, columnOptions(dialect, name)).sql,
      ).toBe('("a ""b"" 😀 c" IS NOT NULL)');
    });
  },
);
