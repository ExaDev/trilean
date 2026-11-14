import { expect } from "vitest";
import { average, count, presenceOf, sum } from "../derived-aggregates";
import {
  and,
  iff,
  implies,
  nand,
  none,
  nor,
  not,
  or,
  xor,
} from "../derived-connectives";
import {
  hierarchicalGlobPattern,
  prefixPattern,
  wildcardPattern,
} from "../derived-patterns";
import { coalesce } from "../derived-values";
import type { JsonValue } from "../json-value";
import { ExpressionNodeSchema, PredicateNodeSchema } from "../tree";
import type { ExpressionNode, PredicateNode } from "../tree";
import type { BuildCase, Json } from "./corpus-types";
import { jsonEquals } from "./json-equal";
import { decodeNumbers } from "./values";

/** What one argument of a builder is: a corpus JSON value that must be a predicate tree, an expression tree, a collection reference, or a string. `null` stands for an argument left out. */
interface Arguments {
  readonly predicate: (position: number) => PredicateNode;
  readonly optionalPredicate: (position: number) => PredicateNode | undefined;
  readonly expression: (position: number) => ExpressionNode;
  readonly optionalExpression: (position: number) => ExpressionNode | undefined;
  readonly expressions: (from: number) => ExpressionNode[];
  readonly json: (position: number) => JsonValue;
  readonly text: (position: number) => string;
}

function argumentsOf(args: readonly Json[]): Arguments {
  const at = (position: number): Json => {
    const value = args[position];
    if (value === undefined) {
      throw new Error(
        `the builder needs an argument at position ${String(position)}`,
      );
    }

    return value;
  };
  const optional = (position: number): Json | undefined => {
    return args[position] ?? undefined;
  };
  const text = (position: number): string => {
    const value = at(position);
    if (typeof value !== "string") {
      throw new Error(`argument ${String(position)} must be a string`);
    }

    return value;
  };

  return {
    predicate: (position) => PredicateNodeSchema.parse(at(position)),
    optionalPredicate: (position) => {
      const value = optional(position);

      return value === undefined ? undefined : PredicateNodeSchema.parse(value);
    },
    expression: (position) => ExpressionNodeSchema.parse(at(position)),
    optionalExpression: (position) => {
      const value = optional(position);

      return value === undefined
        ? undefined
        : ExpressionNodeSchema.parse(value);
    },
    expressions: (from) =>
      args.slice(from).map((value) => ExpressionNodeSchema.parse(value)),
    json: at,
    text,
  };
}

/** The builders of the package, by the name a `build` case gives, each with the way its arguments are read. */
const BUILDERS: Readonly<Record<string, (args: Arguments) => unknown>> = {
  not: (a) => not(a.predicate(0)),
  and: (a) => and(a.predicate(0), a.predicate(1)),
  or: (a) => or(a.predicate(0), a.predicate(1)),
  xor: (a) => xor(a.predicate(0), a.predicate(1)),
  nand: (a) => nand(a.predicate(0), a.predicate(1)),
  nor: (a) => nor(a.predicate(0), a.predicate(1)),
  implies: (a) => implies(a.predicate(0), a.predicate(1)),
  iff: (a) => iff(a.predicate(0), a.predicate(1)),
  none: (a) => none(a.json(0), a.predicate(1), a.optionalPredicate(2)),
  sum: (a) => sum(a.json(0), a.expression(1), a.optionalPredicate(2)),
  average: (a) => average(a.json(0), a.expression(1), a.optionalPredicate(2)),
  count: (a) =>
    count(a.json(0), a.optionalPredicate(1), a.optionalExpression(2)),
  presenceOf: (a) => presenceOf(a.expression(0)),
  coalesce: (a) => {
    const [first, second, ...rest] = a.expressions(0);
    if (first === undefined || second === undefined) {
      throw new Error("coalesce needs at least two arguments");
    }

    return coalesce(first, second, ...rest);
  },
  prefixPattern: (a) => prefixPattern(a.expression(0), a.text(1)),
  wildcardPattern: (a) => wildcardPattern(a.expression(0), a.text(1)),
  hierarchicalGlobPattern: (a) =>
    hierarchicalGlobPattern(a.expression(0), a.text(1)),
};

/** Builds with the named builder and compares the tree it returns with the case's expectation. */
export function runBuildCase(testCase: BuildCase): void {
  const builder = BUILDERS[testCase.builder];
  if (builder === undefined) {
    throw new Error(`no builder is known by the name ${testCase.builder}`);
  }
  const built = builder(
    argumentsOf(testCase.args.map((arg) => decodeNumbers(arg))),
  );
  expect(
    jsonEquals(built, testCase.expect, testCase.tolerance?.ulps ?? 0),
    `${testCase.builder} built ${JSON.stringify(built)}`,
  ).toBe(true);
}
