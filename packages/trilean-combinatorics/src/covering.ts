import type { Strategy, StrategyContext, Value } from "combinatrix";
import { LimitExceededError } from "combinatrix";

/** Options for `coveringArray`. */
export interface CoveringArrayOptions {
  /** The strength t, a positive integer: every t-way combination of values that occurs in the solution set is covered. 1 covers each value, 2 is pairwise, 3 three-wise. A strength above the model's dimension count covers every dimension at once, which is the whole solution set. */
  readonly strength: number;
  /** The largest solution set the strategy reads, a non-negative integer. The construction needs the whole solution set before it can choose a row, so past this many combinations it throws `LimitExceededError` instead. */
  readonly limit: number;
}

/**
 * A combinatrix strategy yielding a covering array of the model's solution set: a subset of the valid combinations such that every t-way combination of dimension values that occurs in at least one valid combination occurs in at least one yielded row. Coverage is defined against the solution set only, so a t-tuple no valid combination contains is not required, and an empty solution set yields nothing.
 *
 * Every dimension of the model is covered, its values being whatever it takes in the solution set:
 * - A free dimension's values, unset included when its domain lists `undefined`.
 * - A derived dimension's values (first-valid and computed) too. A derived value is part of every combination and can decide behaviour as much as a free one, and because coverage is measured on the solution set, a derived value is required only where it really occurs, so including derived dimensions never asks for a combination the model cannot produce.
 * - A dimension collapsed to unset by `activeWhen` is unset in those combinations, and unset counts as a value like any other there. The combination does not record why a dimension is unset, so unset by choice and unset by inactivity are one value, and covering it with the other dimensions' values is covering the dimension's absence alongside them.
 *
 * The construction is greedy and deterministic: it reads the solution set in enumeration order, then repeatedly yields the combination covering the most t-tuples not yet covered, breaking ties by enumeration order, until none is left. Rows are therefore always yielded in the same order for the same model. It yields each row as it is chosen, so a consumer that stops early, or combinatrix's own `limit` on `combinations`, ends the work there. Throws `RangeError` for a strength that is not a positive integer or a limit that is not a non-negative integer, when the strategy is made.
 */
export function coveringArray(options: CoveringArrayOptions): Strategy {
  const { strength, limit } = options;
  if (!Number.isSafeInteger(strength) || strength < 1) {
    throw new RangeError(
      `strength must be a positive integer, not ${String(strength)}`,
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(
      `limit must be a non-negative integer, not ${String(limit)}`,
    );
  }

  return {
    name: `covering array of strength ${String(strength)}`,
    select: (context) => greedyRows(context, strength, limit),
  };
}

/** A combination of the solution set with the keys of every t-tuple it contains. */
interface Candidate {
  readonly row: Readonly<Record<string, Value>>;
  readonly tuples: readonly string[];
}

/** The greedy construction `coveringArray` describes. */
function* greedyRows(
  context: StrategyContext,
  strength: number,
  limit: number,
): Generator<Readonly<Record<string, Value>>> {
  const names = context.dimensions.map((dimension) => dimension.name);
  const subsets = subsetsOf(names, Math.min(strength, names.length));
  // A Set iterates in insertion order, so the candidates stay in enumeration order as chosen ones are removed.
  const unchosen = new Set<Candidate>();
  for (const row of context.completions()) {
    if (unchosen.size === limit) throw new LimitExceededError(limit);

    unchosen.add({
      row,
      tuples: subsets.map((subset) => tupleKey(subset, row)),
    });
  }
  const uncovered = new Set(
    [...unchosen].flatMap((candidate) => candidate.tuples),
  );
  while (uncovered.size > 0) {
    let best: Candidate | undefined;
    let bestGain = 0;
    // Only a strictly larger gain replaces the best, so a tie goes to the earliest candidate in enumeration order.
    for (const candidate of unchosen) {
      const gain = candidate.tuples.filter((tuple) =>
        uncovered.has(tuple),
      ).length;
      if (gain > bestGain) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (best === undefined) {
      throw new Error(
        "unreachable: every uncovered tuple came from a candidate not yet chosen, since a chosen candidate's tuples are all covered",
      );
    }
    for (const tuple of best.tuples) uncovered.delete(tuple);
    unchosen.delete(best);
    yield best.row;
  }
}

/** Every way to choose `size` of the items, each keeping the items' order, listed lexicographically by position. Choosing none gives the one empty subset; choosing more than there are gives none. */
function subsetsOf<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];

  return items.flatMap((item, index) =>
    subsetsOf(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]),
  );
}

/** The canonical text of a row's values on the given dimensions: `[name]` for unset and `[name, value]` for a set value, so `null` never collides with unset and two tuples are equal exactly when their texts are. Equal values have equal JSON, so `0` and `-0` are one value, as combinatrix treats them. */
function tupleKey(
  subset: readonly string[],
  row: Readonly<Record<string, Value>>,
): string {
  return JSON.stringify(
    subset.map((name) => {
      const value = row[name];

      return value === undefined ? [name] : [name, value];
    }),
  );
}
