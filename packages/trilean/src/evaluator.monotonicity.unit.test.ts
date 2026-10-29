import { describe, expect, it } from "vitest";
import type { Evaluation, IndeterminateReason } from "./evaluation";
import { coalesce } from "./derived-values";
import { createSyncEvaluator } from "./evaluator-factory";
import type { Resolution, SyncResolvers } from "./resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";

/**
 * The property a consumer evaluating a partial assignment relies on: whatever a definite answer on a partial assignment says, no completion of it can contradict. Every tree below is enumerated exhaustively over a small grammar, and each is evaluated under every partial assignment of the references it mentions (out of `a`, `b` and `c`) and under every completion of that assignment. A reference is `unassigned` (the resolver reports it as not yet known) or assigned one of `number`, `text` (usable where a number is not) or `absent` (known to be absent).
 *
 * Two facts are checked per tree and partial assignment. First, Kleene monotonicity: a definite result equals the result under every completion. Second, the classification `exists` reads off a result (`absent` for `not-found`, `present` for a definite result, `wrong-type` or `domain-error`, and `open` for `not-yet-known`) is stable: a tree that `exists` would answer `true` or `false` on the partial assignment gets the same answer under every completion. The second is what makes `exists`, and so `coalesce`, sound over a partial assignment, and it is the property that fails if a node reports `not-found` while an unknown value could still absorb it.
 *
 * The work per tree is bounded by what it mentions: a reference a tree never mentions cannot change its result, so the enumeration ranges over the mentioned references only (the resolver throws if the evaluator asks for any other, which keeps that independence checked rather than assumed). Each assignment is evaluated and summarised once, and every partial assignment then compares summaries with its completions, so a tree costs one evaluation per assignment and no evaluation per partial and completion pair.
 */

type Key = "a" | "b" | "c";

/** Ordered so that a state's position is its digit in an assignment's mixed-radix index; `unassigned` is digit 0. */
const STATES = ["unassigned", "number", "text", "absent"] as const;
type State = (typeof STATES)[number];
const UNASSIGNED_DIGIT = 0;
const COMPLETION_DIGITS: readonly number[] = STATES.map(
  (_, digit) => digit,
).filter((digit) => digit !== UNASSIGNED_DIGIT);

const KEYS: readonly Key[] = ["a", "b", "c"];

const RESOLUTIONS: Readonly<Record<State, Resolution>> = {
  unassigned: { found: false, notYetKnown: true },
  number: { found: true, value: { kind: "number", value: 1 } },
  text: { found: true, value: { kind: "text", value: "t" } },
  absent: { found: false },
};

const isKey = (key: string): key is Key => KEYS.some((known) => known === key);

/** The state of each mentioned reference, indexed by position in the tree's mentioned references; the index of an assignment is its states read as digits, first reference least significant. */
function statesAt(index: number, width: number): State[] {
  return Array.from({ length: width }, (_, position) => {
    const state =
      STATES[Math.floor(index / STATES.length ** position) % STATES.length];
    if (state === undefined) {
      throw new Error("unreachable: a digit below the radix names a state");
    }

    return state;
  });
}

/** The index of every assignment that agrees with `index` on its assigned references and gives each unassigned one a value. */
function completionsOf(index: number, width: number): number[] {
  let completions = [0];
  for (let position = 0; position < width; position += 1) {
    const weight = STATES.length ** position;
    const digit = Math.floor(index / weight) % STATES.length;
    const choices = digit === UNASSIGNED_DIGIT ? COMPLETION_DIGITS : [digit];
    completions = completions.flatMap((base) =>
      choices.map((choice) => base + choice * weight),
    );
  }

  return completions;
}

/** Every key a tree mentions as a `reference` node, in `KEYS` order. */
function mentionedKeys(node: unknown): Key[] {
  const mentioned = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (typeof value === "object" && value !== null) {
      if (
        "kind" in value &&
        value.kind === "reference" &&
        "key" in value &&
        typeof value.key === "string"
      ) {
        mentioned.add(value.key);
      }
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(node);

  return KEYS.filter((key) => mentioned.has(key));
}

/** Resolves each mentioned reference to its state and throws on any other, so a tree's independence of the references it does not mention is enforced by the evaluation itself. */
function resolversFor(
  keys: readonly Key[],
  states: readonly State[],
): SyncResolvers {
  return {
    resolveValue: (key) => {
      if (!isKey(key)) return { found: false };
      const position = keys.indexOf(key);
      const state = states[position];
      if (state === undefined) {
        throw new Error(
          `the evaluator resolved ${key}, which the tree does not mention`,
        );
      }

      return RESOLUTIONS[state];
    },
    resolveLookup: () => ({ found: false }),
    resolveCollection: () => [],
  };
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
  ...KEYS.map((key): PredicateNode => ({
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
/** `connectivesOver(representative)` is a subset of `connectivesOver(leafPredicates)` wherever the representative operands are leaf predicates, so the union is reduced to its distinct members: a tree enumerated twice proves nothing the first did not. */
const distinct = <Node extends ExpressionNode | PredicateNode>(
  nodes: readonly Node[],
): Node[] => [
  ...new Map(nodes.map((node) => [JSON.stringify(node), node])).values(),
];
const predicates: PredicateNode[] = distinct([
  ...guards,
  ...connectivesOver(leafPredicates),
]);

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

/** What one assignment's evaluation is compared by: the serialised result (a definite one must match exactly) and what `exists` reads off it. */
interface Summary {
  readonly evaluation: Evaluation<unknown>;
  readonly serialised: string;
  readonly classification: Classification;
}

/** Evaluates the tree once under every assignment of the references it mentions, then checks each partial assignment against the summaries of its completions. Fails with the offending tree, assignment and completion rather than a bare mismatch. */
function checkTree(
  node: ExpressionNode | PredicateNode,
  evaluate: (resolvers: Readonly<SyncResolvers>) => Evaluation<unknown>,
): Tally {
  const keys = mentionedKeys(node);
  const width = keys.length;
  const summaries = Array.from(
    { length: STATES.length ** width },
    (_, index): Summary => {
      const evaluation = evaluate(resolversFor(keys, statesAt(index, width)));

      return {
        evaluation,
        serialised: JSON.stringify(evaluation),
        classification: classify(evaluation),
      };
    },
  );
  const describeAssignment = (index: number): string =>
    statesAt(index, width)
      .map((state, position) => `${String(keys[position])}=${state}`)
      .join(" ");
  let definiteWithUnassigned = 0;
  let openWithUnassigned = 0;
  for (const [index, partial] of summaries.entries()) {
    const completions = completionsOf(index, width);
    if (completions.length === 1) continue;
    if (partial.evaluation.status === "definite") definiteWithUnassigned += 1;
    if (
      partial.evaluation.status === "indeterminate" &&
      partial.evaluation.reason.code === "not-yet-known"
    ) {
      openWithUnassigned += 1;
    }
    for (const completion of completions) {
      const completed = summaries[completion];
      if (completed === undefined) {
        throw new Error("unreachable: every assignment was summarised");
      }
      const where = (): string =>
        `${JSON.stringify(node)} under ${describeAssignment(index)} completed as ${describeAssignment(completion)}`;
      if (
        partial.evaluation.status === "definite" &&
        completed.serialised !== partial.serialised
      ) {
        expect(completed.evaluation, where()).toEqual(partial.evaluation);
      }
      if (
        partial.classification !== "open" &&
        completed.classification !== partial.classification
      ) {
        expect(completed.classification, where()).toBe(partial.classification);
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

/**
 * Milliseconds allowed per evaluation. The budget a test gets scales with its enumeration instead of being the runner's flat default, because the evaluations are irreducible: each (tree, assignment) pair must be evaluated once for the property to be checked on it. One millisecond is a ceiling an evaluator call stays far under even on a host oversubscribed several-fold, so the budget trips on a hang, not on contention.
 */
const EVALUATION_ALLOWANCE_MS = 1;

/** The evaluations `checkTree` performs over these trees: one per assignment of the references each mentions. */
const evaluationsOver = (
  nodes: readonly (ExpressionNode | PredicateNode)[],
): number =>
  nodes.reduce(
    (total, node) => total + STATES.length ** mentionedKeys(node).length,
    0,
  );

const budgetOver = (
  nodes: readonly (ExpressionNode | PredicateNode)[],
): number => evaluationsOver(nodes) * EVALUATION_ALLOWANCE_MS;

describe("a definite result on a partial assignment holds on every completion", () => {
  it(
    "for every enumerated predicate",
    { timeout: budgetOver(predicates) },
    () => {
      const tally = sumTallies(
        predicates.map((node) =>
          checkTree(node, (resolvers) =>
            evaluatePredicate(node, undefined, resolvers),
          ),
        ),
      );
      // The enumeration is not vacuous: it reaches both a definite answer and a not-yet-known one while a reference is still unassigned.
      expect(tally.definiteWithUnassigned).toBeGreaterThan(0);
      expect(tally.openWithUnassigned).toBeGreaterThan(0);
    },
  );

  const expressionEnumerations: readonly [string, ExpressionNode[]][] = [
    ["plain expressions and coalesce", plainValues],
    ["conditionals under the first hit policy", conditionalsWith("first")],
    ["conditionals under the unique hit policy", conditionalsWith("unique")],
  ];
  for (const [name, nodes] of expressionEnumerations) {
    it(
      `for every enumerated expression: ${name}`,
      { timeout: budgetOver(nodes) },
      () => {
        const tally = sumTallies(
          nodes.map((node) =>
            checkTree(node, (resolvers) =>
              evaluateValue(node, undefined, resolvers),
            ),
          ),
        );
        expect(tally.definiteWithUnassigned).toBeGreaterThan(0);
        expect(tally.openWithUnassigned).toBeGreaterThan(0);
      },
    );
  }
});
