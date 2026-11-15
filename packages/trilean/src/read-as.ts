import type { StandardSchemaV1 } from "../generated/schemas.js";

/** The outcome of reading a value as a schema: the value as the schema reads it, or the problems with their paths. */
export type ReadOutcome<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly issues: readonly StandardSchemaV1.Issue[];
    };

/** Reads `value` as `schema`. A schema of this package reads synchronously, so a promise from one is a defect of the package and is thrown. */
export function readAs<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): ReadOutcome<T> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new TypeError("a schema of this package must read synchronously");
  }
  if (result.issues === undefined) {
    return { success: true, data: result.value };
  }

  return { success: false, issues: result.issues };
}

/** Reads `value` as `schema`, and throws an error that lists the problems when it is not one. For a value that is known to be one: a fixture, or a tree the caller built. */
export function parseAs<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): T {
  const outcome = readAs(schema, value);
  if (outcome.success) {
    return outcome.data;
  }
  throw new Error(
    outcome.issues
      .map(
        (issue) =>
          `${(issue.path ?? []).map(String).join(".") || "(root)"}: ${issue.message}`,
      )
      .join("; "),
  );
}
