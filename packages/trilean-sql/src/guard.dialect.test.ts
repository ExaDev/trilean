import type { PredicateNode } from "trilean";
import { describe, expect, it } from "vitest";
import { findUnpushableNodeKind } from "./guard";
import {
  sqliteSubjectOptions,
  subjectOptions,
  subjectOptionsWithPostgresRegexp,
} from "./test-support/columns";

describe("sqliteRegexpAvailable", () => {
  const patternMatch: PredicateNode = {
    kind: "textCompare",
    op: "matches",
    left: { kind: "reference", key: "name" },
    right: { kind: "textLiteral", value: "^a" },
  };

  const negatedPatternMatch: PredicateNode = {
    ...patternMatch,
    op: "notMatches",
  };

  it.each([
    ["unset", sqliteSubjectOptions],
    ["true", { ...sqliteSubjectOptions, sqliteRegexpAvailable: true }],
  ])(
    "leaves matches/notMatches pushable when the flag is %s",
    (_label, options) => {
      expect(findUnpushableNodeKind(patternMatch, options)).toBeUndefined();
      expect(
        findUnpushableNodeKind(negatedPatternMatch, options),
      ).toBeUndefined();
    },
  );

  it.each([patternMatch, negatedPatternMatch])(
    "refuses '%s' under sqlite once the flag is false",
    (node) => {
      expect(
        findUnpushableNodeKind(node, {
          ...sqliteSubjectOptions,
          sqliteRegexpAvailable: false,
        }),
      ).toMatchObject({ kind: "textCompare", path: "$" });
    },
  );

  it("has no effect on the postgres dialect, which has its own separate postgresRegexpPushdown gate", () => {
    expect(
      findUnpushableNodeKind(patternMatch, {
        ...subjectOptionsWithPostgresRegexp,
        sqliteRegexpAvailable: false,
      }),
    ).toBeUndefined();
  });

  it("leaves an equals/notEquals textCompare pushable regardless of the flag", () => {
    const equality: PredicateNode = {
      kind: "textCompare",
      op: "equals",
      left: { kind: "reference", key: "name" },
      right: { kind: "textLiteral", value: "ada" },
    };
    expect(
      findUnpushableNodeKind(equality, {
        ...sqliteSubjectOptions,
        sqliteRegexpAvailable: false,
      }),
    ).toBeUndefined();
  });
});

describe("PostgreSQL regular-expression pushdown", () => {
  const matchesNode: PredicateNode = {
    kind: "textCompare",
    op: "matches",
    left: { kind: "reference", key: "name" },
    right: { kind: "textLiteral", value: "^a" },
  };

  it("refuses 'matches' against PostgreSQL by default", () => {
    expect(findUnpushableNodeKind(matchesNode, subjectOptions)).toMatchObject({
      kind: "textCompare",
      path: "$",
    });
  });

  it("refuses 'notMatches' against PostgreSQL by default", () => {
    expect(
      findUnpushableNodeKind(
        { ...matchesNode, op: "notMatches" },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "textCompare", path: "$" });
  });

  it("refuses 'matches' against PostgreSQL with no options at all, since the default dialect is PostgreSQL and the default is refusal", () => {
    expect(findUnpushableNodeKind(matchesNode)).toMatchObject({
      kind: "textCompare",
      path: "$",
    });
  });

  it("allows 'matches' against PostgreSQL once postgresRegexpPushdown is set true", () => {
    expect(
      findUnpushableNodeKind(matchesNode, subjectOptionsWithPostgresRegexp),
    ).toBeUndefined();
  });

  it("allows 'matches' against SQLite unconditionally, since this gate is specific to PostgreSQL's own regular-expression dialect", () => {
    expect(
      findUnpushableNodeKind(matchesNode, sqliteSubjectOptions),
    ).toBeUndefined();
  });

  it("does not refuse 'equals'/'notEquals' textCompare nodes, which carry no pattern", () => {
    expect(
      findUnpushableNodeKind({ ...matchesNode, op: "equals" }, subjectOptions),
    ).toBeUndefined();
  });
});

describe("refusal reasons are worded for the dialect they describe", () => {
  // Which trees are refused is a property of the divergence, not of the dialect: every pairing below is answered definitely by both engines and wrong-typed by trilean, so both dialects refuse all of them. What changes is the explanation, and each dialect's has to name the mechanism that actually applies to it -- a reason describing PostgreSQL's NaN ordering would be simply false about SQLite, which has no NaN at all.

  const nanEquality: PredicateNode = {
    kind: "compare",
    op: "eq",
    left: { kind: "reference", key: "age" },
    right: { kind: "numberLiteral", value: Number.NaN },
  };

  const orderedText: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "name" },
    right: { kind: "textLiteral", value: "ada" },
  };

  const orderedBoolean: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "active" },
    right: { kind: "booleanLiteral", value: false },
  };

  const crossKind: PredicateNode = {
    kind: "compare",
    op: "eq",
    left: { kind: "reference", key: "age" },
    right: { kind: "instantLiteral", value: "2020-01-01T00:00:00Z" },
  };

  it.each([nanEquality, orderedText, orderedBoolean, crossKind])(
    "refuses the same node at the same path in either dialect",
    (node) => {
      const viaPostgres = findUnpushableNodeKind(node, subjectOptions);
      const viaSqlite = findUnpushableNodeKind(node, sqliteSubjectOptions);
      expect(viaPostgres).toBeDefined();
      expect(viaSqlite).toMatchObject({
        kind: viaPostgres?.kind,
        path: viaPostgres?.path,
      });
    },
  );

  it("explains a refused NaN by the substitution SQLite's drivers actually make", () => {
    // The integration suite proves this one against a real connection: better-sqlite3 binds NaN as SQL NULL, so `NaN = NaN` is indeterminate rather than definitely false, and the negation trilean answers definitely true matches nothing at all.
    expect(findUnpushableNodeKind(nanEquality, sqliteSubjectOptions)).toEqual({
      kind: "numberLiteral",
      path: "$.right",
      reason:
        "NaN is equal to nothing in trilean, not even itself, whereas SQLite has no NaN at all and a driver binding one substitutes SQL NULL -- so 'NaN = NaN' is indeterminate there rather than definitely false, and its negation matches every row instead of none",
    });
  });

  it("explains a refused NaN by PostgreSQL's own definition of it in the other dialect", () => {
    expect(findUnpushableNodeKind(nanEquality, subjectOptions)).toEqual({
      kind: "numberLiteral",
      path: "$.right",
      reason:
        "NaN is equal to nothing in trilean, not even itself, whereas PostgreSQL defines NaN as equal to itself and greater than every other double",
    });
  });

  it("explains an ordered text operand by the coercion each engine performs", () => {
    expect(
      findUnpushableNodeKind(orderedText, sqliteSubjectOptions)?.reason,
    ).toBe(
      "'compare' never compares text in trilean -- it returns wrong-type and directs the caller to 'textCompare' -- but SQLite would answer definitely for the text operand at $.left, comparing it under the text affinity it applies to the other side ('9' > 5 is true there, while '10' > 5 is not)",
    );
    expect(findUnpushableNodeKind(orderedText, subjectOptions)?.reason).toBe(
      "'compare' never compares text in trilean -- it returns wrong-type and directs the caller to 'textCompare' -- but PostgreSQL would order the text operand at $.left collation-wise and answer definitely",
    );
  });

  it("explains an ordered boolean by how each engine represents one", () => {
    expect(
      findUnpushableNodeKind(orderedBoolean, sqliteSubjectOptions)?.reason,
    ).toBe(
      "booleans have no ordering in trilean, so 'gt' against the boolean operand at $.left is wrong-type there, whereas SQLite stores booleans as the integers 0 and 1 and orders them as integers",
    );
    expect(findUnpushableNodeKind(orderedBoolean, subjectOptions)?.reason).toBe(
      "booleans have no ordering in trilean, so 'gt' against the boolean operand at $.left is wrong-type there, whereas PostgreSQL orders false before true",
    );
  });

  it("explains a cross-kind comparison by the coercion each engine reaches for", () => {
    expect(
      findUnpushableNodeKind(crossKind, sqliteSubjectOptions)?.reason,
    ).toContain(
      "whereas SQLite's type affinity may coerce one to the other and answer definitely",
    );
    expect(findUnpushableNodeKind(crossKind, subjectOptions)?.reason).toContain(
      "whereas PostgreSQL may coerce one to the other and answer definitely",
    );
  });

  it("describes PostgreSQL when no options name a dialect at all", () => {
    // A structural walk has no dialect to read. It refuses exactly what either dialect refuses -- the point of the walk is unchanged -- and names the dialect these refusals were first derived against rather than inventing a dialect-free phrasing that describes neither engine.
    expect(
      findUnpushableNodeKind({
        kind: "compare",
        op: "eq",
        left: { kind: "numberLiteral", value: Number.NaN },
        right: { kind: "numberLiteral", value: Number.NaN },
      })?.reason,
    ).toContain("PostgreSQL defines NaN as equal to itself");
  });
});
