import { describe, expect, it } from "vitest";
import { coalesce } from "./derived-values";
import { evaluateValue } from "./evaluator";
import type { Evaluation } from "./evaluation";
import type { ComputedValue } from "./computed-value";
import type { ExpressionNode } from "./tree";
import type { Resolvers } from "./resolvers";

/**
 * `coalesce` never appears as its own `kind` discriminant (see derived-values.ts) -- every behavioural test below runs the builder's output through the genuine public `evaluateValue` entry point, exactly as if the builder were an opaque black box, with one deliberate exception (the structural-equality assertion at the bottom) that pins the composition itself.
 */

function expectDefinite(
  evaluation: Evaluation<ComputedValue>,
  expected: ComputedValue,
): void {
  expect(evaluation).toEqual({ status: "definite", value: expected });
}

const present: ExpressionNode = { kind: "reference", key: "present" };
const absent: ExpressionNode = { kind: "reference", key: "missing" };
/** Resolves, but to a `text` value where a `number` is required by the surrounding `arithmetic` node below -- a resolved-but-unusable candidate (`wrong-type`), distinct from a genuinely absent one (`not-found`). */
const wrongType: ExpressionNode = {
  kind: "arithmetic",
  op: "add",
  left: { kind: "textLiteral", value: "x" },
  right: { kind: "numberLiteral", value: 1 },
};
/** Resolves, but to a division by zero (`domain-error`) -- likewise resolved-but-unusable, not absent. */
const domainError: ExpressionNode = {
  kind: "arithmetic",
  op: "divide",
  left: { kind: "numberLiteral", value: 1 },
  right: { kind: "numberLiteral", value: 0 },
};

const resolvers: Resolvers = {
  resolveValue: async (key) =>
    Promise.resolve(
      key === "present"
        ? { found: true, value: { kind: "number", value: 10 } }
        : { found: false },
    ),
  resolveLookup: async () => Promise.resolve({ found: false }),
  resolveCollection: async () => Promise.resolve([]),
};

describe("derived = composition, not separate logic", () => {
  it("coalesce(a, b) expands to a conditional whose single case probes a with exists, falling back to b", () => {
    expect(coalesce(present, absent)).toEqual({
      kind: "conditional",
      cases: [{ when: { kind: "exists", operand: present }, then: present }],
      fallback: absent,
    });
  });

  it("coalesce(a, b, c) nests right-to-left: a's conditional falls back to b's conditional, which falls back to c", () => {
    const secondLast: ExpressionNode = { kind: "reference", key: "b" };
    const last: ExpressionNode = { kind: "reference", key: "c" };
    expect(coalesce(present, secondLast, last)).toEqual({
      kind: "conditional",
      cases: [{ when: { kind: "exists", operand: present }, then: present }],
      fallback: {
        kind: "conditional",
        cases: [
          { when: { kind: "exists", operand: secondLast }, then: secondLast },
        ],
        fallback: last,
      },
    });
  });
});

describe("coalesce", () => {
  it("returns the first candidate that exists", async () => {
    const result = await evaluateValue(
      coalesce(present, absent),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 10 });
  });

  it("never evaluates a later candidate once an earlier one exists", async () => {
    let laterCandidateEvaluations = 0;
    const trackingResolvers: Resolvers = {
      ...resolvers,
      resolveValue: async (key, context) => {
        if (key === "later-candidate-marker") laterCandidateEvaluations += 1;
        return resolvers.resolveValue(key, context);
      },
    };
    const result = await evaluateValue(
      coalesce(present, { kind: "reference", key: "later-candidate-marker" }),
      undefined,
      trackingResolvers,
    );
    expectDefinite(result, { kind: "number", value: 10 });
    expect(laterCandidateEvaluations).toBe(0);
  });

  it("a not-found candidate falls through to the next", async () => {
    const result = await evaluateValue(
      coalesce(absent, present),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 10 });
  });

  it("a wrong-type candidate propagates as wrong-type rather than falling through", async () => {
    const result = await evaluateValue(
      coalesce(wrongType, present),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("wrong-type");
    }
  });

  it("a domain-error candidate propagates as domain-error rather than falling through", async () => {
    const result = await evaluateValue(
      coalesce(domainError, present),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("domain-error");
    }
  });

  it("every candidate not-found surfaces the final (un-guarded) candidate's own not-found result", async () => {
    const result = await evaluateValue(
      coalesce(absent, absent),
      undefined,
      resolvers,
    );
    expect(result.status).toBe("indeterminate");
    if (result.status === "indeterminate") {
      expect(result.reason.code).toBe("not-found");
    }
  });

  it("accepts more than two candidates", async () => {
    const result = await evaluateValue(
      coalesce(absent, absent, present),
      undefined,
      resolvers,
    );
    expectDefinite(result, { kind: "number", value: 10 });
  });
});
