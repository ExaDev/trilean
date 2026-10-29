import { describe, expect, it } from "vitest";
import { builtinFunctions } from "./builtin-functions";
import { createSyncEvaluator } from "./evaluator-factory";
import type { FunctionRegistry } from "./functions";
import type { JsonValue } from "./json-value";
import type { Resolution, SyncResolvers } from "./resolvers";
import type {
  ComparisonOperator,
  ExpressionNode,
  PredicateNode,
  TextComparisonOperator,
} from "./tree";

/**
 * The interpreter is the reference: for every tree and every answer the resolvers can give, the compiled predicate must return exactly the `Evaluation` the synchronous interpreter returns, and must ask the resolvers the same questions in the same order. Trees are drawn from a seeded generator over every node kind, including the kinds the compiled path leaves to the interpreter, and are evaluated under randomly drawn resolver answers (definite, absent, not yet known) and under several budgets, so that a limit being met is compared as well. A failure prints the seed that reproduces it.
 */

const KEYS = ["a", "b", "c", "d"] as const;

// Parameters of mulberry32, a small deterministic generator, so a failing case is reproduced by its seed alone.
const MULBERRY_INCREMENT = 0x6d2b79f5;
const MULBERRY_FIRST_SHIFT = 15;
const MULBERRY_SECOND_SHIFT = 7;
const MULBERRY_THIRD_SHIFT = 14;
const MULBERRY_OR_MASK = 61;
const UINT32_RANGE = 4294967296;

// How the generated trees are shaped: how deep, how wide, and how often a leaf is a reference rather than a literal.
const MAX_TREE_DEPTH = 5;
const MAX_OPERANDS = 3;
const MAX_CASES = 4;
const NUMBER_RANGE = 4;
const SELDOM = 0.3;
const HALF = 0.5;
const USUALLY = 0.7;

/** A seeded pseudo-random source. */
function createRandom(seed: number): {
  int: (below: number) => number;
  pick: <T>(items: readonly T[]) => T;
  chance: (probability: number) => boolean;
} {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> MULBERRY_FIRST_SHIFT), mixed | 1);
    mixed ^=
      mixed +
      Math.imul(
        mixed ^ (mixed >>> MULBERRY_SECOND_SHIFT),
        mixed | MULBERRY_OR_MASK,
      );

    return ((mixed ^ (mixed >>> MULBERRY_THIRD_SHIFT)) >>> 0) / UINT32_RANGE;
  };
  const int = (below: number): number => Math.floor(next() * below);

  return {
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("pick from an empty list");

      return item;
    },
    chance: (probability) => next() < probability,
  };
}

type Random = ReturnType<typeof createRandom>;

type Build<T> = (random: Readonly<Random>, depth: number) => T;

const COMPARISON_OPERATORS: readonly ComparisonOperator[] = [
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
];
const TEXT_OPERATORS: readonly TextComparisonOperator[] = [
  "equals",
  "notEquals",
  "matches",
  "notMatches",
  "portableMatches",
  "portableNotMatches",
];

function referenceNode(random: Readonly<Random>): ExpressionNode {
  const key = random.pick(KEYS);

  return random.chance(USUALLY)
    ? { kind: "reference", key }
    : { kind: "reference", key, unit: { m: 1 } };
}

const LITERAL_BUILDERS: readonly ((
  random: Readonly<Random>,
) => ExpressionNode)[] = [
  (random) => ({ kind: "numberLiteral", value: random.int(NUMBER_RANGE) }),
  (random) => ({
    kind: "numberLiteral",
    value: random.int(NUMBER_RANGE),
    unit: { m: 1 },
  }),
  (random) => ({
    kind: "textLiteral",
    value: random.pick(["x", "y", "^x"]),
  }),
  (random) => ({ kind: "booleanLiteral", value: random.chance(HALF) }),
  (random) => ({
    kind: "durationLiteral",
    value: random.int(NUMBER_RANGE),
    unit: "s",
  }),
  (random) => ({
    kind: "complexLiteral",
    re: random.int(NUMBER_RANGE),
    im: random.int(NUMBER_RANGE),
  }),
  (random) => ({
    kind: "complexLiteral",
    magnitude: random.int(NUMBER_RANGE),
    phase: 1,
  }),
];

function leafValue(random: Readonly<Random>): ExpressionNode {
  return random.chance(USUALLY)
    ? referenceNode(random)
    : random.pick(LITERAL_BUILDERS)(random);
}

const some = <T>(
  random: Readonly<Random>,
  build: () => T,
  below: number,
): T[] => Array.from({ length: random.int(below) }, build);

/** Each builder is one node kind; a kind listed twice is drawn twice as often. */
const EXPRESSION_BUILDERS: readonly Build<ExpressionNode>[] = [
  (random, depth) => ({
    kind: "arithmetic",
    op: random.pick(["add", "subtract", "multiply", "divide", "modulo"]),
    left: expressionNode(random, depth),
    right: expressionNode(random, depth),
  }),
  (random, depth) => ({
    kind: "negate",
    operand: expressionNode(random, depth),
  }),
  (random, depth) => ({
    kind: "call",
    fn: random.pick(["minimum", "absoluteValue", "round", "missing"]),
    args: some(random, () => expressionNode(random, depth), MAX_OPERANDS),
  }),
  (random, depth) => ({
    kind: "lookup",
    table: "t",
    keys: some(random, () => expressionNode(random, depth), MAX_OPERANDS),
  }),
  (random, depth) => ({
    kind: "conditional",
    hitPolicy: random.pick(["first", "unique"]),
    cases: some(
      random,
      () => ({
        when: predicateNode(random, depth),
        then: expressionNode(random, depth),
      }),
      MAX_CASES,
    ),
    fallback: expressionNode(random, depth),
  }),
  (random) => ({ kind: "delegate", system: "s", payload: random.int(2) }),
  () => ({ kind: "accumulator" }),
  (random, depth) => ({
    kind: "fold",
    collection: "items",
    filter: random.chance(HALF) ? predicateNode(random, depth) : undefined,
    combiner: random.chance(HALF)
      ? { mode: "max", item: expressionNode(random, depth) }
      : {
          mode: "reduce",
          initial: expressionNode(random, depth),
          combine: { kind: "accumulator" },
        },
  }),
  (random) => ({
    kind: "treeReference",
    key: random.pick(["e", "loop", "none"]),
  }),
  (random) => leafValue(random),
  (random) => leafValue(random),
];

function expressionNode(
  random: Readonly<Random>,
  depth: number,
): ExpressionNode {
  if (depth <= 0 || random.chance(SELDOM)) return leafValue(random);

  return random.pick(EXPRESSION_BUILDERS)(random, depth - 1);
}

const PREDICATE_BUILDERS: readonly Build<PredicateNode>[] = [
  (random, depth) => ({ kind: "not", operand: predicateNode(random, depth) }),
  (random, depth) => ({
    kind: "and",
    left: predicateNode(random, depth),
    right: predicateNode(random, depth),
  }),
  (random, depth) => ({
    kind: "or",
    left: predicateNode(random, depth),
    right: predicateNode(random, depth),
  }),
  (random, depth) => ({
    kind: "allOf",
    operands: some(random, () => predicateNode(random, depth), MAX_CASES),
  }),
  (random, depth) => ({
    kind: "anyOf",
    operands: some(random, () => predicateNode(random, depth), MAX_CASES),
  }),
  (random, depth) => ({
    kind: "compare",
    op: random.pick(COMPARISON_OPERATORS),
    left: expressionNode(random, depth),
    right: expressionNode(random, depth),
  }),
  (random, depth) => ({
    kind: "textCompare",
    op: random.pick(TEXT_OPERATORS),
    left: expressionNode(random, depth),
    right: expressionNode(random, depth),
  }),
  (random, depth) => ({
    kind: "textCompare",
    op: random.pick(TEXT_OPERATORS),
    left: referenceNode(random),
    right: expressionNode(random, depth),
  }),
  (random, depth) => ({
    kind: "memberOf",
    op: random.pick(["in", "notIn"]),
    operand: expressionNode(random, depth),
    candidates: some(random, () => expressionNode(random, depth), MAX_CASES),
  }),
  (random, depth) => ({
    kind: "exists",
    operand: expressionNode(random, depth),
  }),
  (random, depth) => ({
    kind: "some",
    collection: "items",
    item: predicateNode(random, depth),
    filter: random.chance(HALF) ? predicateNode(random, depth) : undefined,
  }),
  (random, depth) => ({
    kind: "every",
    collection: "items",
    item: predicateNode(random, depth),
    filter: undefined,
  }),
  (random) => ({
    kind: "treeReference",
    key: random.pick(["p", "loop", "none"]),
  }),
];

function predicateNode(random: Readonly<Random>, depth: number): PredicateNode {
  if (depth <= 0) {
    return { kind: "exists", operand: referenceNode(random) };
  }

  return random.pick(PREDICATE_BUILDERS)(random, depth - 1);
}

/** What a reference can resolve to: the three outcomes the evaluator distinguishes (a value, known absence, not yet known), the value varying in kind and unit. */
const ANSWERS: readonly Resolution[] = [
  { found: true, value: { kind: "number", value: 1 } },
  { found: true, value: { kind: "number", value: 2, unit: { m: 1 } } },
  { found: true, value: { kind: "text", value: "x" } },
  { found: true, value: { kind: "boolean", value: true } },
  { found: true, value: { kind: "duration", value: 3, unit: "s" } },
  { found: false },
  { found: false, notYetKnown: true },
];

/** What `resolveTree` returns per key: a predicate, an expression, and a tree that refers to itself. */
const TREES = new Map<string, JsonValue>([
  ["p", { kind: "exists", operand: { kind: "reference", key: "a" } }],
  ["e", { kind: "reference", key: "b" }],
  ["loop", { kind: "treeReference", key: "loop" }],
]);

const LARGEST_COLLECTION = 3;
const LARGEST_ITEMS = Array.from(
  { length: LARGEST_COLLECTION },
  (_, index) => index + 1,
);
const COLLECTIONS: readonly (readonly number[])[] = [[], [1], LARGEST_ITEMS];

/** Resolvers answering from a fixed table of answers, and recording every question asked in the order asked. A collection item that is a number resolves every reference to itself, so quantifier bodies see their own context. */
function recordingResolvers(
  random: Readonly<Random>,
  record: (question: string) => void,
): Readonly<SyncResolvers> {
  const answers = new Map<unknown, Resolution>(
    KEYS.map((key) => [key, random.pick(ANSWERS)]),
  );
  const lookupAnswer = random.pick(ANSWERS);
  const delegateAnswer = random.pick(ANSWERS);
  const items = random.pick(COLLECTIONS);

  return {
    resolveValue: (key, context) => {
      record(`value ${JSON.stringify(key)} ${JSON.stringify(context)}`);
      if (typeof context === "number") {
        return { found: true, value: { kind: "number", value: context } };
      }

      return answers.get(key) ?? { found: false };
    },
    resolveLookup: (table, keys) => {
      record(`lookup ${JSON.stringify(table)} ${JSON.stringify(keys)}`);

      return lookupAnswer;
    },
    resolveCollection: (collection) => {
      record(`collection ${JSON.stringify(collection)}`);

      return [...items];
    },
    resolveDelegate: (system, payload) => {
      record(`delegate ${system} ${JSON.stringify(payload)}`);

      return delegateAnswer;
    },
    resolveTree: (key) => {
      record(`tree ${JSON.stringify(key)}`);
      const node = typeof key === "string" ? TREES.get(key) : undefined;

      return node === undefined ? { found: false } : { found: true, node };
    },
  };
}

/** `recordingResolvers` over the answers drawn from `seed`, with the questions it is asked collected in `log`. */
function loggingResolvers(seed: number): {
  resolvers: Readonly<SyncResolvers>;
  log: string[];
} {
  const log: string[] = [];
  const resolvers = recordingResolvers(createRandom(seed), (question) => {
    log.push(question);
  });

  return { resolvers, log };
}

/** A tight and a roomy limit on each axis, so that trees of every size meet a limit in some configuration and not in another. */
const LIMITS = [
  {},
  { maxNodes: 4 },
  { maxNodes: 9 },
  { maxNestingDepth: 2 },
  { maxNestingDepth: 4, maxNodes: 30 },
] as const;

const TREE_COUNT = 1500;
const ASSIGNMENTS_PER_TREE = 4;
/** Separates the answer seeds of different trees, so that no two (tree, assignment) pairs share one. */
const ANSWER_SEED_STRIDE = 1000;

const SWEPT_MAX_NODES = 12;
const RESOLVER_SEED = 7;
const DEEP_NESTING = 5000;

describe("compiled predicates agree with the interpreter", () => {
  it("returns the interpreter's Evaluation and asks the resolvers the same questions, for random trees", () => {
    for (let treeSeed = 1; treeSeed <= TREE_COUNT; treeSeed += 1) {
      const random = createRandom(treeSeed);
      const tree = predicateNode(random, random.int(MAX_TREE_DEPTH));
      const limits = random.pick(LIMITS);
      const evaluator = createSyncEvaluator({
        functions: builtinFunctions,
        ...limits,
      });
      const compiled = evaluator.compilePredicate(tree);
      for (let round = 0; round < ASSIGNMENTS_PER_TREE; round += 1) {
        const answerSeed = treeSeed * ANSWER_SEED_STRIDE + round;
        const interpreted = loggingResolvers(answerSeed);
        const compiledRun = loggingResolvers(answerSeed);
        const expected = evaluator.evaluatePredicate(
          tree,
          undefined,
          interpreted.resolvers,
        );
        const actual = compiled(undefined, compiledRun.resolvers);
        expect(
          actual,
          `tree seed ${treeSeed.toString()}, answer seed ${answerSeed.toString()}`,
        ).toStrictEqual(expected);
        expect(
          compiledRun.log,
          `resolver calls, tree seed ${treeSeed.toString()}, answer seed ${answerSeed.toString()}`,
        ).toStrictEqual(interpreted.log);
      }
    }
  });

  it("exercises definite results, every indeterminate reason and the resource limits", () => {
    const seen = new Set<string>();
    for (let treeSeed = 1; treeSeed <= TREE_COUNT; treeSeed += 1) {
      const random = createRandom(treeSeed);
      const tree = predicateNode(random, random.int(MAX_TREE_DEPTH));
      const limits = random.pick(LIMITS);
      const evaluator = createSyncEvaluator({
        functions: builtinFunctions,
        ...limits,
      });
      const result = evaluator.compilePredicate(tree)(
        undefined,
        loggingResolvers(treeSeed * ANSWER_SEED_STRIDE).resolvers,
      );
      seen.add(
        result.status === "definite"
          ? `definite ${String(result.value)}`
          : `${result.reason.code}${result.reason.message.includes("resource exhausted") ? " (resource)" : ""}`,
      );
    }

    expect([...seen].sort()).toStrictEqual([
      "definite false",
      "definite true",
      "domain-error",
      "domain-error (resource)",
      "not-found",
      "not-yet-known",
      "wrong-type",
    ]);
  });
});

/** A reference to `key`, compared for equality with a text literal. */
function equalsText(key: string, value: string): PredicateNode {
  return {
    kind: "textCompare",
    op: "equals",
    left: { kind: "reference", key },
    right: { kind: "textLiteral", value },
  };
}

function answering(
  answers: Readonly<Record<string, Resolution>>,
): SyncResolvers {
  return {
    resolveValue: (key) =>
      (typeof key === "string" ? answers[key] : undefined) ?? { found: false },
    resolveLookup: () => ({ found: false }),
    resolveCollection: () => [],
  };
}

describe("compiled predicates, directed cases", () => {
  const evaluator = createSyncEvaluator({ functions: builtinFunctions });

  it("reports not-yet-known ahead of an earlier not-found, and the first of equal reasons", () => {
    const tree: PredicateNode = {
      kind: "memberOf",
      op: "in",
      operand: { kind: "textLiteral", value: "x" },
      candidates: [
        { kind: "reference", key: "gone" },
        { kind: "reference", key: "later" },
        { kind: "reference", key: "wrong" },
      ],
    };
    const resolvers = answering({
      later: { found: false, notYetKnown: true },
      wrong: { found: true, value: { kind: "number", value: 1 } },
    });

    const compiled = evaluator.compilePredicate(tree)(undefined, resolvers);

    expect(compiled).toStrictEqual(
      evaluator.evaluatePredicate(tree, undefined, resolvers),
    );
    expect(compiled).toMatchObject({
      status: "indeterminate",
      reason: { code: "not-yet-known" },
    });
  });

  it("takes the left operand's reason of two indeterminate operands", () => {
    const tree: PredicateNode = {
      kind: "and",
      left: equalsText("gone", "x"),
      right: equalsText("wrong", "x"),
    };
    const resolvers = answering({
      wrong: { found: true, value: { kind: "number", value: 1 } },
    });

    const compiled = evaluator.compilePredicate(tree)(undefined, resolvers);

    expect(compiled).toStrictEqual(
      evaluator.evaluatePredicate(tree, undefined, resolvers),
    );
    expect(compiled).toMatchObject({
      status: "indeterminate",
      reason: { code: "not-found" },
    });
  });

  it("gives each call its own answers when the same compiled predicate is called with different resolvers", () => {
    const compiled = evaluator.compilePredicate(equalsText("a", "x"));

    expect(
      compiled(
        undefined,
        answering({ a: { found: true, value: { kind: "text", value: "x" } } }),
      ),
    ).toStrictEqual({ status: "definite", value: true });
    expect(
      compiled(
        undefined,
        answering({ a: { found: true, value: { kind: "text", value: "y" } } }),
      ),
    ).toStrictEqual({ status: "definite", value: false });
    expect(compiled(undefined, answering({}))).toMatchObject({
      status: "indeterminate",
      reason: { code: "not-found" },
    });
  });

  it("builds a literal handed to a registered function afresh on every call", () => {
    const mutating: FunctionRegistry = {
      bump: (args) => {
        const [first] = args;
        if (first?.kind !== "number") return { wrongType: "number expected" };
        first.value += 1;

        return first;
      },
    };
    const mutatingEvaluator = createSyncEvaluator({ functions: mutating });
    const tree: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: {
        kind: "call",
        fn: "bump",
        args: [{ kind: "numberLiteral", value: 1 }],
      },
      right: { kind: "numberLiteral", value: 2 },
    };
    const compiled = mutatingEvaluator.compilePredicate(tree);
    const resolvers = answering({});

    expect(compiled(undefined, resolvers)).toStrictEqual({
      status: "definite",
      value: true,
    });
    expect(compiled(undefined, resolvers)).toStrictEqual(
      mutatingEvaluator.evaluatePredicate(tree, undefined, resolvers),
    );
  });

  it("meets a node limit at the same node as the interpreter, with the resolvers asked the same questions", () => {
    const tree: PredicateNode = {
      kind: "allOf",
      operands: [
        equalsText("a", "x"),
        equalsText("b", "x"),
        equalsText("c", "x"),
      ],
    };
    for (let maxNodes = 1; maxNodes <= SWEPT_MAX_NODES; maxNodes += 1) {
      const limited = createSyncEvaluator({ maxNodes });
      const interpreted = loggingResolvers(RESOLVER_SEED);
      const compiledRun = loggingResolvers(RESOLVER_SEED);
      const expected = limited.evaluatePredicate(
        tree,
        undefined,
        interpreted.resolvers,
      );
      const actual = limited.compilePredicate(tree)(
        undefined,
        compiledRun.resolvers,
      );

      expect(actual, `maxNodes ${maxNodes.toString()}`).toStrictEqual(expected);
      expect(compiledRun.log, `maxNodes ${maxNodes.toString()}`).toStrictEqual(
        interpreted.log,
      );
    }
  });

  it("hands a tree deeper than the nesting limit to the interpreter without compiling past the limit", () => {
    let tree: PredicateNode = equalsText("a", "x");
    for (let level = 0; level < DEEP_NESTING; level += 1) {
      tree = { kind: "not", operand: tree };
    }
    const resolvers = answering({});

    const compiled = evaluator.compilePredicate(tree)(undefined, resolvers);

    expect(compiled).toStrictEqual(
      evaluator.evaluatePredicate(tree, undefined, resolvers),
    );
    expect(compiled).toMatchObject({
      status: "indeterminate",
      reason: { code: "domain-error" },
    });
  });

  it("throws, as the interpreter does, when a resolver returns a promise", () => {
    const tree = equalsText("a", "x");
    const found = false as const;
    // The synchronous contract forbids a promise, so this one is also an absence: it satisfies the type and is still thenable.
    const thenableAbsence = { found, then: () => undefined };
    const promising: SyncResolvers = {
      ...answering({}),
      resolveValue: () => thenableAbsence,
    };

    expect(() =>
      evaluator.evaluatePredicate(tree, undefined, promising),
    ).toThrow(TypeError);
    expect(() =>
      evaluator.compilePredicate(tree)(undefined, promising),
    ).toThrow(TypeError);
  });

  it("reports a delegate node as wrong-type when the resolvers register no handler", () => {
    const tree: PredicateNode = {
      kind: "exists",
      operand: { kind: "delegate", system: "billing", payload: null },
    };
    const resolvers = answering({});

    expect(
      evaluator.compilePredicate(tree)(undefined, resolvers),
    ).toStrictEqual(evaluator.evaluatePredicate(tree, undefined, resolvers));
  });

  it("passes the context to the resolvers untouched", () => {
    const seen: unknown[] = [];
    const context = { tenant: "t" };
    const resolvers: SyncResolvers = {
      ...answering({}),
      resolveValue: (_key, received) => {
        seen.push(received);

        return { found: false };
      },
    };

    evaluator.compilePredicate(equalsText("a", "x"))(context, resolvers);

    expect(seen).toStrictEqual([context]);
    expect(seen[0]).toBe(context);
  });
});
