import { describe, expect, it } from "vitest";
import { createEvaluator } from "../../src/index";
import type {
  ComputedValue,
  FunctionRegistry,
  PredicateNode,
  Resolvers,
} from "../../src/index";

/**
 * Proves a `FunctionRegistry` composes correctly across multiple `call` sites within one evaluation -- two README.md "starting example" functions (`squareRoot`, `absoluteValue`) alongside a genuinely custom, domain-specific one (`toleranceBand`), all contributing to a single tree -- and that a call to an unregistered name nested deep inside an otherwise-valid tree surfaces as indeterminate, not just when it sits at the top level.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolvers: Resolvers = {
  resolveValue: async (key, context) => {
    if (
      !isPlainRecord(context) ||
      typeof key !== "string" ||
      !(key in context)
    ) {
      return Promise.resolve({ found: false });
    }
    const value = context[key];
    return typeof value === "number"
      ? Promise.resolve({ found: true, value: { kind: "number", value } })
      : Promise.resolve({ found: false });
  },
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

function requireNumberArg(
  args: readonly ComputedValue[],
  index: number,
): Extract<ComputedValue, { kind: "number" }> | { domainError: string } {
  const arg = args[index];
  if (arg?.kind !== "number") {
    return {
      domainError: `expected argument ${String(index)} to be a number`,
    };
  }
  return arg;
}

// An arbitrary but fixed tolerance ratio for this test fixture's custom domain function -- 5% of the nominal value.
const TOLERANCE_RATIO = 0.05;

const functions: FunctionRegistry = {
  squareRoot: (args) => {
    const arg = requireNumberArg(args, 0);
    if ("domainError" in arg) return arg;
    if (arg.value < 0) {
      return {
        domainError: "squareRoot of a negative number is not a real number",
      };
    }
    return { kind: "number", value: Math.sqrt(arg.value) };
  },
  absoluteValue: (args) => {
    const arg = requireNumberArg(args, 0);
    if ("domainError" in arg) return arg;
    return { kind: "number", value: Math.abs(arg.value) };
  },
  // A custom, domain-specific function -- not one of README.md's own starting examples -- proving the registry is genuinely open-ended, not limited to a fixed built-in set.
  toleranceBand: (args) => {
    const arg = requireNumberArg(args, 0);
    if ("domainError" in arg) return arg;
    return { kind: "number", value: Math.abs(arg.value) * TOLERANCE_RATIO };
  },
};

const { evaluatePredicate } = createEvaluator({ functions });

const measuredWithinTolerance: PredicateNode = {
  kind: "compare",
  op: "lte",
  left: {
    kind: "call",
    fn: "absoluteValue",
    args: [
      {
        kind: "arithmetic",
        op: "subtract",
        left: { kind: "reference", key: "measured" },
        right: { kind: "reference", key: "nominal" },
      },
    ],
  },
  right: {
    kind: "call",
    fn: "toleranceBand",
    args: [{ kind: "reference", key: "nominal" }],
  },
};

const varianceWithinBound: PredicateNode = {
  kind: "compare",
  op: "lt",
  left: {
    kind: "call",
    fn: "squareRoot",
    args: [{ kind: "reference", key: "varianceEstimate" }],
  },
  right: { kind: "numberLiteral", value: 2 },
};

describe("a function registry composes across multiple call sites in one evaluation", () => {
  it("three registered functions -- two built-in-style, one custom -- all contribute to a single definite result", async () => {
    const rule: PredicateNode = {
      kind: "allOf",
      operands: [measuredWithinTolerance, varianceWithinBound],
    };
    const context = { measured: 102, nominal: 100, varianceEstimate: 3 };
    const result = await evaluatePredicate(rule, context, resolvers);
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("a measurement outside its tolerance band is definitely false, even though the variance check alone would pass", async () => {
    const rule: PredicateNode = {
      kind: "allOf",
      operands: [measuredWithinTolerance, varianceWithinBound],
    };
    const context = { measured: 120, nominal: 100, varianceEstimate: 3 };
    const result = await evaluatePredicate(rule, context, resolvers);
    expect(result).toEqual({ status: "definite", value: false });
  });

  it("a call to an unregistered function nested deep inside an otherwise-valid tree surfaces as indeterminate wrong-type, not silently ignored or crashing the whole evaluation", async () => {
    const rule: PredicateNode = {
      kind: "allOf",
      operands: [
        measuredWithinTolerance,
        varianceWithinBound,
        {
          kind: "compare",
          op: "eq",
          left: {
            kind: "call",
            fn: "notRegisteredAnywhere",
            args: [{ kind: "reference", key: "nominal" }],
          },
          right: { kind: "numberLiteral", value: 1 },
        },
      ],
    };
    const context = { measured: 102, nominal: 100, varianceEstimate: 3 };
    const result = await evaluatePredicate(rule, context, resolvers);
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
    }
  });
});
