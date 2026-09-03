import type { ExpressionNode, PredicateNode } from "trilean";
import { describe, expect, it, vi } from "vitest";
import { findUnpushableNodeKind } from "./guard";
import { sqliteSubjectOptions, subjectOptions } from "./test-support/columns";

const ageOver: PredicateNode = {
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "age" },
  right: { kind: "numberLiteral", value: 18 },
};

describe("supported trees", () => {
  it("passes a tree built only from the kinds the compiler translates", () => {
    const node: PredicateNode = {
      kind: "allOf",
      operands: [
        { kind: "not", operand: ageOver },
        {
          kind: "or",
          left: { kind: "exists", operand: { kind: "reference", key: "note" } },
          right: {
            kind: "textCompare",
            op: "matches",
            left: { kind: "reference", key: "name" },
            right: { kind: "textLiteral", value: "^a" },
          },
        },
        {
          kind: "memberOf",
          op: "notIn",
          operand: { kind: "reference", key: "age" },
          candidates: [{ kind: "numberLiteral", value: 3 }],
        },
      ],
    };

    expect(findUnpushableNodeKind(node, subjectOptions)).toBeUndefined();
  });

  it("does not consult columnFor when called without options", () => {
    const columnFor = vi.fn(() => ({ column: "age" }));
    expect(findUnpushableNodeKind(ageOver, undefined)).toBeUndefined();
    expect(columnFor).not.toHaveBeenCalled();
  });
});

describe("predicate kinds this version does not translate", () => {
  it.each([
    [
      "some",
      { kind: "some", collection: "xs", item: ageOver } satisfies PredicateNode,
    ],
    [
      "every",
      {
        kind: "every",
        collection: "xs",
        item: ageOver,
      } satisfies PredicateNode,
    ],
    [
      "treeReference",
      { kind: "treeReference", key: "other" } satisfies PredicateNode,
    ],
  ])("refuses '%s'", (kind, node) => {
    expect(findUnpushableNodeKind(node, subjectOptions)).toMatchObject({
      kind,
      path: "$",
    });
  });

  it("reports the path of a refused node nested inside the tree", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "allOf",
          operands: [
            ageOver,
            { kind: "not", operand: { kind: "treeReference", key: "other" } },
          ],
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "treeReference", path: "$.operands[1].operand" });
  });
});

describe("expression kinds this version does not translate", () => {
  const unsupported: readonly [string, ExpressionNode][] = [
    ["durationLiteral", { kind: "durationLiteral", value: 5, unit: "min" }],
    ["complexLiteral", { kind: "complexLiteral", re: 1, im: 2 }],
    [
      "arithmetic",
      {
        kind: "arithmetic",
        op: "add",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "numberLiteral", value: 2 },
      },
    ],
    [
      "negate",
      { kind: "negate", operand: { kind: "numberLiteral", value: 1 } },
    ],
    ["call", { kind: "call", fn: "round", args: [] }],
    ["lookup", { kind: "lookup", table: "rates", keys: [] }],
    [
      "conditional",
      {
        kind: "conditional",
        cases: [],
        fallback: { kind: "numberLiteral", value: 0 },
      },
    ],
    [
      "fold",
      {
        kind: "fold",
        collection: "xs",
        combiner: { mode: "max", item: { kind: "numberLiteral", value: 1 } },
      },
    ],
    ["accumulator", { kind: "accumulator" }],
    ["delegate", { kind: "delegate", system: "legacy", payload: null }],
    ["treeReference", { kind: "treeReference", key: "other" }],
  ];

  it.each(unsupported)("refuses '%s' in a comparison operand", (kind, node) => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "age" },
          right: node,
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind, path: "$.right" });
  });
});

describe("references the compiler cannot map", () => {
  it("refuses a non-string reference key", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "exists",
          operand: { kind: "reference", key: { nested: "key" } },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "reference", path: "$.operand" });
  });

  it("refuses a reference declaring a unit, which no column can be checked against", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "age", unit: { year: 1 } },
          right: { kind: "numberLiteral", value: 18 },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "reference", path: "$.left" });
  });

  it("refuses a unit-tagged number literal", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "age" },
          right: { kind: "numberLiteral", value: 18, unit: { year: 1 } },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "numberLiteral", path: "$.right" });
  });

  it("refuses a NaN number literal, which the two engines compare oppositely", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "age" },
          right: { kind: "numberLiteral", value: Number.NaN },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "numberLiteral", path: "$.right" });
  });

  it("refuses a NaN candidate inside a memberOf, not only a comparison operand", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "memberOf",
          op: "in",
          operand: { kind: "reference", key: "age" },
          candidates: [
            { kind: "numberLiteral", value: 1 },
            { kind: "numberLiteral", value: Number.NaN },
          ],
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "numberLiteral", path: "$.candidates[1]" });
  });

  it("allows an infinity, which both engines order and compare identically", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "numberLiteral", value: Number.POSITIVE_INFINITY },
          right: { kind: "reference", key: "age" },
        },
        subjectOptions,
      ),
    ).toBeUndefined();
  });
});

describe("operand kinds trilean and PostgreSQL would answer differently", () => {
  it("refuses a compare whose operands are of different declared kinds", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "age" },
          right: { kind: "instantLiteral", value: "2020-01-01T00:00:00Z" },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "compare", path: "$" });
  });

  it("refuses a compare against text, which trilean directs to textCompare", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "name" },
          right: { kind: "textLiteral", value: "ada" },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "compare", path: "$" });
  });

  it("refuses an ordering comparison on booleans, which trilean has no order for", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "active" },
          right: { kind: "booleanLiteral", value: false },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "compare", path: "$" });
  });

  it("allows equality on booleans, which trilean does define", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "eq",
          left: { kind: "reference", key: "active" },
          right: { kind: "booleanLiteral", value: false },
        },
        subjectOptions,
      ),
    ).toBeUndefined();
  });

  it("refuses a textCompare against a non-text operand", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "textCompare",
          op: "equals",
          left: { kind: "reference", key: "age" },
          right: { kind: "textLiteral", value: "18" },
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "textCompare", path: "$" });
  });

  it("refuses a memberOf whose candidates are not all of the operand's kind", () => {
    expect(
      findUnpushableNodeKind(
        {
          kind: "memberOf",
          op: "in",
          operand: { kind: "reference", key: "age" },
          candidates: [
            { kind: "numberLiteral", value: 1 },
            { kind: "textLiteral", value: "two" },
          ],
        },
        subjectOptions,
      ),
    ).toMatchObject({ kind: "memberOf", path: "$" });
  });

  it("cannot detect a mismatch against a column with no declared paramType", () => {
    // Not a gap to fix by guessing: without a declared type there is nothing to compare the literal's kind against. It is the concrete reason to declare paramType, and stating it as a test keeps the limitation deliberate.
    expect(
      findUnpushableNodeKind(
        {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "note" },
          right: { kind: "numberLiteral", value: 1 },
        },
        subjectOptions,
      ),
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
