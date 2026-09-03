import type { ExpressionNode, PredicateNode } from "trilean";
import { describe, expect, it, vi } from "vitest";
import { findUnpushableNodeKind } from "./guard";
import { subjectOptions } from "./test-support/columns";

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
