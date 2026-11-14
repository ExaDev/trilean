import { expect } from "vitest";
import { ComputedValueSchema } from "../computed-value";
import { ExpressionNodeSchema, PredicateNodeSchema } from "../tree";
import type { NumberFormatCase, SerialiseCase } from "./corpus-types";
import { decodeNumbers } from "./values";

const PARSERS: Readonly<Record<string, (input: unknown) => unknown>> = {
  PredicateNodeSchema: (input) => PredicateNodeSchema.parse(input),
  ExpressionNodeSchema: (input) => ExpressionNodeSchema.parse(input),
  ComputedValueSchema: (input) => ComputedValueSchema.parse(input),
};

/** Parses the text with the named schema and serialises the result again: the text must be exactly the case's. */
export function runSerialiseCase(testCase: SerialiseCase): void {
  const parse = PARSERS[testCase.schema];
  if (parse === undefined) {
    throw new Error(`no schema is known by the name ${testCase.schema}`);
  }
  const parsed: unknown = JSON.parse(testCase.input);
  expect(JSON.stringify(parse(parsed))).toBe(testCase.expect);
}

/** The text `Number.prototype.toString` gives the value. */
export function runNumberFormatCase(testCase: NumberFormatCase): void {
  const value = decodeNumbers(testCase.value);
  if (typeof value !== "number") {
    throw new Error("a number-format case needs a number");
  }
  expect(String(value)).toBe(testCase.expect);
}
