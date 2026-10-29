import type {
  Constraint,
  Dimension,
  PartialAssignment,
  Scalar,
  Verdict,
} from "combinatrix";
import type {
  ComputedValue,
  ExpressionNode,
  FunctionRegistry,
  PredicateNode,
  ReferenceNode,
  Resolution,
  SyncResolvers,
} from "trilean";
import {
  DEFAULT_MAX_EVALUATION_NODES,
  DEFAULT_MAX_NESTING_DEPTH,
  PredicateNodeSchema,
  createSyncEvaluator,
  emptyFunctionRegistry,
} from "trilean";
import {
  EvaluationBudgetError,
  PredicateTreeError,
  UndecidedConstraintError,
  UnmappableValueError,
} from "./errors";

/** Options for `trileanConstraint`. */
export interface TrileanConstraintOptions {
  /** The dimensions of the model the constraint will be given to. Every reference in the tree must name one of them. */
  readonly dimensions: readonly Dimension[];
  /** A label for diagnostics, such as combinatrix's `explain` report and this package's errors. */
  readonly name?: string;
  /** The functions a `call` node may name, bound into the evaluator as trilean's `createSyncEvaluator` binds them. Defaults to trilean's empty registry, so a tree with a `call` node needs one. Every name the tree calls must be one of the registry's own keys. */
  readonly functions?: FunctionRegistry;
}

/** One node still to visit in the walk over a tree, with where it is and how deep. */
interface PendingNode {
  readonly node: PredicateNode | ExpressionNode;
  readonly path: string;
  readonly depth: number;
}

/** What a walk over a tree finds: its defects, the dimensions its references name in the order first met, its node count and its deepest node's depth. */
interface TreeSurvey {
  readonly issues: string[];
  readonly references: string[];
  nodes: number;
  deepest: number;
}

/** The node kinds the adapter refuses: each needs a resolver an assignment of dimensions cannot back. */
type RefusedKind =
  | "some"
  | "every"
  | "fold"
  | "accumulator"
  | "lookup"
  | "delegate"
  | "treeReference";

/** Why each refused node kind cannot be evaluated over an assignment of dimensions. */
const REFUSED_KINDS: Readonly<Record<RefusedKind, string>> = {
  some: "it quantifies over a collection, and an assignment of dimensions resolves no collections",
  every:
    "it quantifies over a collection, and an assignment of dimensions resolves no collections",
  fold: "it folds over a collection, and an assignment of dimensions resolves no collections",
  accumulator: "it is meaningful only inside a fold, which is refused",
  lookup:
    "it reads a table, and an assignment of dimensions resolves no tables",
  delegate:
    "it defers to an external system, and the adapter supplies no delegate resolver",
  treeReference:
    "it resolves another tree by key, and the adapter supplies no tree resolver",
};

/**
 * Turns a trilean predicate tree, given as plain JSON, into a combinatrix `Constraint` over the given dimensions.
 *
 * The tree is validated with trilean's `PredicateNodeSchema` and then walked, and `PredicateTreeError` lists every defect: a node kind the adapter cannot resolve (`some`, `every`, `fold`, `accumulator`, `lookup`, `delegate`, `treeReference`), a `reference` whose key is not a string or names no dimension, a `reference` carrying a `unit` (dimension values carry none), a `call` to a function the registry does not hold, and a referenced choice or first-valid dimension that can take `null`, which has no trilean value. The kinds accepted are listed explicitly, so a node kind trilean adds later is refused until the adapter is taught it. `EvaluationBudgetError` is thrown when the tree's node count or depth exceeds trilean's default evaluation budget, which is checked here because an accepted tree visits each node at most once per evaluation.
 *
 * `dependencies` are the dimensions the tree's references name, in the order the tree first mentions them. `evaluate` runs trilean's synchronous evaluator with each reference resolved from the assignment: a dimension assigned a string, number or boolean resolves to that text, number or boolean; one assigned unset resolves as known absent (`{ found: false }`, so `exists` is definitely false); one not yet assigned resolves as not yet known (`{ found: false, notYetKnown: true }`, so `exists` and everything reading it stays indeterminate until it is assigned, which is what keeps a definite answer the answer on every completion). A definite true is `valid` and a definite false `invalid`. An indeterminate result is `unknown` while some dependency is unassigned, and throws `UndecidedConstraintError`, carrying trilean's reason, once every dependency is assigned, since the contract forbids `unknown` there. A computed dimension that produces `null` throws `UnmappableValueError` when it is read.
 */
export function trileanConstraint(
  tree: unknown,
  options: TrileanConstraintOptions,
): Constraint {
  const parsed = PredicateNodeSchema.safeParse(tree);
  if (!parsed.success) {
    throw new PredicateTreeError(
      parsed.error.issues.map(
        (issue) =>
          `${pathText(issue.path)}: ${issue.message} (not a trilean predicate tree)`,
      ),
    );
  }
  const node = parsed.data;
  const functions = options.functions ?? emptyFunctionRegistry;
  const byName = new Map(
    options.dimensions.map((dimension) => [dimension.name, dimension]),
  );
  const survey = surveyTree(node, byName, functions);
  if (survey.issues.length > 0) throw new PredicateTreeError(survey.issues);
  if (survey.nodes > DEFAULT_MAX_EVALUATION_NODES) {
    throw new EvaluationBudgetError(
      "nodes",
      survey.nodes,
      DEFAULT_MAX_EVALUATION_NODES,
    );
  }
  if (survey.deepest >= DEFAULT_MAX_NESTING_DEPTH) {
    throw new EvaluationBudgetError(
      "depth",
      survey.deepest,
      DEFAULT_MAX_NESTING_DEPTH,
    );
  }

  const dependencies: readonly string[] = survey.references;
  const label =
    options.name === undefined
      ? "trilean constraint"
      : `trilean constraint "${options.name}"`;
  const evaluator = createSyncEvaluator({ functions });
  const evaluate = (assignment: PartialAssignment): Verdict => {
    const result = evaluator.evaluatePredicate(
      node,
      undefined,
      resolversFor(assignment),
    );
    if (result.status === "definite") return result.value ? "valid" : "invalid";
    if (dependencies.every((dependency) => assignment.has(dependency))) {
      throw new UndecidedConstraintError(label, result.reason);
    }

    return "unknown";
  };

  return options.name === undefined
    ? { dependencies, evaluate }
    : { dependencies, evaluate, name: options.name };
}

/** Walks the tree from the root, depth first, without recursion, so the depth check reports a deep tree rather than overflowing the walk's own stack. */
function surveyTree(
  root: PredicateNode,
  byName: ReadonlyMap<string, Dimension>,
  functions: Readonly<FunctionRegistry>,
): TreeSurvey {
  const survey: TreeSurvey = {
    issues: [],
    references: [],
    nodes: 0,
    deepest: 0,
  };
  const pending: PendingNode[] = [{ node: root, path: "$", depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    survey.nodes += 1;
    survey.deepest = Math.max(survey.deepest, next.depth);
    const children = visit(next, survey, byName, functions);
    // Pushed in reverse, so they are popped, and their references first met, in the order the tree lists them.
    for (const [suffix, child] of children.toReversed()) {
      pending.push({
        node: child,
        path: `${next.path}${suffix}`,
        depth: next.depth + 1,
      });
    }
  }

  return survey;
}

/** Records the node's own defects and references in the survey, and returns its children with the path suffix that reaches each. */
function visit(
  { node, path }: PendingNode,
  survey: TreeSurvey,
  byName: ReadonlyMap<string, Dimension>,
  functions: Readonly<FunctionRegistry>,
): (readonly [string, PredicateNode | ExpressionNode])[] {
  switch (node.kind) {
    case "not":
    case "exists":
    case "negate":
      return [[".operand", node.operand]];
    case "and":
    case "or":
    case "compare":
    case "textCompare":
    case "arithmetic":
      return [
        [".left", node.left],
        [".right", node.right],
      ];
    case "allOf":
    case "anyOf":
      return node.operands.map(
        (operand, index) => [`.operands[${String(index)}]`, operand] as const,
      );
    case "memberOf":
      return [
        [".operand", node.operand],
        ...node.candidates.map(
          (candidate, index) =>
            [`.candidates[${String(index)}]`, candidate] as const,
        ),
      ];
    case "call":
      if (!Object.hasOwn(functions, node.fn)) {
        survey.issues.push(
          `${path}: calls "${node.fn}", which the function registry does not hold`,
        );
      }

      return node.args.map(
        (argument, index) => [`.args[${String(index)}]`, argument] as const,
      );
    case "conditional":
      return [
        ...node.cases.flatMap(
          ({ when, then }, index) =>
            [
              [`.cases[${String(index)}].when`, when],
              [`.cases[${String(index)}].then`, then],
            ] as const,
        ),
        [".fallback", node.fallback],
      ];
    case "reference":
      checkReference(node, path, survey, byName);

      return [];
    case "numberLiteral":
    case "textLiteral":
    case "booleanLiteral":
    case "instantLiteral":
    case "durationLiteral":
    case "complexLiteral":
      return [];
    case "some":
    case "every":
    case "fold":
    case "accumulator":
    case "lookup":
    case "delegate":
    case "treeReference":
      survey.issues.push(
        `${path}: "${node.kind}" is not supported, because ${REFUSED_KINDS[node.kind]}`,
      );

      return [];
    default:
      return unreachableKind(node);
  }
}

/** Records a reference's defects, or the dimension it names when it has none. */
function checkReference(
  { key, unit }: ReferenceNode,
  path: string,
  survey: TreeSurvey,
  byName: ReadonlyMap<string, Dimension>,
): void {
  if (typeof key !== "string") {
    survey.issues.push(
      `${path}: the reference key ${JSON.stringify(key)} is not a string naming a dimension`,
    );

    return;
  }
  const dimension = byName.get(key);
  if (dimension === undefined) {
    survey.issues.push(
      `${path}: the reference key "${key}" names no dimension of the model`,
    );

    return;
  }
  if (unit !== undefined) {
    survey.issues.push(
      `${path}: the reference to "${key}" carries a unit, and dimension values carry none, so it could never match`,
    );
  }
  if (survey.references.includes(key)) return;

  survey.references.push(key);
  if (declaredValues(dimension).includes(null)) {
    survey.issues.push(
      `${path}: dimension "${key}" can take null, which has no trilean value`,
    );
  }
}

/** The values a dimension declares: a choice's domain or a first-valid dimension's candidates. A computed dimension declares none, so its values are checked as they are read. */
function declaredValues(dimension: Dimension): readonly unknown[] {
  if (dimension.kind === "choice") return dimension.values;
  if (dimension.kind === "first-valid") return dimension.candidates;

  return [];
}

/** Resolvers reading each reference from the assignment. Only `resolveValue` is reachable: the tree was checked to hold no node kind that calls the others. */
function resolversFor(assignment: PartialAssignment): SyncResolvers {
  return {
    resolveValue: (key): Resolution => {
      if (typeof key !== "string") {
        throw new Error(
          `unreachable: every reference key was checked to be a string, not ${JSON.stringify(key)}`,
        );
      }
      if (!assignment.has(key)) return { found: false, notYetKnown: true };

      const value = assignment.get(key);
      if (value === undefined) return { found: false };

      return { found: true, value: computedValueOf(key, value) };
    },
    resolveLookup: () => {
      throw new Error(
        "unreachable: a tree with a lookup node is refused when the constraint is defined",
      );
    },
    resolveCollection: () => {
      throw new Error(
        "unreachable: a tree with a collection node is refused when the constraint is defined",
      );
    },
  };
}

/** A dimension's set value as trilean's value of the same kind: a string is text, a finite number is a number with no unit, a boolean is a boolean. `null` has no counterpart and throws. */
function computedValueOf(dimension: string, value: Scalar): ComputedValue {
  if (typeof value === "string") return { kind: "text", value };
  if (typeof value === "number") return { kind: "number", value };
  if (typeof value === "boolean") return { kind: "boolean", value };

  throw new UnmappableValueError(dimension, value);
}

/** A Zod issue path as the walk's path notation: `$`, then `.name` per key and `[n]` per index. */
function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, segment) =>
      typeof segment === "number"
        ? `${text}[${String(segment)}]`
        : `${text}.${String(segment)}`,
    "$",
  );
}

/** Fails the build when trilean adds a node kind the walk does not list, and the walk at run time if a tree reaches it some other way. */
function unreachableKind(node: never): never {
  throw new Error(
    `unreachable: node kind ${JSON.stringify(node)} is not one the walk knows`,
  );
}
