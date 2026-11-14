import { expect } from "vitest";
import { builtinFunctions } from "../builtin-functions";
import { ComputedValueSchema } from "../computed-value";
import type { Evaluation } from "../evaluation";
import { createEvaluator, createSyncEvaluator } from "../evaluator-factory";
import type { EvaluatorOptions } from "../evaluator-factory";
import type { FunctionFailure, FunctionRegistry } from "../functions";
import { ExpressionNodeSchema, PredicateNodeSchema } from "../tree";
import type { EvaluateCase, Mode } from "./corpus-types";
import { jsonEquals } from "./json-equal";
import type { Tolerance } from "./json-equal";
import { buildResolvers } from "./resolver-data";
import { decodeNumbers } from "./values";
import type { RecordedCall } from "./resolver-data";

/** The modes a case runs in: those it names, else every mode that applies (the compiled predicate exists for predicates only). */
export function modesOf(testCase: EvaluateCase): readonly Mode[] {
  return (
    testCase.modes ??
    (testCase.as === "predicate"
      ? ["async", "sync", "compiled"]
      : ["async", "sync"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFunctionFailure(value: unknown): value is FunctionFailure {
  return isRecord(value) && ("domainError" in value || "wrongType" in value);
}

/** The registry a case's `evaluator.functions` describes: the built-ins when asked for, then the table, whose entries answer a call whose arguments equal theirs and fail loudly when none does. */
function registryOf(testCase: EvaluateCase): FunctionRegistry {
  const spec = testCase.evaluator?.functions;
  const registry: FunctionRegistry =
    spec?.builtin === true ? { ...builtinFunctions } : {};
  for (const [name, entries] of Object.entries(spec?.table ?? {})) {
    registry[name] = (args) => {
      const entry = entries.find((item) => jsonEquals(args, item.args));
      if (entry === undefined) {
        throw new Error(
          `function table for ${name} has no entry for ${JSON.stringify(args)}`,
        );
      }

      return isFunctionFailure(entry.result)
        ? entry.result
        : ComputedValueSchema.parse(entry.result);
    };
  }

  return registry;
}

function optionsOf(testCase: EvaluateCase): EvaluatorOptions {
  const spec = testCase.evaluator;
  const options: EvaluatorOptions = { functions: registryOf(testCase) };
  if (typeof spec?.maxNodes === "number") {
    options.maxNodes = spec.maxNodes;
  }
  if (typeof spec?.maxNestingDepth === "number") {
    options.maxNestingDepth = spec.maxNestingDepth;
  }

  return options;
}

/** The corpus form of an evaluation: `{ status, value }` or `{ status, code, message }`. */
function flatten(evaluation: Evaluation<unknown>): Record<string, unknown> {
  return evaluation.status === "definite"
    ? { status: "definite", value: evaluation.value }
    : {
        status: "indeterminate",
        code: evaluation.reason.code,
        message: evaluation.reason.message,
      };
}

/** Whether every fragment occurs in `text`, each after the end of the one before. */
export function includesInOrder(
  text: string,
  fragments: readonly string[],
): boolean {
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    if (at === -1) {
      return false;
    }
    from = at + fragment.length;
  }

  return true;
}

function checkExpectation(
  wanted: Exclude<
    EvaluateCase["expect"],
    { readonly throws: unknown } | undefined
  >,
  outcome: Evaluation<unknown> | undefined,
  tolerance: Tolerance | undefined,
  label: string,
): void {
  if (outcome === undefined) {
    throw new Error(`${label}: the evaluation produced no result`);
  }
  const got = flatten(outcome);
  expect(got.status, `${label}: ${JSON.stringify(got)}`).toBe(wanted.status);
  if (wanted.status === "definite") {
    if (wanted.value !== undefined) {
      expect(
        jsonEquals(got.value, wanted.value, tolerance),
        `${label}: ${JSON.stringify(got.value)} is not ${JSON.stringify(wanted.value)}`,
      ).toBe(true);
    }

    return;
  }
  if (wanted.code !== undefined) {
    expect(got.code, label).toBe(wanted.code);
  }
  if (wanted.message !== undefined) {
    expect(got.message, label).toBe(wanted.message);
  }
  if (wanted.messageIncludes !== undefined) {
    const message = String(got.message);
    expect(
      includesInOrder(message, wanted.messageIncludes),
      `${label}: reason ${JSON.stringify(message)} lacks, in order, ${JSON.stringify(wanted.messageIncludes)}`,
    ).toBe(true);
  }
}

function checkCalls(
  testCase: EvaluateCase,
  calls: readonly RecordedCall[],
  label: string,
): void {
  const wanted = testCase.expectCalls;
  if (wanted === undefined) {
    return;
  }
  expect(calls.length, `${label}: number of resolver calls`).toBe(
    wanted.length,
  );
  wanted.forEach((call, position) => {
    const made = calls[position];
    expect(made?.resolver, `${label}: call ${String(position)}`).toBe(
      call.resolver,
    );
    for (const field of ["key", "table", "collection", "system"] as const) {
      const expected = call[field];
      if (expected !== undefined) {
        expect(
          jsonEquals(made?.[field], expected),
          `${label}: call ${String(position)} ${field}`,
        ).toBe(true);
      }
    }
  });
}

/** Checks the exception an evaluation threw against the case's `throws` expectation. */
function checkThrown(
  expectation: { readonly from: string; readonly message?: string },
  thrown: { readonly error: unknown } | undefined,
  label: string,
): void {
  expect(thrown, `${label}: expected the evaluation to throw`).toBeDefined();
  const error = thrown?.error;
  if (expectation.message !== undefined) {
    expect(
      error instanceof Error ? error.message : String(error),
      label,
    ).toContain(expectation.message);
  }
  if (expectation.from === "type-error") {
    expect(error, label).toBeInstanceOf(TypeError);
  }
}

/** Evaluates the case in every mode it names and checks the result, and the resolver calls where it lists them. */
export async function runEvaluateCase(testCase: EvaluateCase): Promise<void> {
  const predicateTree =
    testCase.as === "predicate"
      ? PredicateNodeSchema.parse(decodeNumbers(testCase.tree))
      : undefined;
  const expressionTree =
    testCase.as === "expression"
      ? ExpressionNodeSchema.parse(decodeNumbers(testCase.tree))
      : undefined;
  const context = decodeNumbers(testCase.context ?? null);
  const runMode = async (mode: Mode): Promise<void> => {
    const label = `${testCase.id} [${mode}]`;
    const resolvers = buildResolvers(testCase.resolvers);
    const evaluate = async (): Promise<Evaluation<unknown>> => {
      if (mode === "async") {
        const evaluator = createEvaluator(optionsOf(testCase));

        return predicateTree === undefined
          ? await evaluator.evaluateValue(
              expectDefined(expressionTree),
              context,
              resolvers.asynchronous,
            )
          : await evaluator.evaluatePredicate(
              predicateTree,
              context,
              resolvers.asynchronous,
            );
      }
      const evaluator = createSyncEvaluator(optionsOf(testCase));
      if (mode === "compiled") {
        return evaluator.compilePredicate(expectDefined(predicateTree))(
          context,
          resolvers.sync,
        );
      }

      return predicateTree === undefined
        ? evaluator.evaluateValue(
            expectDefined(expressionTree),
            context,
            resolvers.sync,
          )
        : evaluator.evaluatePredicate(predicateTree, context, resolvers.sync);
    };
    let outcome: Evaluation<unknown> | undefined;
    let thrown: { readonly error: unknown } | undefined;
    try {
      outcome = await evaluate();
    } catch (error) {
      thrown = { error };
    }
    if (testCase.expect === undefined) {
      if (thrown !== undefined) {
        throw thrown.error;
      }
    } else if ("throws" in testCase.expect) {
      checkThrown(testCase.expect.throws, thrown, label);
    } else {
      if (thrown !== undefined) {
        throw thrown.error;
      }
      checkExpectation(testCase.expect, outcome, testCase.tolerance, label);
    }
    checkCalls(testCase, resolvers.calls, label);
  };
  await Promise.all(modesOf(testCase).map(runMode));
}

function expectDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("the case's tree does not match its `as`");
  }

  return value;
}
