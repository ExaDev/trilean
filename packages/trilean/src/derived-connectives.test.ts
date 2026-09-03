import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "./evaluator";
import {
  and,
  iff,
  implies,
  nand,
  none,
  nor,
  not,
  or,
  xor,
} from "./derived-connectives";
import type { Evaluation } from "./evaluation";
import type { PredicateNode } from "./tree";
import type { Resolvers } from "./resolvers";

/**
 * `xor`/`nand`/`nor`/`implies`/`iff`/`none` never appear as their own `kind` discriminant (see derived-connectives.ts) -- every test below runs the builder's output through the genuine public `evaluatePredicate` entry point, exactly as if the builder were an opaque black box, with one deliberate exception (the structural-equality assertion at the bottom) that pins the composition itself.
 */

type TruthValue = "T" | "F" | "U";

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

/** `allOf([])`/`anyOf([])` give definite true/false for free; U is a genuine unresolvable `compare`, never a hand-built `Evaluation` object. */
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

describe("XOR worked correctness check (README.md 'Worked correctness check: exclusive-or')", () => {
  it.each<[TruthValue, TruthValue, TruthValue]>([
    ["T", "T", "F"],
    ["T", "F", "T"],
    ["T", "U", "U"],
    ["F", "T", "T"],
    ["F", "F", "F"],
    ["F", "U", "U"],
    ["U", "T", "U"],
    ["U", "F", "U"],
    ["U", "U", "U"],
  ])("%s XOR %s => %s", async (left, right, expected) => {
    const result = await evaluatePredicate(
      xor(leaves[left], leaves[right]),
      undefined,
      resolvers,
    );
    expectTruthValue(result, expected);
  });

  it("has no absorbing value: every combination with at least one U produces U, unlike AND/OR", async () => {
    const withU = await Promise.all([
      evaluatePredicate(xor(leaves.T, leaves.U), undefined, resolvers),
      evaluatePredicate(xor(leaves.U, leaves.T), undefined, resolvers),
      evaluatePredicate(xor(leaves.F, leaves.U), undefined, resolvers),
      evaluatePredicate(xor(leaves.U, leaves.F), undefined, resolvers),
    ]);
    for (const result of withU) {
      expect(result.status).toBe("indeterminate");
    }
  });
});

describe("implies spot check", () => {
  it("implies(F, U) => T -- a false antecedent is vacuously true regardless of the consequent", async () => {
    const result = await evaluatePredicate(
      implies(leaves.F, leaves.U),
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });
});

describe("nand", () => {
  it("nand(T, F) => T", async () => {
    const result = await evaluatePredicate(
      nand(leaves.T, leaves.F),
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("nand(T, T) => F", async () => {
    const result = await evaluatePredicate(
      nand(leaves.T, leaves.T),
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });
});

describe("nor", () => {
  it("nor(F, F) => T", async () => {
    const result = await evaluatePredicate(
      nor(leaves.F, leaves.F),
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("nor(T, F) => F", async () => {
    const result = await evaluatePredicate(
      nor(leaves.T, leaves.F),
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });
});

describe("iff", () => {
  it("iff(T, T) => T", async () => {
    const result = await evaluatePredicate(
      iff(leaves.T, leaves.T),
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("iff(T, F) => F", async () => {
    const result = await evaluatePredicate(
      iff(leaves.T, leaves.F),
      undefined,
      resolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });
});

describe("none", () => {
  /** `@typescript-eslint/no-magic-numbers` only exempts -1/0/1/2 and object-literal property values, not values passed as plain call arguments -- see the equivalent comment in evaluator.indeterminacy.test.ts. */
  const thirdCollectionItem = 3;
  const collectionResolvers: Resolvers = {
    resolveValue: async (key, context) => {
      if (key === "self" && typeof context === "number") {
        return Promise.resolve({
          found: true,
          value: { kind: "number", value: context },
        });
      }
      return Promise.resolve({ found: false });
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async (collection) =>
      collection === "numbers"
        ? Promise.resolve([1, 2, thirdCollectionItem])
        : Promise.resolve([]),
  };

  const isAboveTen: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "self" },
    right: { kind: "numberLiteral", value: 10 },
  };

  const isAboveOne: PredicateNode = {
    kind: "compare",
    op: "gt",
    left: { kind: "reference", key: "self" },
    right: { kind: "numberLiteral", value: 1 },
  };

  it("none(numbers, item > 10) over [1, 2, 3] => definite true (no item satisfies)", async () => {
    const result = await evaluatePredicate(
      none("numbers", isAboveTen),
      undefined,
      collectionResolvers,
    );
    expect(result).toEqual({ status: "definite", value: true });
  });

  it("none(numbers, item > 1) over [1, 2, 3] => definite false (some item satisfies)", async () => {
    const result = await evaluatePredicate(
      none("numbers", isAboveOne),
      undefined,
      collectionResolvers,
    );
    expect(result).toEqual({ status: "definite", value: false });
  });
});

describe("derived = composition, not separate logic", () => {
  it("xor(a, b) is structurally exactly or(and(a, not(b)), and(not(a), b))", () => {
    const a: PredicateNode = { kind: "allOf", operands: [] };
    const b: PredicateNode = { kind: "anyOf", operands: [] };
    expect(xor(a, b)).toEqual(or(and(a, not(b)), and(not(a), b)));
  });
});
