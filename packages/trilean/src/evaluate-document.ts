import type { ComputedValue } from "./computed-value";
import { ComputedValueSchema } from "./computed-value";
import type { Evaluation } from "./evaluation";
import { createSyncEvaluator } from "./evaluator-factory";
import { builtinFunctions } from "./builtin-functions";
import { createInputResolvers, parseInputs } from "./input-resolvers";
import { isPlainRecord } from "./plain-record";
import type { ExpressionNode, PredicateNode } from "./tree";
import { ExpressionNodeSchema, PredicateNodeSchema } from "./tree";
import type { z } from "zod";

export type TreeKind = "predicate" | "expression";

export interface EvaluateDocumentOptions {
  /** The tree as parsed from JSON, not yet validated. */
  tree: unknown;
  /** Named values and lists of items as parsed from JSON (see `parseInputs`); absent means none. */
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
  | {
      outcome: "rejected";
      /** `ambiguous-tree-kind` is a root `treeReference` evaluated without `as`; every other rejection is `invalid`, a tree or an input that fails validation. */
      reason: "invalid" | "ambiguous-tree-kind";
      issues: readonly string[];
    }
  | { outcome: "unrepresentable"; issues: readonly string[] };

const predicateKinds: ReadonlySet<string> = new Set(
  PredicateNodeSchema.options.map((option) => option.shape.kind.value),
);

/** What a definite expression result that `ComputedValueSchema` refuses is reported as: the only way a result fails it is a non-finite number, which JSON would write as `null`. The evaluator's arithmetic and the built-in functions already keep one from forming, so this is the last check before a value leaves the document boundary, and it fails loudly rather than print a different value from the one computed. */
const NOT_REPRESENTABLE = "(result): the value is not a finite number";

const AMBIGUOUS_TREE_KIND =
  '(root): a treeReference is valid as a predicate and as an expression; set `as` to "predicate" or "expression"';

const evaluator = createSyncEvaluator({ functions: builtinFunctions });

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
): TreeKind | "ambiguous" {
  if (requested !== undefined) return requested;
  const kind = isPlainRecord(tree) ? tree.kind : undefined;
  if (kind === "treeReference") return "ambiguous";

  return typeof kind === "string" && predicateKinds.has(kind)
    ? "predicate"
    : "expression";
}

/**
 * Validates a tree and its named inputs and evaluates it with the built-in function registry (`builtinFunctions`), the evaluation the `trilean evaluate` command performs. The tree kind is read from the root node's `kind` unless `as` names it. There are three outcomes:
 *
 * - `evaluated`: an `Evaluation`, definite or indeterminate.
 * - `rejected`: nothing was evaluated, because a tree or an input failed validation (`invalid`) or a root `treeReference` was given without `as` (`ambiguous-tree-kind`). `issues` has one `path: message` line per problem.
 * - `unrepresentable`: the tree was evaluated and the result is a number JSON cannot carry (`Infinity` or `NaN`), which would otherwise be printed as `null`. The built-in registry never produces one, and the evaluator's arithmetic turns an overflow into a `domain-error`, so this is a guard on the document boundary against a change that stops doing so.
 *
 * Resolution is limited to what `createInputResolvers` provides: named values, and lists of items for a `fold`, `some` or `every`. A tree that names a collection the inputs do not hold throws that resolver's error, which propagates.
 */
export function evaluateDocument({
  tree,
  inputs,
  as,
}: EvaluateDocumentOptions): DocumentEvaluation {
  const parsedInputs = parseInputs(inputs ?? {});
  if (!parsedInputs.ok) {
    return {
      outcome: "rejected",
      reason: "invalid",
      issues: parsedInputs.issues,
    };
  }
  const resolvers = createInputResolvers(
    parsedInputs.inputs,
    parsedInputs.collections,
  );
  const treeKind = resolveTreeKind(tree, as);
  if (treeKind === "ambiguous") {
    return {
      outcome: "rejected",
      reason: "ambiguous-tree-kind",
      issues: [AMBIGUOUS_TREE_KIND],
    };
  }
  if (treeKind === "predicate") {
    const parsed = PredicateNodeSchema.safeParse(tree);
    if (!parsed.success) {
      return {
        outcome: "rejected",
        reason: "invalid",
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
    return {
      outcome: "rejected",
      reason: "invalid",
      issues: describeIssues(parsed.error.issues),
    };
  }
  const node: ExpressionNode = parsed.data;
  const evaluation = evaluator.evaluateValue(node, undefined, resolvers);
  if (
    evaluation.status === "definite" &&
    !ComputedValueSchema.safeParse(evaluation.value).success
  ) {
    return { outcome: "unrepresentable", issues: [NOT_REPRESENTABLE] };
  }

  return { outcome: "evaluated", treeKind, evaluation };
}
