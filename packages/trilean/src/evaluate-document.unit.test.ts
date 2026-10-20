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
        tree: { kind: "call", fn: "notARegisteredFunction", args: [] },
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

describe("evaluateDocument with the complex and trigonometric built-ins", () => {
  /** How many of each angle make half a turn. */
  const perHalfTurn = {
    sixtyDegrees: 3,
    fortyFiveDegrees: 4,
    thirtyDegrees: 6,
  };
  const sixtyDegrees = Math.PI / perHalfTurn.sixtyDegrees;
  const fortyFiveDegrees = Math.PI / perHalfTurn.fortyFiveDegrees;
  const thirtyDegrees = Math.PI / perHalfTurn.thirtyDegrees;
  const ref = (key: string): unknown => ({ kind: "reference", key });
  const call = (fn: string, ...args: readonly unknown[]): unknown => ({
    kind: "call",
    fn,
    args,
  });
  const arithmetic = (op: string, left: unknown, right: unknown): unknown => ({
    kind: "arithmetic",
    op,
    left,
    right,
  });
  const metres = ({ value }: { value: number }): unknown => ({
    kind: "number",
    value,
    unit: { m: 1 },
  });

  /** The definite value a tree evaluated to; anything else fails the test by name. */
  function definiteValue(tree: unknown, inputs: Record<string, unknown>) {
    const result = evaluateDocument({ tree, inputs });
    if (result.outcome !== "evaluated") {
      throw new Error(`not evaluated: ${result.outcome}`);
    }
    if (result.evaluation.status !== "definite") {
      throw new Error(`not definite: ${result.evaluation.reason.message}`);
    }
    const { value } = result.evaluation;
    if (typeof value === "boolean") throw new Error("not a computed value");

    return value;
  }

  function definiteNumber(tree: unknown, inputs: Record<string, unknown>) {
    const value = definiteValue(tree, inputs);
    if (value.kind !== "number")
      throw new Error(`a ${value.kind}, not a number`);

    return value.value;
  }

  it("takes the principal square root of a complex impedance ratio, halving its unit", () => {
    // The characteristic impedance sqrt(Z / Y) of a line with series impedance 3 + 4i ohm and shunt admittance 1 per ohm.
    expect(
      definiteValue(
        call("squareRoot", arithmetic("divide", ref("Z"), ref("Y"))),
        {
          Z: { kind: "complex", re: 3, im: 4, unit: { ohm: 1 } },
          Y: { kind: "number", value: 1, unit: { ohm: -1 } },
        },
      ),
    ).toEqual({ kind: "complex", re: 2, im: 1, unit: { ohm: 1 } });
  });

  it("rotates a phasor by exponential(i theta)", () => {
    const magnitude = 10;
    const rotated = definiteValue(
      arithmetic(
        "multiply",
        ref("V"),
        call(
          "exponential",
          arithmetic(
            "multiply",
            { kind: "complexLiteral", re: 0, im: 1 },
            ref("theta"),
          ),
        ),
      ),
      { V: magnitude, theta: Math.PI / 2 },
    );
    if (rotated.kind !== "complex") throw new Error("not complex");

    // A quarter turn of a real phasor is on the positive imaginary axis, within one rounding of the magnitude.
    expect(Math.abs(rotated.re)).toBeLessThanOrEqual(
      magnitude * Number.EPSILON,
    );
    expect(Math.abs(rotated.im - magnitude)).toBeLessThanOrEqual(
      magnitude * Number.EPSILON,
    );
  });

  it("takes the principal logarithm of a negated complex value", () => {
    expect(
      definiteValue(call("logarithm", { kind: "negate", operand: ref("z") }), {
        z: { kind: "complex", re: 1, im: 0 },
      }),
    ).toEqual({ kind: "complex", re: 0, im: Math.PI });
  });

  it("refuses the logarithm of a real zero as before, as a domain-error", () => {
    expect(
      evaluateDocument({ tree: call("logarithm", ref("x")), inputs: { x: 0 } }),
    ).toMatchObject({
      evaluation: { status: "indeterminate", reason: { code: "domain-error" } },
    });
  });

  it.each([
    {
      name: "sine",
      // The height a 2 m ladder reaches at 30 degrees from the ground.
      tree: arithmetic("multiply", ref("length"), call("sine", ref("angle"))),
      inputs: { length: 2, angle: thirtyDegrees },
      expected: 1,
    },
    {
      name: "tangent",
      // The rise over a 10 m run at 45 degrees.
      tree: arithmetic("multiply", ref("run"), call("tangent", ref("angle"))),
      inputs: { run: 10, angle: fortyFiveDegrees },
      expected: 10,
    },
    {
      name: "arcSine",
      tree: call(
        "arcSine",
        arithmetic("divide", ref("opposite"), ref("hypotenuse")),
      ),
      inputs: {
        opposite: metres({ value: 1 }),
        hypotenuse: metres({ value: 2 }),
      },
      expected: thirtyDegrees,
    },
    {
      name: "arcCosine",
      tree: call(
        "arcCosine",
        arithmetic("divide", ref("adjacent"), ref("hypotenuse")),
      ),
      inputs: {
        adjacent: metres({ value: 1 }),
        hypotenuse: metres({ value: 2 }),
      },
      expected: sixtyDegrees,
    },
    {
      name: "arcTangent",
      tree: call("arcTangent", arithmetic("divide", ref("rise"), ref("run"))),
      inputs: { rise: metres({ value: 3 }), run: metres({ value: 3 }) },
      expected: fortyFiveDegrees,
    },
    {
      name: "cosine and arcTangent2",
      // The power factor of 3 W of real and 4 var of reactive power, cos(atan2(Q, P)) = P / |S|.
      tree: call("cosine", call("arcTangent2", ref("Q"), ref("P"))),
      inputs: { P: 3, Q: 4 },
      expected: 0.6,
    },
  ])("evaluates a worked tree through $name", ({ tree, inputs, expected }) => {
    // A couple of roundings of a value of the expected size: the function's own and the arithmetic around it.
    expect(
      Math.abs(definiteNumber(tree, inputs) - expected),
    ).toBeLessThanOrEqual(2 * Number.EPSILON * Math.abs(expected));
  });
});
