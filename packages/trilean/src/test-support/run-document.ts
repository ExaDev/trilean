import { expect } from "vitest";
import { evaluateDocument } from "../evaluate-document";
import { parseInputs } from "../input-resolvers";
import type { DocumentCase, InputsCase } from "./corpus-types";
import { jsonEquals, subsetMatches } from "./json-equal";
import { decodeNumbers } from "./values";

/** Parses the raw inputs and compares the verdict: the named values and lists of items, or the issues. */
export function runInputsCase(testCase: InputsCase): void {
  const result = parseInputs(decodeNumbers(testCase.raw));
  const wanted = testCase.expect;
  expect(result.ok, JSON.stringify(result)).toBe(wanted.ok);
  if (result.ok && wanted.ok) {
    const inputs = Object.fromEntries(result.inputs);
    const collections = Object.fromEntries(
      [...result.collections].map(([name, items]) => [
        name,
        items.map((item) => Object.fromEntries(item)),
      ]),
    );
    const tolerance = testCase.tolerance;
    expect(
      jsonEquals(inputs, wanted.inputs, tolerance),
      `inputs ${JSON.stringify(inputs)}`,
    ).toBe(true);
    expect(
      jsonEquals(collections, wanted.collections, tolerance),
      `collections ${JSON.stringify(collections)}`,
    ).toBe(true);
  } else if (!result.ok && !wanted.ok) {
    expect(result.issues).toEqual(wanted.issues);
  }
}

/** Evaluates the document and compares the whole outcome with the expectation. */
export function runDocumentCase(testCase: DocumentCase): void {
  const result = evaluateDocument({
    tree: decodeNumbers(testCase.tree),
    ...(testCase.inputs === undefined
      ? {}
      : { inputs: decodeNumbers(testCase.inputs) }),
    ...(testCase.as === undefined ? {} : { as: testCase.as }),
    ...(typeof testCase.maxNodes === "number"
      ? { maxNodes: testCase.maxNodes }
      : {}),
  });
  const matches =
    testCase.expectSubset === undefined
      ? jsonEquals(result, testCase.expect, testCase.tolerance)
      : subsetMatches(result, testCase.expectSubset, testCase.tolerance);
  expect(matches, `the document evaluated to ${JSON.stringify(result)}`).toBe(
    true,
  );
}
