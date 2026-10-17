import { describe, expect, it } from "vitest";
import { evaluateDocument } from "./evaluate-document";

const hypotenuse = {
  kind: "call",
  fn: "squareRoot",
  args: [
    {
      kind: "arithmetic",
      op: "add",
      left: {
        kind: "arithmetic",
        op: "multiply",
        left: { kind: "reference", key: "a" },
        right: { kind: "reference", key: "a" },
      },
      right: {
        kind: "arithmetic",
        op: "multiply",
        left: { kind: "reference", key: "b" },
        right: { kind: "reference", key: "b" },
      },
    },
  ],
};

describe("evaluateDocument", () => {
  it("evaluates an expression with built-in functions and unit-carrying inputs", () => {
    const metres = ({ value }: { value: number }): unknown => ({
      kind: "number",
      value,
      unit: { m: 1 },
    });

    expect(
      evaluateDocument({
        tree: hypotenuse,
        inputs: { a: metres({ value: 3 }), b: metres({ value: 4 }) },
      }),
    ).toEqual({
      outcome: "evaluated",
      treeKind: "expression",
      evaluation: {
        status: "definite",
        value: { kind: "number", value: 5, unit: { m: 1 } },
      },
    });
  });

  it("evaluates a predicate when the root is a predicate kind", () => {
    expect(
      evaluateDocument({
        tree: {
          kind: "compare",
          op: "gt",
          left: { kind: "reference", key: "x" },
          right: { kind: "numberLiteral", value: 2 },
        },
        inputs: { x: 5 },
      }),
    ).toEqual({
      outcome: "evaluated",
      treeKind: "predicate",
      evaluation: { status: "definite", value: true },
    });
  });

  it("is indeterminate, not rejected, when an input is missing", () => {
    expect(evaluateDocument({ tree: hypotenuse })).toEqual({
      outcome: "evaluated",
      treeKind: "expression",
      evaluation: {
        status: "indeterminate",
        reason: {
          code: "not-found",
          message: 'no value found for reference key "a"',
        },
      },
    });
  });

  it("reports a built-in's domain error as an indeterminate reason", () => {
    const result = evaluateDocument({
      tree: {
        kind: "call",
        fn: "logarithm",
        args: [{ kind: "numberLiteral", value: 0 }],
      },
    });
    expect(result).toMatchObject({
      outcome: "evaluated",
      evaluation: { status: "indeterminate", reason: { code: "domain-error" } },
    });
  });

  it("reports an unregistered function as wrong-type", () => {
    expect(
      evaluateDocument({
        tree: { kind: "call", fn: "cosine", args: [] },
      }),
    ).toMatchObject({
      evaluation: { status: "indeterminate", reason: { code: "wrong-type" } },
    });
  });

  it("rejects a tree that fails its schema, naming the nested path", () => {
    expect(
      evaluateDocument({
        tree: {
          kind: "arithmetic",
          op: "add",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "textLiteral" },
        },
      }),
    ).toEqual({
      outcome: "rejected",
      reason: "invalid",
      issues: [
        "right.value: Invalid input: expected string, received undefined",
      ],
    });
  });

  it("rejects an unknown root kind as an expression problem", () => {
    const result = evaluateDocument({ tree: { kind: "nope" } });
    expect(result.outcome).toBe("rejected");
  });

  it("rejects a tree that is not an object", () => {
    expect(evaluateDocument({ tree: 3 }).outcome).toBe("rejected");
  });

  it("asks which tree a treeReference is, and honours `as`", () => {
    const tree = { kind: "treeReference", key: "stored" };
    expect(evaluateDocument({ tree })).toEqual({
      outcome: "rejected",
      reason: "ambiguous-tree-kind",
      issues: [
        '(root): a treeReference is valid as a predicate and as an expression; set `as` to "predicate" or "expression"',
      ],
    });
    expect(evaluateDocument({ tree, as: "predicate" })).toMatchObject({
      outcome: "evaluated",
      treeKind: "predicate",
      evaluation: { status: "indeterminate", reason: { code: "wrong-type" } },
    });
  });

  it("lets `as` override the kind read from the root", () => {
    expect(
      evaluateDocument({
        tree: { kind: "numberLiteral", value: 1 },
        as: "predicate",
      }).outcome,
    ).toBe("rejected");
  });

  it("rejects malformed inputs before looking at the tree", () => {
    expect(evaluateDocument({ tree: hypotenuse, inputs: { a: null } })).toEqual(
      {
        outcome: "rejected",
        reason: "invalid",
        issues: [
          "inputs.a: expected a finite number, text, boolean or a complete computed value",
        ],
      },
    );
  });

  it("lets a collection error propagate for a tree that folds over a list the inputs do not hold", () => {
    expect(() =>
      evaluateDocument({
        tree: {
          kind: "fold",
          collection: "loads",
          combiner: { mode: "max", item: { kind: "numberLiteral", value: 1 } },
        },
      }),
    ).toThrow(/the inputs hold no list of items under that name/);
  });
});

describe("evaluateDocument inputs that do not fit", () => {
  it("rejects a plain input number that is not finite", () => {
    expect(
      evaluateDocument({
        tree: { kind: "reference", key: "x" },
        inputs: { x: Number.POSITIVE_INFINITY },
      }),
    ).toEqual({
      outcome: "rejected",
      reason: "invalid",
      issues: [
        "inputs.x: expected a finite number, text, boolean or a complete computed value",
      ],
    });
  });
});

describe("evaluateDocument maxNodes", () => {
  const fiveNodes = {
    kind: "arithmetic",
    op: "add",
    left: {
      kind: "arithmetic",
      op: "add",
      left: { kind: "numberLiteral", value: 1 },
      right: { kind: "numberLiteral", value: 2 },
    },
    right: { kind: "numberLiteral", value: 3 },
  };
  const budget = { enough: 5, tooFew: 4 };

  it("refuses a tree larger than the budget with an indeterminate result", () => {
    expect(
      evaluateDocument({ tree: fiveNodes, maxNodes: budget.tooFew }),
    ).toMatchObject({
      outcome: "evaluated",
      evaluation: { status: "indeterminate" },
    });
  });

  it("evaluates the same tree when the budget covers it", () => {
    expect(
      evaluateDocument({ tree: fiveNodes, maxNodes: budget.enough }),
    ).toMatchObject({
      outcome: "evaluated",
      evaluation: { status: "definite" },
    });
  });
});
