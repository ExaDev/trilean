import type { ComputedValue } from "./computed-value";
import type { Evaluation, IndeterminateReason } from "./evaluation";
import type { EvaluationBudget } from "./evaluator-budget";
import type { FunctionRegistry } from "./functions";
import type { JsonValue } from "./json-value";
import type { EvaluationContext, Resolvers } from "./resolvers";
import type { PredicateNode } from "./tree";

/** `resolveParticipatingItems`'s own view of `evaluatePredicateInternal` -- the exact signature that function has in evaluator.ts, injected here rather than imported directly so this module has no dependency back on evaluator.ts. Evaluating a `filter` genuinely does need the full recursive predicate evaluator (a filter can itself be arbitrarily nested), but taking it as a parameter rather than an import means this collection-resolution logic and evaluator.ts's mutually-recursive `evaluatePredicateInternal`/`evaluateValueInternal` pair never import each other, so there is no circular-import hazard between the two files. */
export type EvaluatePredicate = (
  node: PredicateNode,
  context: EvaluationContext,
  resolvers: Readonly<Resolvers>,
  accumulator: ComputedValue | undefined,
  functions: Readonly<FunctionRegistry>,
  visitedTreeKeys: ReadonlySet<string>,
  treeReferenceDepth: number,
  budget: Readonly<EvaluationBudget>,
  nestingDepth: number,
) => Promise<Evaluation<boolean>>;

/** A collection candidate paired with its own pre-filter outcome: `"include"`/`"exclude"` when `filter` resolved definitely, or the filter's own indeterminate `Evaluation` when it did not (there is no third, definite-but-neither branch -- see `resolveParticipatingItems` below). */
export interface ResolvedCollectionItem {
  readonly item: unknown;
  readonly filterOutcome: "include" | "exclude" | Evaluation<never>;
}

/**
 * Collection resolution shared by the quantifiers (`some`/`every`) and by `fold` in evaluator.ts: resolves the opaque `collection` reference to its concrete candidate list via `resolvers.resolveCollection`, then evaluates each candidate's optional `filter` (via the injected `evaluatePredicate`, see `EvaluatePredicate`'s own doc comment) with that candidate as its own evaluation context and the accumulator reset to `undefined` -- see the README's "Evaluation context" and "Pre-filtering which items participate" sections. Deliberately stops short of deciding how an indeterminate filter combines with the rest of the surrounding node: `some`/`every` fold a filter-indeterminate item in as its own vote via the surrounding OR/AND absorption, while `fold` has no absorbing value at all and goes indeterminate outright on the same condition -- the two callers need genuinely different combination logic over these same per-item outcomes, so this helper only produces the outcomes and leaves combining them to the caller.
 */
export async function resolveParticipatingItems(
  evaluatePredicate: EvaluatePredicate,
  collection: JsonValue,
  filter: PredicateNode | undefined,
  context: EvaluationContext,
  resolvers: Readonly<Resolvers>,
  functions: Readonly<FunctionRegistry>,
  visitedTreeKeys: ReadonlySet<string>,
  treeReferenceDepth: number,
  budget: Readonly<EvaluationBudget>,
  nestingDepth: number,
): Promise<ResolvedCollectionItem[]> {
  const candidates = await resolvers.resolveCollection(collection, context);
  return Promise.all(
    candidates.map(async (item): Promise<ResolvedCollectionItem> => {
      if (filter === undefined) return { item, filterOutcome: "include" };
      const filterResult = await evaluatePredicate(
        filter,
        item,
        resolvers,
        undefined,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
      if (filterResult.status === "indeterminate") {
        return { item, filterOutcome: filterResult };
      }
      return {
        item,
        filterOutcome: filterResult.value ? "include" : "exclude",
      };
    }),
  );
}

/** The first participating item (in declared collection order) whose `filter` evaluation was itself indeterminate, or `undefined` if every participating item's filter resolved definitely -- a filter-excluded item's own `"exclude"` outcome never counts here. Used only by `fold`, which -- unlike `some`/`every`'s OR/AND absorption -- has no absorbing value at all: any participating item's indeterminate filter makes the whole fold indeterminate outright, with no other item's outcome able to override it. */
export function firstFilterIndeterminate(
  participating: readonly ResolvedCollectionItem[],
): IndeterminateReason | undefined {
  for (const { filterOutcome } of participating) {
    if (filterOutcome === "include" || filterOutcome === "exclude") continue;
    if (filterOutcome.status === "indeterminate") return filterOutcome.reason;
  }
  return undefined;
}
