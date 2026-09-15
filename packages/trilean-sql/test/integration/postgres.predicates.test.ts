import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import {
  subjectOptions,
  subjectOptionsWithPostgresRegexp,
} from "../../src/test-support/columns";
import { agreeingRows, client, SUBJECTS } from "./postgres-test-support";

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
    // The load-bearing case. Under two-valued logic every row appears in exactly one of a predicate and its negation, so `lin` would have to turn up here. It does not, in either engine: NOT UNKNOWN is UNKNOWN in PostgreSQL exactly as `not(indeterminate)` is indeterminate in trilean.
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

  it("compares instants across a NULL", async () => {
    await expect(
      agreeingRows({
        kind: "compare",
        op: "lt",
        left: { kind: "reference", key: "joined" },
        right: { kind: "instantLiteral", value: "2022-01-01T00:00:00Z" },
      }),
    ).resolves.toEqual(["ada", "lin"]);
  });

  it("compares booleans for equality across a NULL", async () => {
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
  it("matches a pattern with PostgreSQL's own regular-expression operator, once postgresRegexpPushdown opts into it", async () => {
    await expect(
      agreeingRows(
        {
          kind: "textCompare",
          op: "matches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^(a|g)" },
        },
        subjectOptionsWithPostgresRegexp,
      ),
    ).resolves.toEqual(["ada", "grace"]);
  });

  it("leaves a NULL operand unknown under a negated match, once postgresRegexpPushdown opts into it", async () => {
    await expect(
      agreeingRows(
        {
          kind: "textCompare",
          op: "notMatches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^a" },
        },
        subjectOptionsWithPostgresRegexp,
      ),
    ).resolves.toEqual(["grace", "lin"]);
  });

  it("refuses 'matches' by default, falling back to in-process evaluation", () => {
    expect(() =>
      compilePredicateNode(
        {
          kind: "textCompare",
          op: "matches",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "^(a|g)" },
        },
        subjectOptions,
      ),
    ).toThrow(/postgresRegexpPushdown/);
  });
});

/**
 * The equivalence claim `portableMatches`/`portableNotMatches` exist for, measured the same way as the rest of this file: compile a tree using a `trilean-regex` pattern, execute the translated PostgreSQL syntax against the real server, and compare against trilean's own evaluator -- which for these two operators means `trilean-regex`'s own NFA matcher (see `compareText` in evaluator.ts), not native `RegExp`. Agreement here is evidence about `portable-pattern.ts`'s translation, not a re-run of the `matches`/`notMatches` suite above with different operator names.
 */
describe("portableMatches/portableNotMatches (trilean-regex, translated to PostgreSQL's own syntax)", () => {
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

  it("matches a bounded-repetition character class", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^[a-z]{3,4}$" },
      }),
    ).resolves.toEqual(["ada", "lin"]);
  });

  it("matches an alternation", async () => {
    await expect(
      agreeingRows({
        kind: "textCompare",
        op: "portableMatches",
        left: { kind: "reference", key: "name" },
        right: { kind: "textLiteral", value: "^(?:ada|lin)$" },
      }),
    ).resolves.toEqual(["ada", "lin"]);
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

  it("PostgreSQL's own bare '.' already matches a newline under '~', exactly like trilean-regex's own '.', so this compiler translates it unchanged", async () => {
    // Measured directly against the server rather than trusted from documentation prose alone (see portable-pattern.ts's own doc comment on renderPostgresPattern for why): PostgreSQL's prose reads, out of context, as though '.' excludes a newline by default, but under the plain '~'/'!~' operators this compiler emits, it does not.
    const result = await client.query<{ result: boolean }>(
      "SELECT ($1::text ~ $2::text) AS result",
      ["a\nc", "a.c"],
    );
    expect(result.rows[0]?.result).toBe(true);
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
    // Executed rather than asserted as a string, because `(x IS NULL AND NULL::boolean)` is only the right encoding if PostgreSQL really does evaluate it to FALSE for a known operand and NULL for an unknown one. Negating it is what separates those two outcomes: only the rows with a known name come back.
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
