import { expect } from "vitest";
import * as computedValue from "../computed-value";
import * as evaluation from "../evaluation";
import * as tree from "../tree";
import type { ValidateCase } from "./corpus-types";
import { jsonEquals } from "./json-equal";
import { decodeNumbers } from "./values";

interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

interface Schema {
  readonly safeParse: (input: unknown) =>
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
        readonly error: { readonly issues: readonly Issue[] };
      };
}

function isSchema(value: unknown): value is Schema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof value.safeParse === "function"
  );
}

/** Every exported schema of the package, by export name: the name a `validate` case gives. */
const schemas = new Map<string, Schema>(
  [computedValue, evaluation, tree].flatMap((module) =>
    Object.entries(module).filter((entry): entry is [string, Schema] =>
      isSchema(entry[1]),
    ),
  ),
);

/** Validates the input with the named schema and compares the verdict, the parsed value or the listed issues. */
export function runValidateCase(testCase: ValidateCase): void {
  const schema = schemas.get(testCase.schema);
  if (schema === undefined) {
    throw new Error(`no schema is exported under the name ${testCase.schema}`);
  }
  const result = schema.safeParse(decodeNumbers(testCase.input));
  const wanted = testCase.expect;
  expect(
    result.success,
    `${testCase.schema} on ${JSON.stringify(testCase.input)}`,
  ).toBe(wanted.ok);
  if (result.success && wanted.ok) {
    if (wanted.value !== undefined) {
      expect(
        jsonEquals(result.data, wanted.value, testCase.tolerance?.ulps),
        `parsed ${JSON.stringify(result.data)}`,
      ).toBe(true);
    }
  } else if (!result.success && !wanted.ok) {
    for (const issue of wanted.issues) {
      const found = result.error.issues.some(
        (reported) =>
          jsonEquals(reported.path, issue.path) &&
          (issue.message === undefined ||
            reported.message.includes(issue.message)),
      );
      expect(
        found,
        `no reported issue at ${JSON.stringify(issue.path)}: ${JSON.stringify(result.error.issues)}`,
      ).toBe(true);
    }
  }
}
