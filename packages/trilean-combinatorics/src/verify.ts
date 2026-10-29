import type { Model, Value } from "combinatrix";
import { collect, explain } from "combinatrix";

/** Options for `isCoveringArray`. */
export interface CoveringCheckOptions {
  /** The strength t to check, a positive integer, read as `coveringArray` reads it: above the model's dimension count it means every dimension at once. */
  readonly strength: number;
  /** The largest solution set the check enumerates, a non-negative integer; past it combinatrix's `collect` throws `LimitExceededError`. */
  readonly limit: number;
}

/**
 * Whether the rows are a covering array of the model's solution set at the given strength: every row is a complete combination in the solution set (every dimension present, derived ones included, and `explain` finding no reason against it), and every t-way combination of dimension values that occurs in some combination of the solution set occurs in some row. Tuples no valid combination contains are not required. Duplicate rows are allowed.
 *
 * It is the brute-force definition, written independently of `coveringArray` so that it can test it: it enumerates the whole solution set with combinatrix's `collect`, lists every t-tuple each combination contains, and checks each against the rows. Throws `RangeError` for a strength that is not a positive integer.
 */
export function isCoveringArray<T extends Readonly<Record<string, Value>>>(
  rows: Readonly<Iterable<Readonly<Record<string, Value>>>>,
  model: Model<T>,
  options: CoveringCheckOptions,
): boolean {
  const { strength, limit } = options;
  if (!Number.isSafeInteger(strength) || strength < 1) {
    throw new RangeError(
      `strength must be a positive integer, not ${String(strength)}`,
    );
  }
  const rowList = [...rows];
  if (
    !rowList.every((row) => model.isTuple(row) && explain(model, row).valid)
  ) {
    return false;
  }

  const names = model.dimensions.map((dimension) => dimension.name);
  const width = Math.min(strength, names.length);
  const covered = new Set<string>();
  for (const row of rowList) {
    for (const tuple of tuplesIn(row, names, width)) covered.add(tuple);
  }
  for (const { values } of collect(model, { limit })) {
    for (const tuple of tuplesIn(values, names, width)) {
      if (!covered.has(tuple)) return false;
    }
  }

  return true;
}

/** Every `width`-tuple of a combination's values, as text naming each dimension with its value, or with nothing for unset. */
function* tuplesIn(
  values: Readonly<Record<string, Value>>,
  names: readonly string[],
  width: number,
): Generator<string> {
  for (const chosen of nameChoices(names, width, 0)) {
    yield JSON.stringify(
      chosen.map((name) => {
        const value = values[name];

        return value === undefined ? { name } : { name, value };
      }),
    );
  }
}

/** Every choice of `width` names from position `from` on, each in the order the names are listed. */
function* nameChoices(
  names: readonly string[],
  width: number,
  from: number,
): Generator<string[]> {
  if (width === 0) {
    yield [];

    return;
  }
  for (let first = from; first <= names.length - width; first += 1) {
    const name = names[first];
    if (name === undefined) {
      throw new Error(
        `unreachable: position ${String(first)} is within the ${String(names.length)} names`,
      );
    }
    for (const rest of nameChoices(names, width - 1, first + 1)) {
      yield [name, ...rest];
    }
  }
}
