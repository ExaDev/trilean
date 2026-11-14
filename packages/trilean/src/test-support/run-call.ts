import { expect } from "vitest";
import { builtinFunctions } from "../builtin-functions";
import type { CallCase, CallFailure, ComputedValueJson } from "./corpus-types";
import { jsonEquals } from "./json-equal";
import { includesInOrder } from "./run-evaluate";
import { toComputedValue } from "./values";

/** Calls the named built-in function with the arguments and compares what it returns with the case's expectation. */
export function runCallCase(testCase: CallCase): void {
  const fn = builtinFunctions[testCase.function];
  if (fn === undefined) {
    throw new Error(`no built-in function ${testCase.function}`);
  }
  const result = fn(testCase.args.map(toComputedValue));
  const wanted = testCase.expect;
  const label = `${testCase.function}(${JSON.stringify(testCase.args)}) returned ${JSON.stringify(result)}`;
  if (isFailure(wanted)) {
    const message =
      wanted.domainError === true
        ? "domainError" in result
          ? result.domainError
          : undefined
        : "wrongType" in result
          ? result.wrongType
          : undefined;
    expect(message, label).toBeDefined();
    if (message !== undefined && wanted.messageIncludes !== undefined) {
      expect(
        includesInOrder(message, wanted.messageIncludes),
        `${label}: the message lacks, in order, ${JSON.stringify(wanted.messageIncludes)}`,
      ).toBe(true);
    }

    return;
  }
  expect(jsonEquals(result, wanted, testCase.tolerance), label).toBe(true);
}

function isFailure(
  expectation: ComputedValueJson | CallFailure,
): expectation is CallFailure {
  return !("kind" in expectation);
}
