import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "./compile";
import {
  InvalidCollectionTableError,
  InvalidColumnError,
  type TrileanSqlError,
  UnsupportedNodeError,
} from "./errors";
import { findUnpushableNodeKind } from "./guard";
import type { SqlCompileOptions, SqlDialect } from "./options";

/**
 * The refusal table of identifiers and values a dialect cannot carry. Every row is run through the guard and through the compiler, and they must agree: the guard reports the tree unpushable exactly when the compiler throws, and an error says what is wrong without repeating the input.
 */
const NUL = "\u0000";
const LONE_SURROGATE = "\ud800";

/** A name or value that no refusal reason may repeat. */
const MARK = "MarkerThatMustNotAppear";

const DIALECTS: readonly SqlDialect[] = ["postgres", "sqlite"];

function optionsFor(
  dialect: SqlDialect,
  names: Readonly<{ column: string; table?: string; itemColumn?: string }>,
): SqlCompileOptions {
  return {
    dialect,
    columnFor: () => ({ column: names.column }),
    collectionFor: () => ({
      table: names.table ?? "tbl",
      join: "TRUE",
      columnFor: () => ({ column: names.itemColumn ?? "col" }),
    }),
  };
}

const reference: PredicateNode = {
  kind: "exists",
  operand: { kind: "reference", key: "k" },
};

const someOver: PredicateNode = {
  kind: "some",
  collection: "c",
  item: { kind: "exists", operand: { kind: "reference", key: "k" } },
};

const foldOver: PredicateNode = {
  kind: "exists",
  operand: {
    kind: "fold",
    collection: "c",
    combiner: { mode: "max", item: { kind: "reference", key: "k" } },
  },
};

const text = (
  op: "equals" | "matches" | "portableMatches",
  value: string,
): PredicateNode => ({
  kind: "textCompare",
  op,
  left: { kind: "reference", key: "k" },
  right: { kind: "textLiteral", value },
});

const member = (value: string): PredicateNode => ({
  kind: "memberOf",
  op: "in",
  operand: { kind: "reference", key: "k" },
  candidates: [{ kind: "textLiteral", value }],
});

const instant = (value: string): PredicateNode => ({
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "k" },
  right: { kind: "instantLiteral", value },
});

interface Row {
  readonly label: string;
  readonly tree: PredicateNode;
  readonly options: (dialect: SqlDialect) => SqlCompileOptions;
  /** The dialects that refuse it. */
  readonly refusedBy: readonly SqlDialect[];
  readonly error: new (...args: never[]) => TrileanSqlError;
}

const COLUMN_PROBLEMS: readonly (readonly [string, string])[] = [
  ["a NUL", `${MARK}${NUL}`],
  ["an unpaired surrogate", `${MARK}${LONE_SURROGATE}`],
  ["an empty name", ""],
  ["an empty segment", `${MARK}..col`],
  ["four segments", `${MARK}.a.b.c`],
];

const rows: readonly Row[] = [
  ...COLUMN_PROBLEMS.flatMap(([what, name]): readonly Row[] => [
    {
      label: `a column with ${what}`,
      tree: reference,
      options: (dialect) => optionsFor(dialect, { column: name }),
      refusedBy: DIALECTS,
      error: InvalidColumnError,
    },
    {
      label: `a collection item's column with ${what}`,
      tree: someOver,
      options: (dialect) =>
        optionsFor(dialect, { column: "outer", itemColumn: name }),
      refusedBy: DIALECTS,
      error: InvalidColumnError,
    },
    {
      label: `a fold item's column with ${what}`,
      tree: foldOver,
      options: (dialect) =>
        optionsFor(dialect, { column: "outer", itemColumn: name }),
      refusedBy: DIALECTS,
      error: InvalidColumnError,
    },
  ]),
  ...(
    [
      ["a NUL", `${MARK}${NUL}`],
      ["an unpaired surrogate", `${MARK}${LONE_SURROGATE}`],
      ["an empty name", ""],
      ["an empty segment", `${MARK}..tbl`],
      ["three segments", `${MARK}.s.t`],
    ] as const
  ).map(([what, name]): Row => ({
    label: `a collection table with ${what}`,
    tree: someOver,
    options: (dialect) => optionsFor(dialect, { column: "outer", table: name }),
    refusedBy: DIALECTS,
    error: InvalidCollectionTableError,
  })),
  {
    label: "a text value with an unpaired surrogate",
    tree: text("equals", `${MARK}${LONE_SURROGATE}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: DIALECTS,
    error: UnsupportedNodeError,
  },
  {
    label: "a membership candidate with an unpaired surrogate",
    tree: member(`${MARK}${LONE_SURROGATE}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: DIALECTS,
    error: UnsupportedNodeError,
  },
  {
    label: "an instant with an unpaired surrogate",
    tree: instant(`${MARK}${LONE_SURROGATE}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: DIALECTS,
    error: UnsupportedNodeError,
  },
  {
    label: "a portable pattern with an unpaired surrogate",
    tree: text("portableMatches", `${MARK}${LONE_SURROGATE}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: DIALECTS,
    error: UnsupportedNodeError,
  },
  {
    label: "a text value with a NUL",
    tree: text("equals", `${MARK}${NUL}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: ["postgres"],
    error: UnsupportedNodeError,
  },
  {
    label: "a membership candidate with a NUL",
    tree: member(`${MARK}${NUL}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: ["postgres"],
    error: UnsupportedNodeError,
  },
  {
    label: "an instant with a NUL",
    tree: instant(`${MARK}${NUL}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: ["postgres"],
    error: UnsupportedNodeError,
  },
  {
    label: "a portable pattern with a NUL",
    tree: text("portableMatches", `${MARK}${NUL}`),
    options: (dialect) => optionsFor(dialect, { column: "col" }),
    refusedBy: DIALECTS,
    error: UnsupportedNodeError,
  },
  {
    label: "a pushed-down pattern with a NUL",
    tree: text("matches", `${MARK}${NUL}`),
    options: (dialect) => ({
      ...optionsFor(dialect, { column: "col" }),
      postgresRegexpPushdown: true,
      sqliteRegexpAvailable: true,
    }),
    refusedBy: DIALECTS,
    error: UnsupportedNodeError,
  },
];

const accepted: readonly (readonly [
  string,
  PredicateNode,
  (d: SqlDialect) => SqlCompileOptions,
])[] = [
  [
    "a column with a quote, a space and a pair",
    reference,
    (d) => optionsFor(d, { column: `${MARK} "q" 😀` }),
  ],
  [
    "a column of three segments",
    reference,
    (d) => optionsFor(d, { column: "s.t.c" }),
  ],
  [
    "a table of two segments",
    someOver,
    (d) => optionsFor(d, { column: "outer", table: "s.t" }),
  ],
  [
    "a text value with other control characters",
    text("equals", "a\u0001\u001f\u007f\n"),
    (d) => optionsFor(d, { column: "col" }),
  ],
  [
    "a text value with a pair",
    text("equals", "😀"),
    (d) => optionsFor(d, { column: "col" }),
  ],
];

describe.each(DIALECTS)(
  "the %s dialect: guard and compiler agree on every refusal",
  (dialect) => {
    it.each(rows)("$label", (row) => {
      const options = row.options(dialect);
      const refused = row.refusedBy.includes(dialect);
      const unpushable = findUnpushableNodeKind(row.tree, options);
      let thrown: unknown;
      try {
        compilePredicateNode(row.tree, options);
      } catch (error) {
        thrown = error;
      }
      expect(unpushable !== undefined, "the guard refuses it").toBe(refused);
      expect(thrown !== undefined, "the compiler refuses it").toBe(refused);
      if (refused) {
        expect(thrown).toBeInstanceOf(row.error);
        for (const said of [
          thrown instanceof Error ? thrown.message : "",
          unpushable?.reason ?? "",
        ]) {
          expect(said).not.toContain(MARK);
          expect(said).not.toContain(NUL);
          expect(said).not.toContain(LONE_SURROGATE);
        }
      }
    });

    it.each(accepted)("accepts %s", (_label, tree, options) => {
      expect(findUnpushableNodeKind(tree, options(dialect))).toBeUndefined();
      expect(() => compilePredicateNode(tree, options(dialect))).not.toThrow();
    });
  },
);
