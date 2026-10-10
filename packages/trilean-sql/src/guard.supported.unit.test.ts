import type { ExpressionNode, PredicateNode } from "trilean";
import { describe, expect, it, vi } from "vitest";
import { findUnpushableNodeKind } from "./guard";
import { subjectOptions } from "./test-support/columns";
import { ageOver } from "./guard-test-helpers";

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
            op: "equals",
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
        combiner: {
          mode: "reduce",
          initial: { kind: "numberLiteral", value: 0 },
          combine: { kind: "numberLiteral", value: 1 },
        },
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
