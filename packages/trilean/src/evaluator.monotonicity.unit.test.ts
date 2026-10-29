import { describe, expect, it } from "vitest";
import type { Evaluation, IndeterminateReason } from "./evaluation";
import { coalesce } from "./derived-values";
import { createSyncEvaluator } from "./evaluator-factory";
import type { Resolution, SyncResolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * The property a consumer evaluating a partial assignment relies on: whatever a definite answer on a partial assignment says, no completion of it can contradict. Every tree below is enumerated exhaustively over a small grammar, and each is evaluated under every partial assignment of three references and under every completion of that assignment. A reference is `unassigned` (the resolver reports it as not yet known) or assigned one of `number`, `text` (usable where a number is not) or `absent` (known to be absent).
 *
 * Two facts are checked per tree and partial assignment. First, Kleene monotonicity: a definite result equals the result under every completion. Second, the classification `exists` reads off a result (`absent` for `not-found`, `present` for a definite result, `wrong-type` or `domain-error`, and `open` for `not-yet-known`) is stable: a tree that `exists` would answer `true` or `false` on the partial assignment gets the same answer under every completion. The second is what makes `exists`, and so `coalesce`, sound over a partial assignment, and it is the property that fails if a node reports `not-found` while an unknown value could still absorb it.
 */

type State = "unassigned" | "number" | "text" | "absent";
type Assignment = Readonly<Record<"a" | "b" | "c", State>>;
type Completion = Exclude<State, "unassigned">;

const REFERENCES = ["a", "b", "c"] as const;
const STATES: readonly State[] = ["unassigned", "number", "text", "absent"];
const COMPLETIONS: readonly Completion[] = ["number", "text", "absent"];

const RESOLUTIONS: Readonly<Record<State, Resolution>> = {
  unassigned: { found: false, notYetKnown: true },
  number: { found: true, value: { kind: "number", value: 1 } },
  text: { found: true, value: { kind: "text", value: "t" } },
  absent: { found: false },
};

function resolversFor(assignment: Assignment): SyncResolvers {
  return {
    resolveValue: (key) => {
      if (key === "a" || key === "b" || key === "c") {
        return RESOLUTIONS[assignment[key]];
      }

      return { found: false };
    },
    resolveLookup: () => ({ found: false }),
    resolveCollection: () => [],
  };
}

function allAssignments(): Assignment[] {
  const assignments: Assignment[] = [];
  for (const a of STATES) {
    for (const b of STATES) {
      for (const c of STATES) assignments.push({ a, b, c });
    }
  }

  return assignments;
}

function completionsOf(assignment: Assignment): Assignment[] {
  const choices = REFERENCES.map((key) =>
    assignment[key] === "unassigned" ? COMPLETIONS : [assignment[key]],
  );
  const [as, bs, cs] = choices;
  if (as === undefined || bs === undefined || cs === undefined) {
    throw new Error("unreachable: three references yield three choice lists");
  }

  return as.flatMap((a) => bs.flatMap((b) => cs.map((c) => ({ a, b, c }))));
}

type Classification = "present" | "absent" | "open";

/** What `exists` reads off a result. Every reason code is listed, so a code added later fails to compile here until the property is revisited. */
const CLASSIFICATION_OF_CODE: Readonly<
  Record<IndeterminateReason["code"], Classification>
> = {
  "not-found": "absent",
  "not-yet-known": "open",
  "wrong-type": "present",
  "domain-error": "present",
};

function classify(evaluation: Evaluation<unknown>): Classification {
  return evaluation.status === "definite"
    ? "present"
    : CLASSIFICATION_OF_CODE[evaluation.reason.code];
}

const ref = (key: string): ExpressionNode => ({ kind: "reference", key });
const one: ExpressionNode = { kind: "numberLiteral", value: 1 };
const eq = (left: ExpressionNode, right: ExpressionNode): PredicateNode => ({
  kind: "compare",
  op: "eq",
  left,
  right,
});

const leafValues: ExpressionNode[] = [ref("a"), ref("b"), ref("c"), one];
const sumsOfLeaves: ExpressionNode[] = leafValues.flatMap((left) =>
  leafValues.map((right): ExpressionNode => ({
    kind: "arithmetic",
    op: "add",
    left,
    right,
  })),
);

const leafPredicates: PredicateNode[] = [
  ...leafValues.flatMap((left) => leafValues.map((right) => eq(left, right))),
  ...REFERENCES.map((key): PredicateNode => ({
    kind: "exists",
    operand: ref(key),
  })),
];

/** Connectives over the leaf predicates, plus `memberOf` and the N-ary connectives over a representative subset (every leaf kind appears in it), which keeps the enumeration's size bounded without leaving a connective out. */
const representative: PredicateNode[] = [
  eq(ref("a"), ref("b")),
  eq(ref("c"), one),
  eq(one, one),
  { kind: "exists", operand: ref("a") },
  {
    kind: "exists",
    operand: { kind: "arithmetic", op: "add", left: ref("b"), right: ref("c") },
  },
];
const connectivesOver = (operands: readonly PredicateNode[]): PredicateNode[] =>
  operands.flatMap((left) =>
    operands.flatMap((right): PredicateNode[] => [
      { kind: "and", left, right },
      { kind: "or", left, right },
    ]),
  );

/** Every predicate shape except the largest group (`and` and `or` over every pair of leaf predicates), which is enumerated only as a predicate target and not as a conditional guard: a guard's own structure is covered by the representative subset. */
const guards: PredicateNode[] = [
  ...leafPredicates,
  ...leafPredicates.map((operand): PredicateNode => ({ kind: "not", operand })),
  ...connectivesOver(representative),
  ...representative.flatMap((x) =>
    representative.flatMap((y) =>
      representative.flatMap((z): PredicateNode[] => [
        { kind: "allOf", operands: [x, y, z] },
        { kind: "anyOf", operands: [x, y, z] },
      ]),
    ),
  ),
  ...leafValues.flatMap((operand) =>
    leafValues.flatMap((x) =>
      leafValues.flatMap((y): PredicateNode[] => [
        { kind: "memberOf", op: "in", operand, candidates: [x, y] },
        { kind: "memberOf", op: "notIn", operand, candidates: [x, y] },
      ]),
    ),
  ),
  ...sumsOfLeaves.map((operand): PredicateNode => ({
    kind: "exists",
    operand,
  })),
];
const predicates: PredicateNode[] = [
  ...guards,
  ...connectivesOver(leafPredicates),
];

/** Conditionals guarded by every guard above, under both hit policies; the branches are one reference and one literal in either order, so a guard's outcome decides whether the result is present, absent or unusable. */
const branchPairs: readonly (readonly [ExpressionNode, ExpressionNode])[] = [
  [ref("c"), one],
  [one, ref("c")],
];
const conditionalsWith = (hitPolicy: "first" | "unique"): ExpressionNode[] =>
  guards.flatMap((when) =>
    branchPairs.map(([then, fallback]): ExpressionNode => ({
      kind: "conditional",
      hitPolicy,
      cases: [{ when, then }],
      fallback,
    })),
  );

const plainValues: ExpressionNode[] = [
  ...leafValues,
  ...sumsOfLeaves,
  ...leafValues.flatMap((x) =>
    leafValues.flatMap((y) => leafValues.map((z) => coalesce(x, y, z))),
  ),
];

const { evaluatePredicate, evaluateValue } = createSyncEvaluator({});

/** How many partial assignments reached each kind of answer while a reference was still unassigned; used to show the enumeration is not vacuous. */
interface Tally {
  readonly definiteWithUnassigned: number;
  readonly openWithUnassigned: number;
}

const keyOf = (assignment: Assignment): string =>
  REFERENCES.map((key) => assignment[key]).join("/");

/** Evaluates the tree once under every assignment, then checks each partial assignment against the results of its completions. Fails with the offending tree, assignment and completion rather than a bare mismatch. */
function checkTree(
  describeTree: string,
  evaluate: (resolvers: Readonly<SyncResolvers>) => Evaluation<unknown>,
): Tally {
  const results = new Map<string, Evaluation<unknown>>();
  for (const assignment of allAssignments()) {
    results.set(keyOf(assignment), evaluate(resolversFor(assignment)));
  }
  const resultOf = (assignment: Assignment): Evaluation<unknown> => {
    const result = results.get(keyOf(assignment));
    if (result === undefined) {
      throw new Error("unreachable: every assignment was evaluated");
    }

    return result;
  };
  let definiteWithUnassigned = 0;
  let openWithUnassigned = 0;
  for (const assignment of allAssignments()) {
    if (REFERENCES.every((key) => assignment[key] !== "unassigned")) continue;
    const partial = resultOf(assignment);
    if (partial.status === "definite") definiteWithUnassigned += 1;
    if (
      partial.status === "indeterminate" &&
      partial.reason.code === "not-yet-known"
    ) {
      openWithUnassigned += 1;
    }
    const partialClass = classify(partial);
    for (const completion of completionsOf(assignment)) {
      const completed = resultOf(completion);
      const where = (): string =>
        `${describeTree} under ${keyOf(assignment)} completed as ${keyOf(completion)}`;
      if (
        partial.status === "definite" &&
        JSON.stringify(completed) !== JSON.stringify(partial)
      ) {
        expect(completed, where()).toEqual(partial);
      }
      if (partialClass !== "open" && classify(completed) !== partialClass) {
        expect(classify(completed), where()).toBe(partialClass);
      }
    }
  }

  return { definiteWithUnassigned, openWithUnassigned };
}

function sumTallies(tallies: readonly Tally[]): Tally {
  return {
    definiteWithUnassigned: tallies.reduce(
      (total, { definiteWithUnassigned }) => total + definiteWithUnassigned,
      0,
    ),
    openWithUnassigned: tallies.reduce(
      (total, { openWithUnassigned }) => total + openWithUnassigned,
      0,
    ),
  };
}

describe("a definite result on a partial assignment holds on every completion", () => {
  it("for every enumerated predicate", () => {
    const tally = sumTallies(
      predicates.map((node) =>
        checkTree(JSON.stringify(node), (resolvers) =>
          evaluatePredicate(node, undefined, resolvers),
        ),
      ),
    );
    // The enumeration is not vacuous: it reaches both a definite answer and a not-yet-known one while a reference is still unassigned.
    expect(tally.definiteWithUnassigned).toBeGreaterThan(0);
    expect(tally.openWithUnassigned).toBeGreaterThan(0);
  });

  it.each<[string, ExpressionNode[]]>([
    ["plain expressions and coalesce", plainValues],
    ["conditionals under the first hit policy", conditionalsWith("first")],
    ["conditionals under the unique hit policy", conditionalsWith("unique")],
  ])("for every enumerated expression: %s", (_name, nodes) => {
    const tally = sumTallies(
      nodes.map((node) =>
        checkTree(JSON.stringify(node), (resolvers) =>
          evaluateValue(node, undefined, resolvers),
        ),
      ),
    );
    expect(tally.definiteWithUnassigned).toBeGreaterThan(0);
    expect(tally.openWithUnassigned).toBeGreaterThan(0);
  });
});
