import { readFileSync } from "node:fs";
import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "./compile";
import type { SqlColumnBinding, SqlCompileOptions } from "./options";

/**
 * Every `// sql:` example in the README is the SQL the compiler emits for the tree the example compiles. The trees below are the README's, in the same order; the test compiles each, requires the README's SQL and parameters, and requires that the README holds no other example, so an example cannot go stale and a new one cannot go unchecked.
 */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const columns: Readonly<Record<string, SqlColumnBinding>> = {
  age: { column: "age", paramType: "number" },
  email: { column: "email", paramType: "text" },
  code: { column: "code", paramType: "text" },
};

function columnFor(key: string): SqlColumnBinding {
  const binding = columns[key];
  if (binding === undefined) throw new Error(`no column for ${key}`);

  return binding;
}

const rule: PredicateNode = {
  kind: "allOf",
  operands: [
    {
      kind: "compare",
      op: "gte",
      left: { kind: "reference", key: "age" },
      right: { kind: "numberLiteral", value: 18 },
    },
    {
      kind: "textCompare",
      op: "matches",
      left: { kind: "reference", key: "email" },
      right: { kind: "textLiteral", value: "@example[.]com$" },
    },
  ],
};

const portable: PredicateNode = {
  kind: "textCompare",
  op: "portableMatches",
  left: { kind: "reference", key: "code" },
  right: { kind: "textLiteral", value: "^ENA-[0-9].*$" },
};

const examples: readonly (readonly [
  string,
  PredicateNode,
  SqlCompileOptions,
])[] = [
  [
    "the PostgreSQL example",
    rule,
    { dialect: "postgres", postgresRegexpPushdown: true, columnFor },
  ],
  ["the SQLite example", rule, { dialect: "sqlite", columnFor }],
  ["the portableMatches example", portable, { dialect: "sqlite", columnFor }],
];

/** The `// sql:` and `// params:` pairs of the README, in order. */
function documented(): readonly { sql: string; params: unknown }[] {
  return [
    ...readme.matchAll(
      /^\/\/ sql: {4}(?<sql>.+)\n\/\/ params: (?<params>.+)$/gmu,
    ),
  ].map((found) => {
    const params: unknown = JSON.parse(found.groups?.params ?? "null");

    return { sql: found.groups?.sql ?? "", params };
  });
}

describe("the README's examples", () => {
  it("are all the examples the test knows", () => {
    expect(documented()).toHaveLength(examples.length);
  });

  it.each(examples.map(([name, tree, options]) => ({ name, tree, options })))(
    "$name is what the compiler emits",
    ({ name, tree, options }) => {
      const compiled = compilePredicateNode(tree, options);
      const position = examples.findIndex(([known]) => known === name);
      expect(documented()[position]).toEqual({
        sql: compiled.sql,
        params: compiled.params,
      });
    },
  );
});
