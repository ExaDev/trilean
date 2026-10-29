import type { Strategy, StrategyContext, Value } from "combinatrix";
import { LimitExceededError } from "combinatrix";
import { subsetsOf, tupleKey } from "../internal/tuples";

/**
 * The reference covering-array construction `coveringArray` is compared with in tests: greedy over the whole solution set, so its size is a yardstick and its memory is the solution set. It reads every valid combination in enumeration order, then repeatedly yields the combination covering the most t-tuples not yet covered, ties going to the earliest, until none is left. Past `limit` combinations it throws `LimitExceededError`. Coverage and the strength reading are those of `coveringArray`.
 */
export function greedyCoveringArray(options: {
  readonly strength: number;
  readonly limit: number;
}): Strategy {
  const { strength, limit } = options;

  return {
    name: `greedy covering array of strength ${String(strength)}`,
    select: (context) => greedyRows(context, strength, limit),
  };
}

/** A combination of the solution set with the keys of every t-tuple it contains. */
interface Candidate {
  readonly row: Readonly<Record<string, Value>>;
  readonly tuples: readonly string[];
}

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
      tuples: subsets.map((subset) =>
        tupleKey(subset.map((name) => [name, row[name]])),
      ),
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
