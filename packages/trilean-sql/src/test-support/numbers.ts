const NAMED_NUMBERS: Readonly<Record<string, number>> = {
  "-0": -0,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
  NaN: Number.NaN,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value with every `{ "$number": "-0" | "Infinity" | "-Infinity" | "NaN" }` replaced by the number it names, which is how a corpus file holds a number the canonical JSON form cannot. */
export function decodeNumbers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeNumbers);
  }
  if (!isRecord(value)) {
    return value;
  }
  const named = value.$number;
  if (typeof named === "string" && Object.keys(value).length === 1) {
    const decoded = Object.hasOwn(NAMED_NUMBERS, named)
      ? NAMED_NUMBERS[named]
      : undefined;
    if (decoded === undefined) {
      throw new Error(
        `$number names ${named}, which is not a number a corpus file names`,
      );
    }

    return decoded;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decodeNumbers(item)]),
  );
}

/** The value with every number that is not finite replaced by 0, so a tree that holds a NaN or an infinity, which the package's schema refuses, can still be checked for its shape. */
export function replaceNonFinite(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (Array.isArray(value)) {
    return value.map(replaceNonFinite);
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceNonFinite(item)]),
  );
}
