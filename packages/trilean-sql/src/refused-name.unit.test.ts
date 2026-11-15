import type { PredicateNode } from "trilean";
import { expect, it } from "vitest";
import { compilePredicateNode } from "./compile";
import { InvalidCollectionTableError, InvalidColumnError } from "./errors";
import type { SqlCompileOptions, SqlDialect } from "./options";

/**
 * An error for a name a dialect cannot carry reports the name that was refused. A reference key is mapped by the outer `columnFor` and, inside a collection, by that collection's own `columnFor`, and the two may map the same key to different columns.
 */
const DIALECTS: readonly SqlDialect[] = ["postgres", "sqlite"];

const BAD = "bad\u0000name";

function options(
  dialect: SqlDialect,
  item: string,
  table: string,
): SqlCompileOptions {
  return {
    dialect,
    columnFor: () => ({ column: "outer" }),
    collectionFor: () => ({
      table,
      join: "TRUE",
      columnFor: () => ({ column: item }),
    }),
  };
}

const someItem: PredicateNode = {
  kind: "some",
  collection: "c",
  item: { kind: "exists", operand: { kind: "reference", key: "k" } },
};

/** The error compiling raises. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  return undefined;
}

it.each(DIALECTS)(
  "reports a collection item's column, not the outer mapping's column for the same key, under %s",
  (dialect) => {
    const thrown = thrownBy(() =>
      compilePredicateNode(someItem, options(dialect, BAD, "tbl")),
    );
    expect(thrown).toBeInstanceOf(InvalidColumnError);
    expect(thrown).toMatchObject({ referenceKey: "k", column: BAD });
  },
);

it.each(DIALECTS)("reports a collection's table, under %s", (dialect) => {
  const thrown = thrownBy(() =>
    compilePredicateNode(someItem, options(dialect, "col", BAD)),
  );
  expect(thrown).toBeInstanceOf(InvalidCollectionTableError);
  expect(thrown).toMatchObject({ collectionKey: "c", table: BAD });
});
