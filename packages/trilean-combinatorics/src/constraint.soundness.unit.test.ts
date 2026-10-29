import type { Dimension, PartialAssignment, Value } from "combinatrix";
import { choice } from "combinatrix";
import type {
  ExpressionNode,
  JsonValue,
  PredicateNode,
  Resolution,
} from "trilean";
import { coalesce, evaluatePredicate } from "trilean";
import { describe, expect, it } from "vitest";
import { trileanConstraint } from "./index";

/** The ratio values the model takes, and one strictly between them. */
const LOW = 0.3;
const HIGH = 0.5;
const BETWEEN = 0.4;

const DOMAINS = {
  mode: [undefined, "fast", "safe"],
  ratio: [undefined, LOW, HIGH],
  cache: [undefined, true, false],
} as const satisfies Record<string, readonly Value[]>;
type Name = keyof typeof DOMAINS;
const NAMES = ["mode", "ratio", "cache"] as const satisfies readonly Name[];

const dimensions: readonly Dimension[] = NAMES.map((name) => {
  const values: readonly Value[] = DOMAINS[name];

  return choice(name, values);
});

const ref = (key: Name): ExpressionNode => ({ kind: "reference", key });
const exists = (key: Name): PredicateNode => ({
  kind: "exists",
  operand: ref(key),
});
const and = (left: PredicateNode, right: PredicateNode): PredicateNode => ({
  kind: "and",
  left,
  right,
});
const or = (left: PredicateNode, right: PredicateNode): PredicateNode => ({
  kind: "or",
  left,
  right,
});
const not = (operand: PredicateNode): PredicateNode => ({
  kind: "not",
  operand,
});
const isMode = (value: string): PredicateNode =>
  and(exists("mode"), {
    kind: "textCompare",
    op: "equals",
    left: ref("mode"),
    right: { kind: "textLiteral", value },
  });
const ratioAtLeast = (value: number): PredicateNode =>
  and(exists("ratio"), {
    kind: "compare",
    op: "gte",
    left: ref("ratio"),
    right: { kind: "numberLiteral", value },
  });
const cacheOn: PredicateNode = and(exists("cache"), {
  kind: "memberOf",
  op: "in",
  operand: ref("cache"),
  candidates: [{ kind: "booleanLiteral", value: true }],
});

/** Trees that are definite on every complete assignment of the model, covering every connective, exists on its own and under negation, coalesce and a conditional. */
const TREES: readonly (readonly [string, PredicateNode])[] = [
  ["exists", exists("mode")],
  ["not exists", not(exists("ratio"))],
  ["guarded text", isMode("fast")],
  ["guarded number", ratioAtLeast(HIGH)],
  ["guarded boolean", cacheOn],
  ["or of guards", or(isMode("safe"), ratioAtLeast(BETWEEN))],
  ["and of negations", and(not(isMode("fast")), not(cacheOn))],
  ["implication", or(not(isMode("fast")), and(exists("ratio"), not(cacheOn)))],
  [
    "anyOf",
    {
      kind: "anyOf",
      operands: [cacheOn, not(exists("mode")), ratioAtLeast(LOW)],
    },
  ],
  [
    "allOf",
    {
      kind: "allOf",
      operands: [exists("cache"), or(isMode("safe"), not(exists("ratio")))],
    },
  ],
  [
    "coalesce",
    {
      kind: "compare",
      op: "gte",
      left: coalesce(ref("ratio"), { kind: "numberLiteral", value: BETWEEN }),
      right: { kind: "numberLiteral", value: BETWEEN },
    },
  ],
  [
    "conditional",
    {
      kind: "compare",
      op: "eq",
      left: {
        kind: "conditional",
        cases: [
          { when: isMode("fast"), then: { kind: "numberLiteral", value: 1 } },
        ],
        fallback: { kind: "numberLiteral", value: 0 },
      },
      right: { kind: "numberLiteral", value: 1 },
    },
  ],
];

/** A complete assignment's value for a key, written out independently of the adapter's own mapping: text, number or boolean when set, known absent when unset. */
async function resolutionOf(
  assignment: PartialAssignment,
  key: JsonValue,
): Promise<Resolution> {
  const value = typeof key === "string" ? assignment.get(key) : undefined;
  if (typeof value === "string") {
    return Promise.resolve({ found: true, value: { kind: "text", value } });
  }
  if (typeof value === "number") {
    return Promise.resolve({ found: true, value: { kind: "number", value } });
  }
  if (typeof value === "boolean") {
    return Promise.resolve({ found: true, value: { kind: "boolean", value } });
  }

  return Promise.resolve({ found: false });
}

/** Every partial assignment of the model: each dimension unassigned or assigned one of its values. */
function partialAssignments(): Map<string, Value>[] {
  let assignments: Map<string, Value>[] = [new Map<string, Value>()];
  for (const name of NAMES) {
    assignments = assignments.flatMap((assignment) => [
      assignment,
      ...DOMAINS[name].map(
        (value): Map<string, Value> => new Map([...assignment, [name, value]]),
      ),
    ]);
  }

  return assignments;
}

/** Every complete assignment agreeing with the partial one. */
function completions(partial: PartialAssignment): Map<string, Value>[] {
  return partialAssignments().filter(
    (assignment) =>
      assignment.size === NAMES.length &&
      [...partial].every(([name, value]) => assignment.get(name) === value),
  );
}

describe("trileanConstraint: Kleene soundness", () => {
  it.each(TREES)(
    "%s: a definite verdict on a partial assignment is the verdict on every completion",
    (_, tree) => {
      const constraint = trileanConstraint(tree, { dimensions });
      for (const partial of partialAssignments()) {
        const verdict = constraint.evaluate(partial);
        const complete = completions(partial).map((assignment) =>
          constraint.evaluate(assignment),
        );
        expect(complete).not.toContain("unknown");
        if (verdict !== "unknown") {
          expect(new Set(complete), JSON.stringify([...partial])).toEqual(
            new Set([verdict]),
          );
        }
      }
    },
  );

  it("the soundness check discriminates: a constraint that reads unassigned as unset breaks it", () => {
    const constraint = trileanConstraint(exists("mode"), { dimensions });
    const unsound = (assignment: PartialAssignment) =>
      constraint.evaluate(
        new Map([
          ...NAMES.map((name) => [name, undefined] as const),
          ...assignment,
        ]),
      );
    const partial = new Map<string, Value>();
    expect(unsound(partial)).toBe("invalid");
    expect(completions(partial).map(unsound)).toContain("valid");
  });

  it.each(TREES)(
    "%s: agrees with trilean's own evaluator on every complete assignment",
    async (_, tree) => {
      const constraint = trileanConstraint(tree, { dimensions });
      const complete = partialAssignments().filter(
        (each) => each.size === NAMES.length,
      );
      const evaluations = await Promise.all(
        complete.map(async (assignment) =>
          evaluatePredicate(tree, undefined, {
            resolveValue: async (key) => resolutionOf(assignment, key),
            resolveLookup: async () => Promise.resolve({ found: false }),
            resolveCollection: async () => Promise.resolve([]),
          }),
        ),
      );
      complete.forEach((assignment, index) => {
        const evaluation = evaluations[index];
        expect(evaluation?.status).toBe("definite");
        const expected =
          evaluation?.status === "definite" && evaluation.value
            ? "valid"
            : "invalid";
        expect(constraint.evaluate(assignment)).toBe(expected);
      });
    },
  );
});
