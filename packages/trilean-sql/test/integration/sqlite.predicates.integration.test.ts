import Database from "better-sqlite3";
import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import { sqliteSubjectOptions } from "../../src/test-support/columns";
import {
  agreeingRows,
  bindable,
  SCHEMA,
  SUBJECTS,
} from "./sqlite-test-support";

describe("comparisons against a column that can be NULL", () => {
  const olderThan18: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "age" },
    right: { kind: "numberLiteral", value: 18 },
  };

  it("excludes the row whose age is unknown", async () => {
    await expect(agreeingRows(olderThan18)).resolves.toEqual([
      "ada",
      "unknown",
    ]);
  });

  it("still excludes it under negation, which two-valued logic could not do", async () => {
    // The load-bearing case. Under two-valued logic every row appears in exactly one of a predicate and its negation, so `lin` would have to turn up here. It does not, in either engine: NOT UNKNOWN is UNKNOWN in SQLite exactly as `not(indeterminate)` is indeterminate in trilean.
    await expect(
      agreeingRows({ kind: "not", operand: olderThan18 }),
    ).resolves.toEqual(["grace"]);
  });

  it("keeps a row whose unknown comparison is absorbed by a true disjunct", async () => {
    await expect(
      agreeingRows({
        kind: "anyOf",
        operands: [
          olderThan18,
          {
            kind: "textCompare",
            op: "equals",
            left: { kind: "reference", key: "name" },
            right: { kind: "textLiteral", value: "lin" },
          },
        ],
      }),
    ).resolves.toEqual(["ada", "lin", "unknown"]);
  });

  it("collapses an unknown conjunct absorbed by a false one, observably under negation", async () => {
    // `unknown AND false` has to be FALSE rather than UNKNOWN, and the difference only shows through a NOT: a genuinely FALSE conjunction negates to TRUE and the row appears, whereas an UNKNOWN one would negate to UNKNOWN and it would not. `lin` appearing here is that absorption being exercised.
    await expect(
      agreeingRows({
        kind: "not",
        operand: {
          kind: "allOf",
          operands: [
            olderThan18,
            {
              kind: "textCompare",
              op: "equals",
              left: { kind: "reference", key: "name" },
              right: { kind: "textLiteral", value: "nobody" },
            },
          ],
        },
      }),
    ).resolves.toEqual(["ada", "grace", "lin"]);
  });

  it("compares instants across a NULL, as the ISO-8601 text SQLite stores them as", async () => {
    // SQLite has no timestamp type: an instant is stored and compared as text. Offset-bearing ISO-8601 in a common offset sorts chronologically as a string, which is what makes this agree with the evaluator's own instant comparison rather than merely happening to.
    await expect(
      agreeingRows({
        kind: "compare",
        op: "lt",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "2022-01-01T00:00:00Z" },
      }),
    ).resolves.toEqual(["ada", "lin"]);
  });

  it("compares booleans for equality across a NULL, as the integers SQLite stores them as", async () => {
    await expect(
      agreeingRows({
        kind: "compare",
        op: "eq",
        left: { kind: "reference", key: "active" },
        right: { kind: "booleanLiteral", value: true },
      }),
    ).resolves.toEqual(["ada", "lin"]);
  });
});

describe("exists", () => {
  const hasNote: PredicateNode = {
    kind: "exists",
    operand: { kind: "reference", key: "note" },
  };

  it("partitions the table, because it is the one predicate neither engine leaves unknown", async () => {
    const present = await agreeingRows(hasNote);
    const absent = await agreeingRows({ kind: "not", operand: hasNote });
    expect(present).toEqual(["ada", "grace"]);
    expect(absent).toEqual(["lin", "unknown"]);
    expect([...present, ...absent].sort()).toEqual(
      SUBJECTS.map((row) => row.id).sort(),
    );
  });
});

describe("textCompare", () => {
  it("matches a pattern through the registered REGEXP function", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "matches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^(a|g)" },
      }),
    ).resolves.toEqual(["ada", "grace"]);
  });

  it("leaves a NULL operand unknown under a negated match", async () => {
    // What a registered function has to get right, and the reason README.md spells the registration out rather than leaving it to the reader: `lin` is here because its name does not match, and `unknown` is absent because its name is not known. A regexp function that answered 0 for a NULL value instead of NULL would put `unknown` here too.
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "notMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^a" },
      }),
    ).resolves.toEqual(["grace", "lin"]);
  });

  it("fails loudly rather than answering wrongly when REGEXP is not registered", () => {
    // The one thing the SQLite dialect asks of its caller, and the reason asking is acceptable: an unregistered REGEXP is a query error naming the missing function, not a fragment that quietly matches nothing.
    const bare = new Database(":memory:");
    try {
      bare.exec(SCHEMA);
      const compiled = compilePredicateNode(
        {
          kind: "textCompare",
          op: "matches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a" },
        },
        sqliteSubjectOptions,
      );
      expect(() =>
        bare
          .prepare(`SELECT id FROM subjects WHERE ${compiled.sql}`)
          .all(...compiled.params.map(bindable)),
      ).toThrow(/no such function: REGEXP/i);
    } finally {
      bare.close();
    }
  });

  it("refuses matches at compile time, before ever reaching a connection, when sqliteRegexpAvailable is false", () => {
    // The target this option exists for -- Cloudflare D1 and any other SQLite-wire-compatible engine with no way to register a function at all -- can never pass the previous test's registration step, so the failure above is not merely undesirable there, it is unavoidable. This is the same tree failing the same way, but caught at `compilePredicateNode` itself rather than surfacing as a query error against a real connection.
    expect(() =>
      compilePredicateNode(
        {
          kind: "textCompare",
          op: "matches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a" },
        },
        { ...sqliteSubjectOptions, sqliteRegexpAvailable: false },
      ),
    ).toThrow(/cannot compile 'textCompare'/i);
  });
});

/**
 * The equivalence claim `portableMatches`/`portableNotMatches` exist for, measured against real SQLite: compile a tree using a `trilean-regex` pattern, execute the translated `GLOB` wildcard against a real connection, and compare against `trilean-regex`'s own NFA matcher (via `evaluatePredicate`), not against `matches`/`notMatches`'s ECMAScript path. Unlike the `matches` suite above, no function registration is needed: `GLOB` is a core SQLite feature, which is the whole point of a portable grammar existing for this dialect at all.
 *
 * Every pattern below is deliberately within the reachable subset `portable-pattern.ts` documents (a literal run, `.`, a star of `.`, an edge anchor, a safe character class) -- a pattern outside it is refused by the guard before compilation, which `guard.test.ts`/`compile.test.ts` already cover as unit tests; this file measures only what a *pushed-down* fragment actually does once it reaches a real engine.
 */
describe("portableMatches/portableNotMatches (trilean-regex, translated to a GLOB wildcard)", () => {
  it("matches a start-anchored literal prefix", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^gr" },
      }),
    ).resolves.toEqual(["grace"]);
  });

  it("matches an end-anchored literal suffix", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "a$" },
      }),
    ).resolves.toEqual(["ada"]);
  });

  it("matches '.' as exactly one wildcard character", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^a.a$" },
      }),
    ).resolves.toEqual(["ada"]);
  });

  it("matches a safe, non-negated character class", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^[ag]" },
      }),
    ).resolves.toEqual(["ada", "grace"]);
  });

  it("portableNotMatches is the negation, and still leaves an unresolved name unknown", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "portableNotMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^a" },
      }),
    ).resolves.toEqual(["grace", "lin"]);
  });

  it("fails to compile rather than answering wrongly when the pattern is outside GLOB's reachable subset", () => {
    // No query is ever executed here -- unlike the REGEXP case above, this is a compile-time refusal (the guard's, run by compilePredicateNode itself), not a runtime one. Included in this file rather than only as a unit test to state plainly, next to the fragments that do compile, which shapes do not.
    expect(() =>
      compilePredicateNode(
        {
          kind: "textCompare",
          op: "portableMatches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "ada|grace" },
        },
        sqliteSubjectOptions,
      ),
    ).toThrow(/GLOB has no alternation operator/);
  });
});

describe("memberOf", () => {
  it("matches a candidate list", async () => {
    await expect(
      agreeingRows({
        kind: "memberOf",
        op: "in",
        operand: { kind: "reference", key: "name" },
        candidates: [
          { kind: "textLiteral", value: "ada" },
          { kind: "textLiteral", value: "nobody" },
        ],
      }),
    ).resolves.toEqual(["ada"]);
  });

  it("leaves NOT IN unknown for a NULL operand", async () => {
    await expect(
      agreeingRows({
        kind: "memberOf",
        op: "notIn",
        operand: { kind: "reference", key: "name" },
        candidates: [{ kind: "textLiteral", value: "ada" }],
      }),
    ).resolves.toEqual(["grace", "lin"]);
  });

  it("compiles an empty 'in' to something that is false, not unknown, for a known operand", async () => {
    // The encoding PostgreSQL needs a `::boolean` on and SQLite does not, so this is where the missing annotation is shown not to matter. Executed rather than asserted as a string, because `(x IS NULL AND NULL)` is only the right encoding if SQLite really does evaluate it to FALSE for a known operand and NULL for an unknown one. Negating it is what separates those two outcomes: only the rows with a known name come back.
    const node: PredicateNode = {
      kind: "memberOf",
      op: "in",
      operand: { kind: "reference", key: "name" },
      candidates: [],
    };
    await expect(agreeingRows(node)).resolves.toEqual([]);
    await expect(agreeingRows({ kind: "not", operand: node })).resolves.toEqual(
      ["ada", "grace", "lin"],
    );
  });

  it("compiles an empty 'notIn' to something that is true, not unknown, for a known operand", async () => {
    const node: PredicateNode = {
      kind: "memberOf",
      op: "notIn",
      operand: { kind: "reference", key: "name" },
      candidates: [],
    };
    await expect(agreeingRows(node)).resolves.toEqual(["ada", "grace", "lin"]);
    await expect(agreeingRows({ kind: "not", operand: node })).resolves.toEqual(
      [],
    );
  });
});
