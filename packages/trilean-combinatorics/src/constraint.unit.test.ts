import type { Dimension, PartialAssignment, Value } from "combinatrix";
import {
  ConstraintContractError,
  choice,
  collect,
  computed,
  defineModel,
} from "combinatrix";
import type { ExpressionNode, PredicateNode } from "trilean";
import {
  DEFAULT_MAX_EVALUATION_NODES,
  DEFAULT_MAX_NESTING_DEPTH,
} from "trilean";
import { describe, expect, it } from "vitest";
import {
  EvaluationBudgetError,
  PredicateTreeError,
  UndecidedConstraintError,
  UnmappableValueError,
  trileanConstraint,
} from "./index";

/** The ratio values the tests use, and one strictly between them. */
const LOW = 0.3;
const HIGH = 0.5;
const BETWEEN = 0.4;

const ref = (key: string): ExpressionNode => ({ kind: "reference", key });
const text = (value: string): ExpressionNode => ({
  kind: "textLiteral",
  value,
});
const number = (value: number): ExpressionNode => ({
  kind: "numberLiteral",
  value,
});
const exists = (key: string): PredicateNode => ({
  kind: "exists",
  operand: ref(key),
});
const and = (left: PredicateNode, right: PredicateNode): PredicateNode => ({
  kind: "and",
  left,
  right,
});

const dimensions: readonly Dimension[] = [
  choice("mode", [undefined, "fast", "safe"]),
  choice("ratio", [undefined, LOW, HIGH]),
  choice("cache", [true, false]),
];

/** An assignment from an object: a key present is assigned (to unset when its value is `undefined`), a key absent is unassigned. */
const assigned = (values: Readonly<Record<string, Value>>): PartialAssignment =>
  new Map(Object.entries(values));

describe("trileanConstraint: values and absence", () => {
  const fast = trileanConstraint(
    {
      kind: "textCompare",
      op: "equals",
      left: ref("mode"),
      right: text("fast"),
    },
    { dimensions },
  );

  it("maps a string to text, a number to a number and a boolean to a boolean", () => {
    expect(fast.evaluate(assigned({ mode: "fast" }))).toBe("valid");
    expect(fast.evaluate(assigned({ mode: "safe" }))).toBe("invalid");
    const ratio = trileanConstraint(
      { kind: "compare", op: "gt", left: ref("ratio"), right: number(BETWEEN) },
      { dimensions },
    );
    expect(ratio.evaluate(assigned({ ratio: HIGH }))).toBe("valid");
    expect(ratio.evaluate(assigned({ ratio: LOW }))).toBe("invalid");
    const cache = trileanConstraint(
      {
        kind: "memberOf",
        op: "in",
        operand: ref("cache"),
        candidates: [{ kind: "booleanLiteral", value: true }],
      },
      { dimensions },
    );
    expect(cache.evaluate(assigned({ cache: true }))).toBe("valid");
    expect(cache.evaluate(assigned({ cache: false }))).toBe("invalid");
  });

  it("reads an unset dimension as known absent, so exists is definitely false", () => {
    const set = trileanConstraint(exists("mode"), { dimensions });
    expect(set.evaluate(assigned({ mode: undefined }))).toBe("invalid");
    expect(set.evaluate(assigned({ mode: "safe" }))).toBe("valid");
  });

  it("reads an unassigned dimension as not yet known, so exists is unknown", () => {
    const set = trileanConstraint(exists("mode"), { dimensions });
    expect(set.evaluate(assigned({}))).toBe("unknown");
    expect(
      trileanConstraint(
        { kind: "not", operand: exists("mode") },
        { dimensions },
      ).evaluate(assigned({ ratio: LOW })),
    ).toBe("unknown");
  });

  it("answers definitely before every dependency is assigned when Kleene absorption decides", () => {
    const either: PredicateNode = {
      kind: "or",
      left: exists("mode"),
      right: exists("ratio"),
    };
    const constraint = trileanConstraint(either, { dimensions });
    expect(constraint.evaluate(assigned({ mode: "fast" }))).toBe("valid");
    expect(constraint.evaluate(assigned({ mode: undefined }))).toBe("unknown");
  });

  it("throws UndecidedConstraintError for an unguarded comparison on an unset dimension once everything is assigned", () => {
    expect(fast.evaluate(assigned({}))).toBe("unknown");
    expect(() => fast.evaluate(assigned({ mode: undefined }))).toThrow(
      UndecidedConstraintError,
    );
    try {
      fast.evaluate(assigned({ mode: undefined }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConstraintContractError);
      expect(error).toMatchObject({ reason: { code: "not-found" } });
    }
  });

  it("is definitely false on an unset dimension when the comparison is guarded with exists", () => {
    const guarded = trileanConstraint(
      and(exists("mode"), {
        kind: "textCompare",
        op: "equals",
        left: ref("mode"),
        right: text("fast"),
      }),
      { dimensions },
    );
    expect(guarded.evaluate(assigned({ mode: undefined }))).toBe("invalid");
    expect(guarded.evaluate(assigned({ mode: "fast" }))).toBe("valid");
    expect(guarded.evaluate(assigned({}))).toBe("unknown");
  });

  it("throws UndecidedConstraintError for a comparison of the wrong kinds once everything is assigned", () => {
    const wrong = trileanConstraint(
      { kind: "compare", op: "gt", left: ref("mode"), right: number(1) },
      { dimensions },
    );
    expect(() => wrong.evaluate(assigned({ mode: "fast" }))).toThrow(
      /wrong-type/u,
    );
  });

  it("names the dimensions the tree references, once each, in the order first met", () => {
    const constraint = trileanConstraint(
      {
        kind: "allOf",
        operands: [exists("ratio"), exists("mode"), exists("ratio")],
      },
      { dimensions, name: "both" },
    );
    expect(constraint.dependencies).toEqual(["ratio", "mode"]);
    expect(constraint.name).toBe("both");
  });

  it("evaluates call nodes through the given registry", () => {
    const constraint = trileanConstraint(
      {
        kind: "compare",
        op: "eq",
        left: { kind: "call", fn: "double", args: [ref("ratio")] },
        right: number(1),
      },
      {
        dimensions,
        functions: {
          double: ([argument]) =>
            argument?.kind === "number"
              ? { kind: "number", value: argument.value * 2 }
              : { wrongType: "double takes a number" },
        },
      },
    );
    expect(constraint.evaluate(assigned({ ratio: HIGH }))).toBe("valid");
    expect(constraint.evaluate(assigned({ ratio: LOW }))).toBe("invalid");
  });

  it("throws UnmappableValueError when a computed dimension it reads produces null", () => {
    const withComputed: readonly Dimension[] = [
      ...dimensions,
      computed("label", {
        reads: ["mode"],
        compute: (values) => (values.mode === undefined ? null : "named"),
      }),
    ];
    const constraint = trileanConstraint(exists("label"), {
      dimensions: withComputed,
    });
    expect(constraint.evaluate(assigned({ label: "named" }))).toBe("valid");
    expect(() => constraint.evaluate(assigned({ label: null }))).toThrow(
      UnmappableValueError,
    );
  });
});

describe("trileanConstraint: definition-time checks", () => {
  const issuesOf = (tree: unknown, functions = {}): readonly string[] => {
    try {
      trileanConstraint(tree, { dimensions, functions });
    } catch (error) {
      if (error instanceof PredicateTreeError) return error.issues;
      throw error;
    }

    throw new Error("expected a PredicateTreeError");
  };

  it("refuses JSON that is not a predicate tree", () => {
    expect(issuesOf({ kind: "maybe" })).toHaveLength(1);
    expect(issuesOf({ kind: "maybe" })[0]).toMatch(/^\$/u);
  });

  it.each([
    ["some", { kind: "some", collection: "items", item: exists("mode") }],
    ["every", { kind: "every", collection: "items", item: exists("mode") }],
    ["treeReference", { kind: "treeReference", key: "other" }],
    [
      "lookup",
      { kind: "exists", operand: { kind: "lookup", table: "t", keys: [] } },
    ],
    [
      "delegate",
      {
        kind: "exists",
        operand: { kind: "delegate", system: "s", payload: null },
      },
    ],
    [
      "fold",
      {
        kind: "exists",
        operand: {
          kind: "fold",
          collection: "items",
          combiner: { mode: "max", item: { kind: "accumulator" } },
        },
      },
    ],
    ["accumulator", { kind: "exists", operand: { kind: "accumulator" } }],
  ])("refuses a %s node", (kind, tree) => {
    expect(issuesOf(tree)).toEqual([
      expect.stringContaining(`"${kind}" is not supported`),
    ]);
  });

  it("refuses a reference key that is not a string, one naming no dimension, and one with a unit, listing each", () => {
    const issues = issuesOf({
      kind: "allOf",
      operands: [
        { kind: "exists", operand: { kind: "reference", key: ["mode"] } },
        exists("missing"),
        {
          kind: "exists",
          operand: { kind: "reference", key: "ratio", unit: { s: 1 } },
        },
      ],
    });
    expect(issues).toEqual([
      expect.stringMatching(/^\$\.operands\[0\]\.operand: .*not a string/u),
      expect.stringMatching(
        /^\$\.operands\[1\]\.operand: .*"missing" names no dimension/u,
      ),
      expect.stringMatching(/^\$\.operands\[2\]\.operand: .*carries a unit/u),
    ]);
  });

  it("refuses a call to a function the registry does not hold, inherited names included", () => {
    expect(
      issuesOf({
        kind: "exists",
        operand: { kind: "call", fn: "toString", args: [] },
      }),
    ).toEqual([expect.stringContaining('calls "toString"')]);
  });

  it("refuses a referenced dimension that can take null", () => {
    expect(() =>
      trileanConstraint(exists("nullable"), {
        dimensions: [choice("nullable", [null, "x"])],
      }),
    ).toThrow(/can take null/u);
  });

  it("accepts a tree at the evaluator's node budget and refuses one node more", () => {
    // allOf (1 node) over exists(literal) operands (2 nodes each), with one exists(negate(literal)) (3 nodes) making the total exactly the budget, which is even.
    const allOfNodes = 1;
    const negatedOperandNodes = 3;
    const twoNodeOperands =
      (DEFAULT_MAX_EVALUATION_NODES - allOfNodes - negatedOperandNodes) / 2;
    const atBudget: PredicateNode = {
      kind: "allOf",
      operands: [
        ...Array.from({ length: twoNodeOperands }, (): PredicateNode => ({
          kind: "exists",
          operand: number(1),
        })),
        { kind: "exists", operand: { kind: "negate", operand: number(1) } },
      ],
    };
    expect(
      trileanConstraint(atBudget, { dimensions }).evaluate(new Map()),
    ).toBe("valid");
    const overBudget: PredicateNode = {
      kind: "not",
      operand: atBudget,
    };
    expect(() => trileanConstraint(overBudget, { dimensions })).toThrow(
      EvaluationBudgetError,
    );
  });

  it("accepts a tree nested to just below the evaluator's depth budget and refuses one level deeper", () => {
    const chain = (depth: number): PredicateNode => {
      // exists(literal) puts the literal one level below the exists, so `depth - 1` nots above it make the literal's depth `depth`.
      let tree: PredicateNode = { kind: "exists", operand: number(1) };
      for (let level = 0; level < depth - 1; level += 1) {
        tree = { kind: "not", operand: tree };
      }

      return tree;
    };
    const deepest = DEFAULT_MAX_NESTING_DEPTH - 1;
    const accepted = trileanConstraint(chain(deepest), { dimensions });
    expect(["valid", "invalid"]).toContain(accepted.evaluate(new Map()));
    expect(() => trileanConstraint(chain(deepest + 1), { dimensions })).toThrow(
      EvaluationBudgetError,
    );
  });
});

describe("trileanConstraint in a model", () => {
  it("restricts the solution set exactly as filtering the product with the tree would", () => {
    const tree: PredicateNode = {
      kind: "or",
      left: { kind: "not", operand: exists("mode") },
      right: and(exists("ratio"), {
        kind: "compare",
        op: "gte",
        left: ref("ratio"),
        right: number(HIGH),
      }),
    };
    const model = defineModel({
      dimensions,
      constraints: [trileanConstraint(tree, { dimensions })],
    });
    const rows = collect(model, { limit: 100 }).map(({ values }) => values);
    const expected = [undefined, "fast", "safe"].flatMap((mode) =>
      [undefined, LOW, HIGH].flatMap((ratio) =>
        [true, false]
          .map((cache) => ({ mode, ratio, cache }))
          .filter(() => mode === undefined || ratio === HIGH),
      ),
    );
    expect(rows).toEqual(expected);
  });
});
