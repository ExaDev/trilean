import type { ComputedValue } from "./computed-value";
import type { Evaluation } from "./evaluation";
import { createSyncEvaluator } from "./evaluator-factory";
import { builtinFunctions } from "./builtin-functions";
import { createInputResolvers, parseInputs } from "./input-resolvers";
import type { ExpressionNode, PredicateNode } from "./tree";
import { ExpressionNodeSchema, PredicateNodeSchema } from "./tree";
import type { z } from "zod";

export type TreeKind = "predicate" | "expression";

export interface EvaluateDocumentOptions {
  /** The tree as parsed from JSON, not yet validated. */
  tree: unknown;
  /** Named inputs as parsed from JSON (see `parseInputs`); absent means none. */
  inputs?: unknown;
  /** Which tree `tree` is. Needed only when its root is a `treeReference`, the one node kind valid in both. */
  as?: TreeKind;
}

export type DocumentEvaluation =
  | {
      outcome: "evaluated";
      treeKind: "predicate";
      evaluation: Evaluation<boolean>;
    }
  | {
      outcome: "evaluated";
      treeKind: "expression";
      evaluation: Evaluation<ComputedValue>;
    }
  | { outcome: "rejected"; issues: readonly string[] };

const predicateKinds: ReadonlySet<string> = new Set(
  PredicateNodeSchema.options.map((option) => option.shape.kind.value),
);

const evaluator = createSyncEvaluator({ functions: builtinFunctions });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns zod's issues into `path: message` lines. A failed union wraps one list of issues per branch, each path relative to the union; the branch the input got furthest into (the deepest path) is the one it was meant to match, so only that branch's issues are reported, under the union's own path. */
function describeIssues(
  issues: readonly z.core.$ZodIssue[],
  parentPath: readonly PropertyKey[] = [],
): string[] {
  return issues.flatMap((issue) => {
    const path = [...parentPath, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const deepest = issue.errors.reduce((best, branch) =>
        maxPathLength(branch) > maxPathLength(best) ? branch : best,
      );

      return describeIssues(deepest, path);
    }

    return [
      `${path.length === 0 ? "(root)" : path.join(".")}: ${issue.message}`,
    ];
  });
}

function maxPathLength(issues: readonly z.core.$ZodIssue[]): number {
  return Math.max(0, ...issues.map((issue) => issue.path.length));
}

function resolveTreeKind(
  tree: unknown,
  requested: TreeKind | undefined,
): TreeKind | { issue: string } {
  if (requested !== undefined) return requested;
  const kind = isPlainRecord(tree) ? tree.kind : undefined;
  if (kind === "treeReference") {
    return {
      issue:
        "a treeReference is valid as a predicate and as an expression: say which with `as`",
    };
  }

  return typeof kind === "string" && predicateKinds.has(kind)
    ? "predicate"
    : "expression";
}

/**
 * Validates a tree and its named inputs and evaluates it with the built-in function registry (`builtinFunctions`), the evaluation the `trilean evaluate` command performs. The tree kind is read from the root node's `kind` unless `as` names it. A tree that fails its schema, or an input that is not a computed value, is `rejected` with one line per problem and nothing is evaluated; everything else is an `Evaluation`, definite or indeterminate. Resolution is limited to what `createInputResolvers` provides, and its collection error propagates for a tree that folds or quantifies over one.
 */
export function evaluateDocument({
  tree,
  inputs,
  as,
}: EvaluateDocumentOptions): DocumentEvaluation {
  const parsedInputs = parseInputs(inputs ?? {});
  if (!parsedInputs.ok) {
    return { outcome: "rejected", issues: parsedInputs.issues };
  }
  const resolvers = createInputResolvers(parsedInputs.inputs);
  const treeKind = resolveTreeKind(tree, as);
  if (typeof treeKind === "object") {
    return { outcome: "rejected", issues: [treeKind.issue] };
  }
  if (treeKind === "predicate") {
    const parsed = PredicateNodeSchema.safeParse(tree);
    if (!parsed.success) {
      return {
        outcome: "rejected",
        issues: describeIssues(parsed.error.issues),
      };
    }
    const node: PredicateNode = parsed.data;

    return {
      outcome: "evaluated",
      treeKind,
      evaluation: evaluator.evaluatePredicate(node, undefined, resolvers),
    };
  }
  const parsed = ExpressionNodeSchema.safeParse(tree);
  if (!parsed.success) {
    return { outcome: "rejected", issues: describeIssues(parsed.error.issues) };
  }
  const node: ExpressionNode = parsed.data;

  return {
    outcome: "evaluated",
    treeKind,
    evaluation: evaluator.evaluateValue(node, undefined, resolvers),
  };
}
