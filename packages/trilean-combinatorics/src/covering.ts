import type {
  Dimension,
  PartialAssignment,
  Strategy,
  StrategyContext,
  Value,
} from "combinatrix";
import { LimitExceededError } from "combinatrix";
import { productOf, subsetsOf, tupleKey } from "./internal/tuples";

/** Options for `coveringArray`. */
export interface CoveringArrayOptions {
  /** The strength t, a positive integer: every t-way combination of values that occurs in the solution set is covered. 1 covers each value, 2 is pairwise, 3 three-wise. A strength above the model's dimension count covers every dimension at once, which is the whole solution set. */
  readonly strength: number;
  /** The most rows the construction may hold, a non-negative integer. Every row is held until the last dimension has been placed, so this bounds the construction's memory in rows; past it the strategy throws combinatrix's `LimitExceededError` instead of building a larger array. Without it the array is as large as the construction makes it, which is at most the number of coverable t-tuples. */
  readonly limit?: number;
}

/**
 * A combinatrix strategy yielding a covering array of the model's solution set: valid combinations such that every t-way combination of dimension values that occurs in at least one valid combination occurs in at least one yielded row. Coverage is defined against the solution set only, so a t-tuple no valid combination contains is not required, and an empty solution set yields nothing.
 *
 * Every dimension of the model is covered, its values being whatever it takes in the solution set:
 * - A free dimension's values, unset included when its domain lists `undefined`.
 * - A derived dimension's values (first-valid and computed) too. A derived value is part of every combination and can decide behaviour as much as a free one, and because coverage is measured on the solution set, a derived value is required only where it really occurs, so including derived dimensions never asks for a combination the model cannot produce.
 * - A dimension collapsed to unset by `activeWhen` is unset in those combinations, and unset counts as a value like any other there. The combination does not record why a dimension is unset, so unset by choice and unset by inactivity are one value, and covering it with the other dimensions' values is covering the dimension's absence alongside them.
 *
 * The construction is in-parameter-order, IPOG with its constraint handling done by the engine: Lei, Kacker, Kuhn, Okun and Lawrence, "IPOG: A General Strategy for T-Way Software Testing", ECBS 2007 (https://csrc.nist.gov/pubs/conference/2007/03/29/ipog-a-general-strategy-for-tway-software-testing/final), with constraints as in Yu, Lei, Nourozborazjany, Kacker and Kuhn, "An Efficient Algorithm for Constraint Handling in Combinatorial Test Generation", ICST 2013 (https://www.nist.gov/node/572651). Rows are partial assignments over the dimensions in declaration order. The first t dimensions start one row per coverable t-tuple of theirs. Each later dimension is then placed in two phases: horizontal growth gives every row the value covering the most of that dimension's uncovered t-tuples, and vertical growth puts each tuple still uncovered into the first row it fits, or into a new row whose other dimensions are left open. Each row is then completed to a valid combination by the engine, and last, visiting the rows from the last, a row whose every t-tuple some other row still kept also holds is dropped, which removes repeats and rows later placements made redundant without uncovering anything.
 *
 * It never reads the solution set. Which t-tuples are coverable, and whether a row may take a value, are both asked of the engine as "is there a valid combination agreeing with this partial assignment", the first combination `completions` yields for it, so the constraints' verdicts on partial assignments prune the search exactly as they do for enumeration, and the strategy stops at the first combination found. Every row is kept able to complete, so every yielded row is valid. Its memory is therefore the rows, the current dimension's tuples and, at the end, one count per distinct t-tuple of the rows: at most one row per coverable t-tuple, since every row is started for a tuple no earlier row holds, each over the model's dimensions, and at most the coverable t-tuples themselves. That is polynomial in the dimension count for a fixed strength and independent of the size of the solution set. The engine queries are polynomial in the t-tuple count too, each closing its search at the first combination: one per candidate tuple, at most one per row and value in horizontal growth and one more for a row none of them fits, at most one per row for each tuple vertical growth places, and one per row to complete it, besides a computed dimension's. A computed dimension's possible values are found from the values of the dimensions it reads, by one engine query per choice of those values, so they are its value set and never a list of combinations.
 *
 * The output is deterministic: the same model gives the same rows in the same order, ties going to the earlier value and the earlier row. The strategy is lazy in that nothing is computed until the first row is asked for, but the whole array is built before the first row is yielded, since a later dimension may still change any row and the redundancy pass needs every row. The array is not always smaller than the greedy construction over the whole solution set, which is not size-optimal either: on some models it is larger, on others smaller. Throws `RangeError` for a strength that is not a positive integer or a limit that is not a non-negative integer, when the strategy is made.
 */
export function coveringArray(options: CoveringArrayOptions): Strategy {
  const { strength, limit } = options;
  if (!Number.isSafeInteger(strength) || strength < 1) {
    throw new RangeError(
      `strength must be a positive integer, not ${String(strength)}`,
    );
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new RangeError(
      `limit must be a non-negative integer, not ${String(limit)}`,
    );
  }

  return {
    name: `covering array of strength ${String(strength)}`,
    select: (context) => inParameterOrderRows(context, strength, limit),
  };
}

/** A row under construction: the dimensions placed in it so far, an absent dimension being open and one present with `undefined` being unset. */
type Row = Map<string, Value>;

/** The construction `coveringArray` describes. */
function* inParameterOrderRows(
  context: StrategyContext,
  strength: number,
  limit: number | undefined,
): Generator<Readonly<Record<string, Value>>> {
  const { dimensions } = context;
  const width = Math.min(strength, dimensions.length);
  const names = dimensions.map((dimension) => dimension.name);
  const values: (readonly Value[])[] = [];
  const rows: Row[] = [];
  const addRow = (row: Row): void => {
    if (rows.length === limit) throw new LimitExceededError(limit);

    rows.push(row);
  };

  for (let index = 0; index < width; index += 1) {
    values.push(possibleValues(context, index, values));
  }
  const firstNames = names.slice(0, width);
  for (const choice of productOf(values)) {
    const row: Row = new Map(
      firstNames.map((name, index) => [name, choice[index]]),
    );
    if (completes(context, row)) addRow(row);
  }

  for (let index = width; index < dimensions.length; index += 1) {
    values.push(possibleValues(context, index, values));
    const placement: Placement = { context, names, values, index, width };
    const uncovered = coverableTuples(placement);
    growHorizontally(placement, rows, uncovered);
    growVertically(context, rows, uncovered, addRow);
  }

  yield* withoutRedundantRows(
    rows.map((row) => {
      const completed = firstCompletion(context, row);
      if (completed === undefined) {
        throw new Error(
          "unreachable: a row is only ever given values the engine found a valid combination for",
        );
      }

      return completed;
    }),
    subsetsOf(names, width),
  );
}

/** The complete rows less every row whose t-tuples all occur in rows kept, visiting the rows from the last, so a row that repeats an earlier one, or that later rows made redundant, is dropped and the rest keep their order. Coverage is unchanged, since a row goes only when every tuple it holds is held by another row still kept. Holds one count per distinct t-tuple of the rows. */
function* withoutRedundantRows(
  rows: readonly Readonly<Record<string, Value>>[],
  subsets: readonly (readonly string[])[],
): Generator<Readonly<Record<string, Value>>> {
  const tuplesOf = (row: Readonly<Record<string, Value>>): string[] =>
    subsets.map((subset) => tupleKey(subset.map((name) => [name, row[name]])));
  const holders = new Map<string, number>();
  for (const row of rows) {
    for (const tuple of tuplesOf(row)) {
      holders.set(tuple, (holders.get(tuple) ?? 0) + 1);
    }
  }
  const kept = rows.map(() => true);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const tuples = tuplesOf(rowAt(rows, index));
    if (tuples.some((tuple) => holders.get(tuple) === 1)) continue;

    kept[index] = false;
    for (const tuple of tuples) {
      holders.set(tuple, (holders.get(tuple) ?? 0) - 1);
    }
  }
  for (const [index, row] of rows.entries()) {
    if (kept[index] === true) yield row;
  }
}

function rowAt<T>(rows: readonly T[], index: number): T {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(
      `unreachable: position ${String(index)} is within the ${String(rows.length)} rows`,
    );
  }

  return row;
}

/**
 * Every value the dimension at `index` can take in the solution set, possibly with some it cannot, in a fixed order: a free dimension's domain, a first-valid dimension's candidates, or a computed dimension's results on every choice of the values of the dimensions it reads that some valid combination agrees with; unset is added when `activeWhen` can collapse the dimension. Values the solution set never has are harmless, since a tuple holding one is never coverable. `known` holds the possible values of every dimension before `index`.
 */
function possibleValues(
  context: StrategyContext,
  index: number,
  known: readonly (readonly Value[])[],
): Value[] {
  const dimension = dimensionAt(context.dimensions, index);
  const found = new Map<string, Value>();
  const add = (value: Value): void => {
    found.set(tupleKey([[dimension.name, value]]), value);
  };
  if (dimension.kind === "choice") dimension.values.forEach(add);
  if (dimension.kind === "first-valid") dimension.candidates.forEach(add);
  if (dimension.kind === "computed") {
    const readLists = dimension.reads.map((read) => {
      const list =
        known[context.dimensions.findIndex(({ name }) => name === read)];
      if (list === undefined) {
        throw new Error(
          `unreachable: computed dimension "${dimension.name}" reads "${read}", which combinatrix requires to be declared before it`,
        );
      }

      return list;
    });
    for (const choice of productOf(readLists)) {
      const reads = new Map(
        dimension.reads.map((read, position) => [read, choice[position]]),
      );
      // Only a choice of the read values some valid combination has is computed, so `compute` is called only on inputs the model can produce.
      if (completes(context, reads)) {
        add(dimension.compute(Object.fromEntries(reads)));
      }
    }
  }
  if (dimension.activeWhen !== undefined) add(undefined);

  return [...found.values()];
}

/** What placing one dimension after the first t reads: the engine, every dimension's name, the possible values of this dimension and every one before it, this dimension's position, and the tuple width t. */
interface Placement {
  readonly context: StrategyContext;
  readonly names: readonly string[];
  readonly values: readonly (readonly Value[])[];
  readonly index: number;
  readonly width: number;
}

/** Every t-tuple holding the dimension at `index` and `width - 1` dimensions before it that some valid combination contains, keyed by `tupleKey` in dimension order, in the order of the earlier dimensions' subsets and then of their values. */
function coverableTuples(placement: Placement): Map<string, Row> {
  const { context, names, values, index, width } = placement;
  const coverable = new Map<string, Row>();
  const earlier = Array.from({ length: index }, (_, position) => position);
  for (const subset of subsetsOf(earlier, width - 1)) {
    const positions = [...subset, index];
    const lists = positions.map((position) => valuesAt(values, position));
    for (const choice of productOf(lists)) {
      const pairs = positions.map((position, place): [string, Value] => [
        nameAt(names, position),
        choice[place],
      ]);
      const tuple: Row = new Map(pairs);
      if (completes(context, tuple)) coverable.set(tupleKey(pairs), tuple);
    }
  }

  return coverable;
}

/** Gives every row a value for the dimension at `index`: of the values that leave the row able to complete, the one covering the most uncovered tuples, the earlier value on a tie. Removes the tuples it covers from `uncovered`. Every row can complete before, so some value always can after. */
function growHorizontally(
  placement: Placement,
  rows: readonly Row[],
  uncovered: Map<string, Row>,
): void {
  const { context, names, index, width } = placement;
  const name = nameAt(names, index);
  // The values the uncovered tuples hold for this dimension, once each, in the tuples' order.
  const distinct = new Map<string, Value>();
  for (const tuple of uncovered.values()) {
    const value = tuple.get(name);
    const key = tupleKey([[name, value]]);
    if (!distinct.has(key)) distinct.set(key, value);
  }
  const values = [...distinct.values()];
  for (const row of rows) {
    const placed = names
      .slice(0, index)
      .filter((earlierName) => row.has(earlierName));
    const subsets = subsetsOf(placed, width - 1);
    let best: { value: Value; covered: string[] } | undefined;
    for (const value of candidatesFor(context, row, name, values)) {
      const covered = subsets
        .map((subset) =>
          tupleKey([
            ...subset.map((earlierName): [string, Value] => [
              earlierName,
              row.get(earlierName),
            ]),
            [name, value],
          ]),
        )
        .filter((key) => uncovered.has(key));
      // Only a strictly larger gain replaces the best, so a tie goes to the earlier value.
      if (best === undefined || covered.length > best.covered.length) {
        best = { value, covered };
      }
    }
    if (best === undefined) {
      throw new Error(
        `unreachable: a row that can complete can take some value of "${name}"`,
      );
    }
    row.set(name, best.value);
    for (const key of best.covered) uncovered.delete(key);
  }
}

/** The values a row may take for a dimension while staying able to complete, lazily: the values of the dimension's coverable tuples first, in their order, and only if none of them fits, the value of the row's own first completion, which always fits. */
function* candidatesFor(
  context: StrategyContext,
  row: Row,
  name: string,
  coveringValues: readonly Value[],
): Generator<Value> {
  let any = false;
  for (const value of coveringValues) {
    if (completes(context, new Map([...row, [name, value]]))) {
      any = true;
      yield value;
    }
  }
  if (any) return;

  const completed = firstCompletion(context, row);
  if (completed !== undefined) yield completed[name];
}

/** Places every tuple still uncovered after horizontal growth: into the first row agreeing with it wherever both are placed that can still complete with it, or else into a new row of its own. A tuple an earlier placement already covered is skipped. */
function growVertically(
  context: StrategyContext,
  rows: readonly Row[],
  uncovered: ReadonlyMap<string, Row>,
  addRow: (row: Row) => void,
): void {
  for (const tuple of uncovered.values()) {
    if (rows.some((row) => covers(row, tuple))) continue;

    const host = rows.find((row) => {
      if (!agrees(row, tuple)) return false;

      return completes(context, new Map([...row, ...tuple]));
    });
    if (host === undefined) {
      addRow(new Map(tuple));
      continue;
    }
    for (const [name, value] of tuple) host.set(name, value);
  }
}

/** Whether the row has every value of the tuple. */
function covers(row: Row, tuple: Row): boolean {
  return [...tuple].every(
    ([name, value]) => row.has(name) && sameValue(row.get(name), value),
  );
}

/** Whether the row and the tuple have the same value on every dimension both place. */
function agrees(row: Row, tuple: Row): boolean {
  return [...tuple].every(
    ([name, value]) => !row.has(name) || sameValue(row.get(name), value),
  );
}

function sameValue(left: Value, right: Value): boolean {
  return tupleKey([["", left]]) === tupleKey([["", right]]);
}

/** Whether some valid combination agrees with the assignment, asked of the engine, which stops at the first one. */
function completes(
  context: StrategyContext,
  assignment: PartialAssignment,
): boolean {
  return firstCompletion(context, assignment) !== undefined;
}

/** The first valid combination, in enumeration order, agreeing with the assignment, or `undefined` when there is none. Only the first is searched for: the search is closed once it is found. */
function firstCompletion(
  context: StrategyContext,
  assignment: PartialAssignment,
): Readonly<Record<string, Value>> | undefined {
  const search = context.completions(assignment);
  const first = search.next();
  search.return(undefined);

  return first.done === true ? undefined : first.value;
}

function dimensionAt(
  dimensions: readonly Dimension[],
  index: number,
): Dimension {
  const dimension = dimensions[index];
  if (dimension === undefined) {
    throw new Error(
      `unreachable: position ${String(index)} is within the ${String(dimensions.length)} dimensions`,
    );
  }

  return dimension;
}

function nameAt(names: readonly string[], index: number): string {
  const name = names[index];
  if (name === undefined) {
    throw new Error(
      `unreachable: position ${String(index)} is within the ${String(names.length)} names`,
    );
  }

  return name;
}

function valuesAt(
  values: readonly (readonly Value[])[],
  index: number,
): readonly Value[] {
  const list = values[index];
  if (list === undefined) {
    throw new Error(
      `unreachable: the possible values of position ${String(index)} are found before any later position's`,
    );
  }

  return list;
}
