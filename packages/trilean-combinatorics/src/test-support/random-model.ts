import type {
  Condition,
  Constraint,
  Dimension,
  Model,
  Rule,
  Scalar,
  Value,
} from "combinatrix";
import { choice, computed, defineModel, firstValid } from "combinatrix";
import type { ExpressionNode, PredicateNode } from "trilean";
import { trileanConstraint } from "../constraint";

/** 2 to the power 32: maps an unsigned 32-bit integer into `[0, 1)`. */
const UINT32 = 4_294_967_296;
const MULBERRY_INCREMENT = 0x6d2b79f5;
const MULBERRY_SHIFT_A = 15;
const MULBERRY_SHIFT_B = 7;
const MULBERRY_SHIFT_C = 14;
const MULBERRY_OR_A = 1;
const MULBERRY_OR_B = 61;

/** The value pools a free dimension draws its domain from. Each dimension draws from one pool, so a trilean `memberOf` comparing it with a literal of that pool's kind is always definite once it is set. */
const POOLS: readonly (readonly Scalar[])[] = [
  ["a", "b", "c"],
  [0, 1, 2],
  [true, false],
];
const MAX_FREE_DIMENSIONS = 5;
const MAX_DOMAIN = 3;
const MAX_RULES = 2;
const MAX_TRILEAN_CONSTRAINTS = 1;
/** The deepest a generated condition or predicate tree nests below its root connective. */
const MAX_DEPTH = 2;
/** One in this many free dimensions after the first is conditionally active. */
const CONDITIONAL_ONE_IN = 3;
/** One in this many models gains a first-valid dimension, and one in this many a computed one. */
const DERIVED_ONE_IN = 3;
/** The number of leaf condition forms `randomLeaf` chooses between: is, in, set and unset. */
const LEAF_FORMS = 4;
const FIRST_VALID_CANDIDATES: readonly Scalar[] = ["low", "mid", "high"];

/** Mulberry32: a small seeded generator, so every run checks the same models and a failure reproduces from its seed. */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed;
  }

  /** A number in `[0, 1)`. */
  next(): number {
    this.#state = (this.#state + MULBERRY_INCREMENT) | 0;
    let mixed = Math.imul(
      this.#state ^ (this.#state >>> MULBERRY_SHIFT_A),
      this.#state | MULBERRY_OR_A,
    );
    mixed ^=
      mixed +
      Math.imul(mixed ^ (mixed >>> MULBERRY_SHIFT_B), mixed | MULBERRY_OR_B);

    return ((mixed ^ (mixed >>> MULBERRY_SHIFT_C)) >>> 0) / UINT32;
  }

  /** An integer in `[low, high]`. */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  /** True one time in `oneIn`. */
  oneIn(oneIn: number): boolean {
    return this.int(1, oneIn) === 1;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");

    return item;
  }

  /** A selection of `size` distinct items, at most all of them, in their original order. */
  subset<T>(items: readonly T[], size: number): T[] {
    const chosen = new Set<number>();
    while (chosen.size < Math.min(size, items.length)) {
      chosen.add(this.int(0, items.length - 1));
    }

    return items.filter((_, index) => chosen.has(index));
  }
}

/** A free dimension as the generator built it, with the values it may take. */
interface FreeDimension {
  readonly name: string;
  readonly values: readonly Value[];
}

/** A generated model with the parts the tests reason about. */
export interface GeneratedModel {
  readonly model: Model<Readonly<Record<string, Value>>>;
  /** The seed it was generated from, for a failure message. */
  readonly seed: number;
}

/**
 * A random model using every feature the strategy has to handle: free dimensions whose domains may include unset, conditional activity on earlier dimensions, an optional first-valid dimension constrained by an earlier one, an optional computed dimension, declarative rules, and trilean constraints whose every reference is guarded, so they are definite on every complete assignment. Its solution set can be empty.
 */
export function randomModel(seed: number): GeneratedModel {
  const random = new Random(seed);
  const free: FreeDimension[] = [];
  const dimensions: Dimension[] = [];
  const count = random.int(1, MAX_FREE_DIMENSIONS);
  for (let index = 0; index < count; index += 1) {
    const name = `d${String(index)}`;
    const pool = random.pick(POOLS);
    const scalars: Value[] = random.subset(pool, random.int(1, MAX_DOMAIN));
    const values = random.oneIn(2) ? [undefined, ...scalars] : scalars;
    const earlier = free.at(-1);
    if (earlier !== undefined && random.oneIn(CONDITIONAL_ONE_IN)) {
      dimensions.push(
        choice(name, values, { activeWhen: randomLeaf(random, [earlier]) }),
      );
      free.push({ name, values: [undefined, ...values] });
    } else {
      dimensions.push(choice(name, values));
      free.push({ name, values });
    }
  }
  const rules: Rule[] = Array.from({ length: random.int(0, MAX_RULES) }, () =>
    randomRule(random, free),
  );
  const [first] = free;
  if (first !== undefined && random.oneIn(DERIVED_ONE_IN)) {
    dimensions.push(firstValid("level", FIRST_VALID_CANDIDATES));
    rules.push({
      requires: {
        in: ["level", random.subset(FIRST_VALID_CANDIDATES, random.int(1, 2))],
      },
      when: randomLeaf(random, [first]),
    });
  }
  if (first !== undefined && random.oneIn(DERIVED_ONE_IN)) {
    dimensions.push(
      computed("shape", {
        reads: [first.name],
        compute: (values) =>
          values[first.name] === undefined ? "none" : "some",
      }),
    );
  }
  const constraints: Constraint[] = Array.from(
    { length: random.int(0, MAX_TRILEAN_CONSTRAINTS) },
    (_, index) =>
      trileanConstraint(randomScopedTree(random, free), {
        dimensions,
        name: `trilean ${String(index)}`,
      }),
  );

  return { model: defineModel({ dimensions, rules, constraints }), seed };
}

/** A random leaf condition on one of the dimensions, comparing only with values it can take. */
function randomLeaf(
  random: Random,
  dimensions: readonly FreeDimension[],
): Condition {
  const dimension = random.pick(dimensions);
  const scalars = dimension.values.filter((value) => value !== undefined);
  const form = random.int(0, LEAF_FORMS - 1);
  if (form === 0 && scalars.length > 0) {
    return { is: [dimension.name, random.pick(scalars)] };
  }
  if (form === 1 && scalars.length > 0) {
    return {
      in: [
        dimension.name,
        random.subset(scalars, random.int(1, scalars.length)),
      ],
    };
  }

  return form === 2 ? { set: dimension.name } : { unset: dimension.name };
}

function randomRule(
  random: Random,
  dimensions: readonly FreeDimension[],
): Rule {
  const operands = Array.from({ length: random.int(1, 2) }, () =>
    randomLeaf(random, dimensions),
  );
  const body: Condition = random.oneIn(2)
    ? { all: operands }
    : { any: operands };

  const rule: Rule = random.oneIn(2) ? { requires: body } : { excludes: body };

  return random.oneIn(2)
    ? { ...rule, when: randomLeaf(random, dimensions) }
    : rule;
}

/** A trilean literal of a scalar's own kind. */
function literal(value: Scalar): ExpressionNode {
  if (typeof value === "string") return { kind: "textLiteral", value };
  if (typeof value === "number") return { kind: "numberLiteral", value };
  if (typeof value === "boolean") return { kind: "booleanLiteral", value };

  throw new Error("the pools hold no null");
}

/** A random tree that, like a scoped rule, binds only when one dimension is set: `not(exists(d)) or tree`. Scoping keeps most generated solution sets non-empty. */
function randomScopedTree(
  random: Random,
  dimensions: readonly FreeDimension[],
): PredicateNode {
  const scope = random.pick(dimensions);

  return {
    kind: "or",
    left: {
      kind: "not",
      operand: {
        kind: "exists",
        operand: { kind: "reference", key: scope.name },
      },
    },
    right: randomTree(random, dimensions, 1),
  };
}

/**
 * A random predicate tree over the dimensions whose every reference is guarded: a leaf is `exists(d)`, or `exists(d) and d in [v]` with `v` of the dimension's own kind. A guarded leaf is definite on every complete assignment (false when the dimension is unset, since a definite false absorbs), so the whole tree is.
 */
function randomTree(
  random: Random,
  dimensions: readonly FreeDimension[],
  depth: number,
): PredicateNode {
  if (depth >= MAX_DEPTH || random.oneIn(2)) {
    const dimension = random.pick(dimensions);
    const reference: ExpressionNode = {
      kind: "reference",
      key: dimension.name,
    };
    const exists: PredicateNode = { kind: "exists", operand: reference };
    const scalars = dimension.values.filter((value) => value !== undefined);
    if (scalars.length === 0 || random.oneIn(2)) return exists;

    return {
      kind: "and",
      left: exists,
      right: {
        kind: "memberOf",
        op: "in",
        operand: reference,
        candidates: [literal(random.pick(scalars))],
      },
    };
  }
  const form = random.int(0, 2);
  if (form === 0) {
    return { kind: "not", operand: randomTree(random, dimensions, depth + 1) };
  }
  const left = randomTree(random, dimensions, depth + 1);
  const right = randomTree(random, dimensions, depth + 1);

  return form === 1
    ? { kind: "and", left, right }
    : { kind: "or", left, right };
}
