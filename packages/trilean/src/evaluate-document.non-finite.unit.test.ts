import { describe, expect, it, vi } from "vitest";

// The built-in functions and the evaluator's own arithmetic never produce a non-finite number, so reaching the output check needs a registry that does. Replacing the module is the only way to put one behind `evaluateDocument`, whose registry is fixed.
vi.mock("./builtin-functions", () => ({
  builtinFunctions: {
    leakInfinity: () => ({ kind: "number", value: Number.POSITIVE_INFINITY }),
    leakNaN: () => ({ kind: "number", value: Number.NaN }),
    leakComplex: () => ({
      kind: "complex",
      re: 0,
      im: Number.POSITIVE_INFINITY,
    }),
    fine: () => ({ kind: "number", value: 1 }),
  },
}));

const { evaluateDocument } = await import("./evaluate-document");

function call(fn: string): unknown {
  return { kind: "call", fn, args: [] };
}

describe("evaluateDocument's output check", () => {
  it.each(["leakInfinity", "leakNaN", "leakComplex"])(
    "rejects a definite result from %s that JSON would print as null",
    (fn) => {
      expect(evaluateDocument({ tree: call(fn) })).toEqual({
        outcome: "rejected",
        issues: ["(result): the value is not a finite number"],
      });
    },
  );

  it("passes a representable result through", () => {
    expect(evaluateDocument({ tree: call("fine") })).toMatchObject({
      outcome: "evaluated",
      evaluation: { status: "definite", value: { kind: "number", value: 1 } },
    });
  });
});
