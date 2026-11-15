import { expect } from "vitest";
import * as computedValue from "../computed-value";
import * as evaluation from "../evaluation";
import { readAs } from "../read-as";
import * as tree from "../tree";
import type { StandardSchemaV1 } from "../../generated/schemas.js";
import type { ValidateCase } from "./corpus-types";
import { jsonEquals } from "./json-equal";
import { decodeNumbers } from "./values";

function isSchema(value: unknown): value is StandardSchemaV1<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "~standard" in value &&
    typeof value["~standard"] === "object"
  );
}

/** Every exported schema of the package, by export name: the name a `validate` case gives. */
const schemas = new Map<string, StandardSchemaV1<unknown, unknown>>(
  [computedValue, evaluation, tree].flatMap((module) =>
    Object.entries(module).filter(
      (entry): entry is [string, StandardSchemaV1<unknown, unknown>] =>
        isSchema(entry[1]),
    ),
  ),
);

/** Validates the input with the named schema and compares the verdict, the parsed value and the keys it holds. */
export function runValidateCase(testCase: ValidateCase): void {
  const schema = schemas.get(testCase.schema);
  if (schema === undefined) {
    throw new Error(`no schema is exported under the name ${testCase.schema}`);
  }
  const result = readAs(schema, decodeNumbers(testCase.input));
  const wanted = testCase.expect;
  expect(
    result.success,
    `${testCase.schema} on ${JSON.stringify(testCase.input)}`,
  ).toBe(wanted.ok);
  if (result.success && wanted.ok) {
    if (wanted.value !== undefined) {
      expect(
        jsonEquals(result.data, wanted.value, testCase.tolerance),
        `parsed ${JSON.stringify(result.data)}`,
      ).toBe(true);
    }
  }
}
