/** Narrows `unknown` to a plain JSON-style object: not `null`, not an array. The guard parsed JSON is checked with before its fields are read, in place of an `as Record<string, unknown>` assertion. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
