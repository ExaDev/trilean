import { complexFromPolar } from "./complex";
import type { ComputedValue } from "./computed-value";
import {
  type Evaluation,
  definite,
  firstIndeterminate,
  indeterminate,
} from "./evaluation";
import {
  type EvaluationBudget,
  MAX_TREE_REFERENCE_DEPTH,
} from "./evaluator-budget";
import {
  firstFilterIndeterminate,
  resolveParticipatingItems,
} from "./evaluator-collection";
import {
  applyArithmetic,
  applyNegate,
  checkReferenceUnit,
  combineAnd,
  combineOr,
  compareText,
  compareValues,
  computeMembershipMatch,
  invokeRegisteredFunction,
} from "./evaluator-operations";
import type { FunctionRegistry } from "./functions";
import type { EvaluationContext, Resolvers } from "./resolvers";
import {
  type ComparisonOperator,
  type ExpressionNode,
  type PredicateNode,
  ExpressionNodeSchema,
  PredicateNodeSchema,
} from "./tree";

/**
 * `evaluatePredicateInternal` and `evaluateValueInternal` below are co-located in this one file, rather than split across `predicate-evaluator.ts`/`value-evaluator.ts`, because they are mutually recursive: a predicate leaf (`compare`, `textCompare`, `memberOf`, `exists`) holds `ExpressionNode` operands, and an expression node (`conditional`'s `when`, a fold's `filter`) holds `PredicateNode` operands. Splitting them across modules would make each half import the other, and whichever module finished loading second would see the other's export as `undefined` at its own module-evaluation time -- a genuine circular-import TDZ hazard, not merely a style preference. `resolveParticipatingItems` (in `evaluator-collection.ts`) would share that same hazard if it imported `evaluatePredicateInternal` directly, since it calls back into it to evaluate each candidate's filter -- so it instead takes the evaluator as an injected `EvaluatePredicate` parameter (see that type's own doc comment), which is what lets it live in its own file with no circular dependency on this one. The pure, non-recursive value-combination logic (`combineAnd`/`compareValues`/`applyArithmetic` and their siblings) carries no such constraint either and lives in `evaluator-operations.ts`; the resource-limit infrastructure (`EvaluationBudget` and its constants), likewise self-contained, lives in `evaluator-budget.ts`.
 */

export async function evaluatePredicateInternal(
  node: PredicateNode,
  context: EvaluationContext,
  resolvers: Readonly<Resolvers>,
  accumulator: ComputedValue | undefined,
  functions: Readonly<FunctionRegistry>,
  visitedTreeKeys: ReadonlySet<string>,
  treeReferenceDepth: number,
  budget: Readonly<EvaluationBudget>,
  nestingDepth: number,
): Promise<Evaluation<boolean>> {
  const budgetExceeded = budget.checkNode(nestingDepth);
  if (budgetExceeded !== undefined) return budgetExceeded;
  switch (node.kind) {
    case "not": {
      const operand = await evaluatePredicateInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
      if (operand.status === "indeterminate") return operand;
      return definite(!operand.value);
    }
    case "and": {
      const [left, right] = await Promise.all([
        evaluatePredicateInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
        evaluatePredicateInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
      ]);
      return combineAnd(left, right);
    }
    case "or": {
      const [left, right] = await Promise.all([
        evaluatePredicateInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
        evaluatePredicateInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
      ]);
      return combineOr(left, right);
    }
    case "allOf": {
      const operandResults = await Promise.all(
        node.operands.map(async (operand) =>
          evaluatePredicateInternal(
            operand,
            context,
            resolvers,
            accumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          ),
        ),
      );
      return operandResults.reduce<Evaluation<boolean>>(
        combineAnd,
        definite(true),
      );
    }
    case "anyOf": {
      const operandResults = await Promise.all(
        node.operands.map(async (operand) =>
          evaluatePredicateInternal(
            operand,
            context,
            resolvers,
            accumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          ),
        ),
      );
      return operandResults.reduce<Evaluation<boolean>>(
        combineOr,
        definite(false),
      );
    }
    case "compare": {
      const [left, right] = await Promise.all([
        evaluateValueInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
        evaluateValueInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
      ]);
      if (left.status === "indeterminate") return left;
      if (right.status === "indeterminate") return right;
      return compareValues(node.op, left.value, right.value);
    }
    case "textCompare": {
      const [left, right] = await Promise.all([
        evaluateValueInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
        evaluateValueInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
      ]);
      if (left.status === "indeterminate") return left;
      if (right.status === "indeterminate") return right;
      return compareText(node.op, left.value, right.value);
    }
    case "memberOf": {
      const operandResult = await evaluateValueInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
      if (operandResult.status === "indeterminate") return operandResult;

      // Every candidate is evaluated concurrently; the scan below then walks the resolved outcomes in declared order, so a definite match short-circuits the *result* without ever needing to short-circuit the resolver calls themselves.
      const candidateOutcomes = await Promise.all(
        node.candidates.map(async (candidate): Promise<Evaluation<boolean>> => {
          const candidateResult = await evaluateValueInternal(
            candidate,
            context,
            resolvers,
            accumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          );
          if (candidateResult.status === "indeterminate") {
            return candidateResult;
          }
          return computeMembershipMatch(
            operandResult.value,
            candidateResult.value,
          );
        }),
      );

      for (const outcome of candidateOutcomes) {
        if (outcome.status === "definite" && outcome.value) {
          return definite(node.op === "in");
        }
      }
      // No definite match: indeterminate (first candidate's reason, per the tie-break rule) if any candidate was itself indeterminate or of an incompatible kind/unit; otherwise every candidate was a definite non-match. An empty `candidates` array falls straight through to this same definite non-match result, with no separate empty-list branch needed.
      const reason = firstIndeterminate(...candidateOutcomes);
      if (reason !== undefined) return { status: "indeterminate", reason };
      return definite(node.op === "notIn");
    }
    case "exists": {
      const operandResult = await evaluateValueInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
      // The data point resolved to *something* unless it was flatly not-found; a resolved-but-unusable value (wrong-type/domain-error) still counts as existing. `exists` is never itself indeterminate.
      if (
        operandResult.status === "indeterminate" &&
        operandResult.reason.code === "not-found"
      ) {
        return definite(false);
      }
      return definite(true);
    }
    case "some":
    case "every": {
      const participating = await resolveParticipatingItems(
        evaluatePredicateInternal,
        node.collection,
        node.filter,
        context,
        resolvers,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
      // A filter-excluded item contributes no vote at all (as if never in the collection); a filter-indeterminate item contributes its own indeterminate vote, letting a different item's clean match still absorb it -- contrast with `fold`, which has no absorbing value and goes indeterminate outright on the same condition.
      const votes = (
        await Promise.all(
          participating.map(
            async ({
              item,
              filterOutcome,
            }): Promise<Evaluation<boolean> | undefined> => {
              if (filterOutcome === "exclude") return undefined;
              if (filterOutcome !== "include") return filterOutcome;
              return evaluatePredicateInternal(
                node.item,
                item,
                resolvers,
                undefined,
                functions,
                visitedTreeKeys,
                treeReferenceDepth,
                budget,
                nestingDepth + 1,
              );
            },
          ),
        )
      ).filter((vote): vote is Evaluation<boolean> => vote !== undefined);
      // `some` is an OR fold seeded at `false`; `every` an AND fold seeded at `true` -- exactly `anyOf`/`allOf`'s own pairwise fold, so an empty `votes` list (an empty collection, or every candidate filtered out) already reduces to `anyOf([])`/`allOf([])`'s own identity values with no separate empty-collection branch.
      const combine = node.kind === "some" ? combineOr : combineAnd;
      const identity = node.kind === "some" ? definite(false) : definite(true);
      return votes.reduce<Evaluation<boolean>>(combine, identity);
    }
    case "treeReference": {
      if (resolvers.resolveTree === undefined) {
        return indeterminate(
          "wrong-type",
          "no tree resolver registered for treeReference nodes",
        );
      }
      const keyString = JSON.stringify(node.key);
      if (visitedTreeKeys.has(keyString)) {
        return indeterminate("domain-error", "circular treeReference detected");
      }
      if (treeReferenceDepth >= MAX_TREE_REFERENCE_DEPTH) {
        return indeterminate(
          "domain-error",
          `treeReference chain exceeds the maximum depth of ${MAX_TREE_REFERENCE_DEPTH.toString()}`,
        );
      }
      const resolution = await resolvers.resolveTree(node.key, context);
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          "treeReference key did not resolve to a tree",
        );
      }
      const parsed = PredicateNodeSchema.safeParse(resolution.node);
      if (!parsed.success) {
        return indeterminate(
          "wrong-type",
          "the referenced tree is not a valid PredicateNode",
        );
      }
      return evaluatePredicateInternal(
        parsed.data,
        context,
        resolvers,
        accumulator,
        functions,
        new Set([...visitedTreeKeys, keyString]),
        treeReferenceDepth + 1,
        budget,
        nestingDepth + 1,
      );
    }
    default:
      throw new Error("unreachable predicate node kind");
  }
}

export async function evaluateValueInternal(
  node: ExpressionNode,
  context: EvaluationContext,
  resolvers: Readonly<Resolvers>,
  accumulator: ComputedValue | undefined,
  functions: Readonly<FunctionRegistry>,
  visitedTreeKeys: ReadonlySet<string>,
  treeReferenceDepth: number,
  budget: Readonly<EvaluationBudget>,
  nestingDepth: number,
): Promise<Evaluation<ComputedValue>> {
  const budgetExceeded = budget.checkNode(nestingDepth);
  if (budgetExceeded !== undefined) return budgetExceeded;
  switch (node.kind) {
    case "reference": {
      const resolution = await resolvers.resolveValue(node.key, context);
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          `no value found for reference key ${JSON.stringify(node.key)}`,
        );
      }
      const unitError = checkReferenceUnit(node.unit, resolution.value);
      if (unitError !== undefined) return unitError;
      return definite(resolution.value);
    }
    case "accumulator": {
      if (accumulator === undefined) {
        return indeterminate(
          "wrong-type",
          "accumulator used outside a reduce fold's combine expression",
        );
      }
      return definite(accumulator);
    }
    case "call": {
      const argResults = await Promise.all(
        node.args.map(async (arg) =>
          evaluateValueInternal(
            arg,
            context,
            resolvers,
            accumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          ),
        ),
      );
      const args: ComputedValue[] = [];
      for (const result of argResults) {
        if (result.status === "indeterminate") return result;
        args.push(result.value);
      }
      return invokeRegisteredFunction(functions, node.fn, args);
    }
    case "numberLiteral":
      return definite({ kind: "number", value: node.value, unit: node.unit });
    case "textLiteral":
      return definite({ kind: "text", value: node.value });
    case "booleanLiteral":
      return definite({ kind: "boolean", value: node.value });
    case "instantLiteral":
      return definite({ kind: "instant", value: node.value });
    case "durationLiteral":
      return definite({
        kind: "duration",
        value: node.value,
        unit: node.unit,
      });
    case "complexLiteral":
      // Whichever authoring form was used (see the "Complex values" section of README.md), normalise to the single rectangular `ComputedValue` immediately -- nothing downstream (arithmetic, compare, memberOf, negate) ever sees a polar-authored value.
      if ("re" in node) {
        return definite({
          kind: "complex",
          re: node.re,
          im: node.im,
          unit: node.unit,
        });
      }
      return definite(complexFromPolar(node.magnitude, node.phase, node.unit));
    case "arithmetic": {
      const [left, right] = await Promise.all([
        evaluateValueInternal(
          node.left,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
        evaluateValueInternal(
          node.right,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        ),
      ]);
      // Unlike `and`/`or` (see `combineAnd`/`combineOr` above), arithmetic has no absorbing value: any indeterminate operand always makes the whole node indeterminate, regardless of what the other operand would have been, tie-broken left before right per the tie-break rule.
      if (left.status === "indeterminate") return left;
      if (right.status === "indeterminate") return right;
      return applyArithmetic(node.op, left.value, right.value);
    }
    case "negate": {
      const operand = await evaluateValueInternal(
        node.operand,
        context,
        resolvers,
        accumulator,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
      if (operand.status === "indeterminate") return operand;
      return applyNegate(operand.value);
    }
    case "lookup": {
      // All keys are evaluated concurrently; any indeterminate key makes the whole lookup indeterminate immediately, with no `resolveLookup` call attempted at all -- see the `lookup` section of README.md.
      const keyResults = await Promise.all(
        node.keys.map(async (key) =>
          evaluateValueInternal(
            key,
            context,
            resolvers,
            accumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          ),
        ),
      );
      const keyValues: ComputedValue[] = [];
      for (const result of keyResults) {
        if (result.status === "indeterminate") return result;
        keyValues.push(result.value);
      }
      const resolution = await resolvers.resolveLookup(
        node.table,
        keyValues,
        context,
      );
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          `no match found in lookup table ${JSON.stringify(node.table)}`,
        );
      }
      return definite(resolution.value);
    }
    case "conditional": {
      const hitPolicy = node.hitPolicy ?? "first";
      if (hitPolicy === "first") {
        // Strictly sequential, not concurrent: a for...of loop with early return on the first definite match, or the first indeterminate guard, is required behaviour -- evaluation must never skip past an unresolved guard to try a later case that might only look correct because an earlier one couldn't actually be checked (see the `conditional` section of README.md).
        for (const { when, then } of node.cases) {
          const whenResult = await evaluatePredicateInternal(
            when,
            context,
            resolvers,
            accumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          );
          if (whenResult.status === "indeterminate") return whenResult;
          if (whenResult.value) {
            return evaluateValueInternal(
              then,
              context,
              resolvers,
              accumulator,
              functions,
              visitedTreeKeys,
              treeReferenceDepth,
              budget,
              nestingDepth + 1,
            );
          }
        }
        return evaluateValueInternal(
          node.fallback,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        );
      }

      // "unique": every case's `when` is evaluated concurrently -- the same concurrency allOf/anyOf/memberOf's own candidates already use, since resolvers are pure functions of their inputs throughout this design. Absorption is then applied in a strict, non-commutative order: two-or-more confirmed matches is itself an absorbing outcome (mirroring memberOf/some/every's "a confirmed outcome cannot be undone by an unrelated element's data problem"), checked BEFORE any indeterminate case is allowed to poison the result -- but, unlike memberOf/some/every, a single confirmed match does NOT by itself absorb a remaining indeterminate case: that unresolved case might yet turn out to be a second match, which "unique" cannot rule out without knowing its real value, so exactly-one-match is only safe to return once every other case is also known, definitely, not to match.
      const evaluatedCases = await Promise.all(
        node.cases.map(async ({ when, then }) => ({
          then,
          whenResult: await evaluatePredicateInternal(
            when,
            context,
            resolvers,
            accumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          ),
        })),
      );
      const matches = evaluatedCases.filter(
        ({ whenResult }) =>
          whenResult.status === "definite" && whenResult.value,
      );
      if (matches.length >= 2) {
        return indeterminate(
          "domain-error",
          "more than one case matched under the 'unique' hit policy",
        );
      }
      const reason = firstIndeterminate(
        ...evaluatedCases.map(({ whenResult }) => whenResult),
      );
      if (reason !== undefined) return { status: "indeterminate", reason };
      const [match] = matches;
      if (match === undefined) {
        return evaluateValueInternal(
          node.fallback,
          context,
          resolvers,
          accumulator,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        );
      }
      return evaluateValueInternal(
        match.then,
        context,
        resolvers,
        accumulator,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
    }
    case "fold": {
      const participating = await resolveParticipatingItems(
        evaluatePredicateInternal,
        node.collection,
        node.filter,
        context,
        resolvers,
        functions,
        visitedTreeKeys,
        treeReferenceDepth,
        budget,
        nestingDepth + 1,
      );
      const filterIndeterminateReason = firstFilterIndeterminate(participating);
      if (filterIndeterminateReason !== undefined) {
        return { status: "indeterminate", reason: filterIndeterminateReason };
      }
      const includedItems = participating
        .filter(({ filterOutcome }) => filterOutcome === "include")
        .map(({ item }) => item);

      if (node.combiner.mode === "reduce") {
        // Unlike some/every's OR/AND absorption, `reduce` has no absorbing value at all: `initial` and every participating item's `combine` step must each resolve definitely, or the whole fold is indeterminate -- see the `fold` section of README.md. `initial` is evaluated with the accumulator reset to undefined (the same treatment as a filter/item sub-node below), then threaded as the real running accumulator into each `combine` step in turn.
        const initialResult = await evaluateValueInternal(
          node.combiner.initial,
          context,
          resolvers,
          undefined,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        );
        if (initialResult.status === "indeterminate") return initialResult;
        let runningAccumulator = initialResult.value;
        for (const item of includedItems) {
          const stepResult = await evaluateValueInternal(
            node.combiner.combine,
            item,
            resolvers,
            runningAccumulator,
            functions,
            visitedTreeKeys,
            treeReferenceDepth,
            budget,
            nestingDepth + 1,
          );
          if (stepResult.status === "indeterminate") return stepResult;
          runningAccumulator = stepResult.value;
        }
        return definite(runningAccumulator);
      }

      // max/min: the "unseeded" variant of reduce -- there is no largest/smallest real number to seed a running extremum with, so the first participating item's own projected value seeds the running result directly, and every later item's is compared against it via `compareValues` (reusing `compare`'s own ordering semantics rather than reinventing them). An empty (post-filter) collection is domain-error, the same category as division by zero, since there is no first item to seed from -- unlike `reduce`, which always has a real seed (`initial`) and needs no such case.
      if (includedItems.length === 0) {
        return indeterminate(
          "domain-error",
          `'${node.combiner.mode}' has no participating items to seed a running result from`,
        );
      }
      const dominatesOp: ComparisonOperator =
        node.combiner.mode === "max" ? "gt" : "lt";
      let runningExtremum: ComputedValue | undefined;
      for (const item of includedItems) {
        const itemResult = await evaluateValueInternal(
          node.combiner.item,
          item,
          resolvers,
          undefined,
          functions,
          visitedTreeKeys,
          treeReferenceDepth,
          budget,
          nestingDepth + 1,
        );
        if (itemResult.status === "indeterminate") return itemResult;
        if (runningExtremum === undefined) {
          runningExtremum = itemResult.value;
          continue;
        }
        const comparison = compareValues(
          dominatesOp,
          itemResult.value,
          runningExtremum,
        );
        if (comparison.status === "indeterminate") return comparison;
        if (comparison.value) runningExtremum = itemResult.value;
      }
      if (runningExtremum === undefined) {
        throw new Error(
          "unreachable: max/min over a non-empty participating list produced no running result",
        );
      }
      return definite(runningExtremum);
    }
    case "delegate": {
      if (resolvers.resolveDelegate === undefined) {
        return indeterminate(
          "wrong-type",
          `no delegate handler registered for external system '${node.system}'`,
        );
      }
      const resolution = await resolvers.resolveDelegate(
        node.system,
        node.payload,
        context,
      );
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          `delegate handler for external system '${node.system}' reported no value`,
        );
      }
      return definite(resolution.value);
    }
    case "treeReference": {
      if (resolvers.resolveTree === undefined) {
        return indeterminate(
          "wrong-type",
          "no tree resolver registered for treeReference nodes",
        );
      }
      const keyString = JSON.stringify(node.key);
      if (visitedTreeKeys.has(keyString)) {
        return indeterminate("domain-error", "circular treeReference detected");
      }
      if (treeReferenceDepth >= MAX_TREE_REFERENCE_DEPTH) {
        return indeterminate(
          "domain-error",
          `treeReference chain exceeds the maximum depth of ${MAX_TREE_REFERENCE_DEPTH.toString()}`,
        );
      }
      const resolution = await resolvers.resolveTree(node.key, context);
      if (!resolution.found) {
        return indeterminate(
          "not-found",
          "treeReference key did not resolve to a tree",
        );
      }
      const parsed = ExpressionNodeSchema.safeParse(resolution.node);
      if (!parsed.success) {
        return indeterminate(
          "wrong-type",
          "the referenced tree is not a valid ExpressionNode",
        );
      }
      return evaluateValueInternal(
        parsed.data,
        context,
        resolvers,
        accumulator,
        functions,
        new Set([...visitedTreeKeys, keyString]),
        treeReferenceDepth + 1,
        budget,
        nestingDepth + 1,
      );
    }
    default:
      throw new Error("unreachable expression node kind");
  }
}

// `createEvaluator` (and the bare module-level `evaluatePredicate`/`evaluateValue` it produces for a default, empty function registry) lives in `evaluator-factory.ts`, a thin caller-facing wrapper over `evaluatePredicateInternal`/`evaluateValueInternal` above -- it only ever calls into this module, never the reverse, so keeping it separate carries none of this file's own circular-import constraint.
