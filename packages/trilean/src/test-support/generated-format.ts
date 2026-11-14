/** The text of a corpus file the way the repository's lint writes it: keys sorted, two-space indent, one element per line; a negative zero and a number that is not finite are the objects the README names. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A negative zero cannot be written as a JSON number in a canonical corpus file, so it is the object the README names. */
export function format(value: unknown, indent: string): string {
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Object.is(value, -0))
  ) {
    return `{\n${indent}  "$number": ${JSON.stringify(String(Object.is(value, -0) ? "-0" : value))}\n${indent}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const next = `${indent}  `;

    return `[\n${value.map((item: unknown) => `${next}${format(item, next)}`).join(",\n")}\n${indent}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      return "{}";
    }
    const next = `${indent}  `;

    return `{\n${keys.map((key) => `${next}${JSON.stringify(key)}: ${format(value[key], next)}`).join(",\n")}\n${indent}}`;
  }

  return JSON.stringify(value);
}

/** The order of UTF-16 code units, which no locale changes. */
export function byCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
