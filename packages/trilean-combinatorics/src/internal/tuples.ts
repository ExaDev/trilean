import type { Value } from "combinatrix";

/** Every way to choose `size` of the items, each keeping the items' order, listed lexicographically by position. Choosing none gives the one empty subset; choosing more than there are gives none. */
export function subsetsOf<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];

  return items.flatMap((item, index) =>
    subsetsOf(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]),
  );
}

/** Every choice of one value from each list, lazily and lexicographically by position, the last list varying fastest. No lists give the one empty choice; an empty list gives none. */
export function* productOf(
  lists: readonly (readonly Value[])[],
): Generator<Value[]> {
  const [first, ...rest] = lists;
  if (first === undefined) {
    yield [];

    return;
  }
  for (const value of first) {
    for (const tail of productOf(rest)) yield [value, ...tail];
  }
}

/** The canonical text of dimension values given as name and value pairs: `[name]` for unset and `[name, value]` for a set value, so `null` never collides with unset. Two lists of pairs naming the same dimensions in the same order have equal texts exactly when their values are equal, and equal values have equal JSON, so `0` and `-0` are one value, as combinatrix treats them. */
export function tupleKey(pairs: readonly (readonly [string, Value])[]): string {
  return JSON.stringify(
    pairs.map(([name, value]) =>
      value === undefined ? [name] : [name, value],
    ),
  );
}
