import { describe, expect, it } from "vitest";
import { complexMagnitude, createEvaluator } from "../../src/index";
import type {
  ComputedValue,
  ExpressionNode,
  FunctionRegistry,
  PredicateNode,
  Resolvers,
} from "../../src/index";

/**
 * Complex values as part of a whole tree rather than in isolation: resolver-supplied complex operands combined with a real one in the same expression, the result carried into a `compare` leaf, and the one bridge back to the real ordering domain -- a registry function built on the exported `complexMagnitude` helper, which is how a tree asks "is this larger than that" about a quantity the complex plane itself cannot order (see the "Complex values" section of README.md).
 */

const resolvers: Resolvers = {
  resolveValue: async (key) => {
    if (key === "firstSample") {
      return Promise.resolve({
        found: true,
        value: { kind: "complex", re: 3, im: 4 },
      });
    }
    if (key === "secondSample") {
      return Promise.resolve({
        found: true,
        value: { kind: "complex", re: 1, im: -2 },
      });
    }
    if (key === "offset") {
      return Promise.resolve({
        found: true,
        value: { kind: "number", value: 2 },
      });
    }
    return Promise.resolve({ found: false });
  },
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

const functions: FunctionRegistry = {
  // The package ships no built-in function set (see the `call` section of README.md), so a tree that needs a complex value's magnitude as a real number registers one itself -- one line, over the exported helper, with no separate accessor node kind needed in the grammar.
  magnitude: (args: readonly ComputedValue[]) => {
    const arg = args[0];
    if (arg?.kind !== "complex") {
      return { domainError: "expected a complex argument" };
    }
    return complexMagnitude(arg);
  },
};

const { evaluatePredicate, evaluateValue } = createEvaluator({ functions });

/** `(firstSample * secondSample) + offset` -- two complex operands multiplied, then a real one added to the complex product. */
const combinedSample: ExpressionNode = {
  kind: "arithmetic",
  op: "add",
  left: {
    kind: "arithmetic",
    op: "multiply",
    left: { kind: "reference", key: "firstSample" },
    right: { kind: "reference", key: "secondSample" },
  },
  right: { kind: "reference", key: "offset" },
};

const exceedsMagnitude = (limit: number): PredicateNode => ({
  kind: "compare",
  op: "gt",
  left: { kind: "call", fn: "magnitude", args: [combinedSample] },
  right: { kind: "numberLiteral", value: limit },
});

const belowLimit = 13;
const aboveLimit = 14;

describe("complex values compose through a whole tree", () => {
  it("carries complex operands and a real one through one expression", async () => {
    // (3 + 4i)(1 - 2i) = 11 - 2i, and the real 2 is promoted rather than rejected: 13 - 2i.
    const result = await evaluateValue(combinedSample, undefined, resolvers);
    expect(result).toEqual({
      status: "definite",
      value: { kind: "complex", re: 13, im: -2, unit: {} },
    });
  });

  it("reaches an ordering comparison through a registered magnitude function", async () => {
    // |13 - 2i| is a little over 13.15.
    await expect(
      evaluatePredicate(exceedsMagnitude(belowLimit), undefined, resolvers),
    ).resolves.toEqual({ status: "definite", value: true });
    await expect(
      evaluatePredicate(exceedsMagnitude(aboveLimit), undefined, resolvers),
    ).resolves.toEqual({ status: "definite", value: false });
  });

  it("is wrong-type when the same comparison is attempted on the complex value directly", async () => {
    const result = await evaluatePredicate(
      {
        kind: "compare",
        op: "gt",
        left: combinedSample,
        right: { kind: "complexLiteral", re: 13, im: 0 },
      },
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
    }
  });
});
