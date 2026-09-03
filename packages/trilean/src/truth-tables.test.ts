import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "./evaluator";
import type { Evaluation } from "./evaluation";
import type { PredicateNode } from "./tree";
import type { Resolvers } from "./resolvers";

/**
 * A resolver reporting "present" as found and "missing" as not-found -- this, and only this, is what turns a "compare" leaf indeterminate below. Every U case in this file is a genuine evaluator run through `evaluatePredicate`, never a hand-built `Evaluation` object.
 */
const resolvers: Resolvers = {
  resolveValue: async (key) =>
    Promise.resolve(
      key === "missing"
        ? { found: false }
        : { found: true, value: { kind: "number", value: 1 } },
    ),
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

type TruthValue = "T" | "F" | "U";

/** `allOf([])`/`anyOf([])` give definite true/false for free (the identity elements verified separately below); the one leaf that needs a real resolver round-trip is U, built from a `compare` against an unresolvable reference. */
const leaves: Record<TruthValue, PredicateNode> = {
  T: { kind: "allOf", operands: [] },
  F: { kind: "anyOf", operands: [] },
  U: {
    kind: "compare",
    op: "eq",
    left: { kind: "reference", key: "missing" },
    right: { kind: "reference", key: "present" },
  },
};

function expectTruthValue(
  evaluation: Evaluation<boolean>,
  expected: TruthValue,
): void {
  if (expected === "U") {
    expect(evaluation.status).toBe("indeterminate");
    return;
  }
  expect(evaluation).toEqual({ status: "definite", value: expected === "T" });
}

describe("AND truth table", () => {
  it.each<[TruthValue, TruthValue, TruthValue]>([
    ["T", "T", "T"],
    ["T", "F", "F"],
    ["T", "U", "U"],
    ["F", "T", "F"],
    ["F", "F", "F"],
    ["F", "U", "F"],
    ["U", "T", "U"],
    ["U", "F", "F"],
    ["U", "U", "U"],
  ])("%s AND %s => %s", async (left, right, expected) => {
    const result = await evaluatePredicate(
      { kind: "and", left: leaves[left], right: leaves[right] },
      undefined,
      resolvers,
    );
    expectTruthValue(result, expected);
  });
});

describe("OR truth table", () => {
  it.each<[TruthValue, TruthValue, TruthValue]>([
    ["T", "T", "T"],
    ["T", "F", "T"],
    ["T", "U", "T"],
    ["F", "T", "T"],
    ["F", "F", "F"],
    ["F", "U", "U"],
    ["U", "T", "T"],
    ["U", "F", "U"],
    ["U", "U", "U"],
  ])("%s OR %s => %s", async (left, right, expected) => {
    const result = await evaluatePredicate(
      { kind: "or", left: leaves[left], right: leaves[right] },
      undefined,
      resolvers,
    );
    expectTruthValue(result, expected);
  });
});

describe("NOT truth table", () => {
  it.each<[TruthValue, TruthValue]>([
    ["T", "F"],
    ["F", "T"],
    ["U", "U"],
  ])("NOT %s => %s", async (operand, expected) => {
    const result = await evaluatePredicate(
      { kind: "not", operand: leaves[operand] },
      undefined,
      resolvers,
    );
    expectTruthValue(result, expected);
  });
});

describe("allOf/anyOf empty-list identities", () => {
  it("allOf([]) is definitely true", async () => {
    const result = await evaluatePredicate(
      { kind: "allOf", operands: [] },
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("anyOf([]) is definitely false", async () => {
    const result = await evaluatePredicate(
      { kind: "anyOf", operands: [] },
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });
});
