import { PredicateNodeSchema } from "trilean";
import type { PredicateNode } from "trilean";
import { expect } from "vitest";
import { parseRegex } from "trilean-regex";
import { compilePredicateNode } from "../compile";
import {
  InvalidCollectionTableError,
  InvalidColumnError,
  UnknownDialectError,
  UnsupportedNodeError,
} from "../errors";
import { findUnpushableNodeKind } from "../guard";
import {
  PortablePatternUnsupportedError,
  renderPostgresPattern,
  renderSqliteGlobPattern,
} from "../portable-pattern";
import type {
  SqlCompileCase,
  SqlErrorData,
  SqlGuardCase,
  SqlParamData,
  SqlPatternCase,
  Text,
} from "./corpus-types";
import { decodeNumbers, replaceNonFinite } from "./numbers";
import { buildOptions } from "./sql-options";
import type { CallbackLog } from "./sql-options";
import { textToString } from "./text";

/** Whether a value has the shape of a predicate tree. The package's schema refuses a NaN or an infinity, which a case may put in a tree to pin what the compiler does with it, so it checks the value with those stood in by zero. */
function isPredicateNode(value: unknown): value is PredicateNode {
  return PredicateNodeSchema.safeParse(replaceNonFinite(value)).success;
}

/** The tree of a case, with the numbers JSON cannot carry decoded. */
export function treeOf(tree: unknown): PredicateNode {
  const decoded = decodeNumbers(tree);
  if (!isPredicateNode(decoded)) {
    throw new Error("the tree is not a predicate tree");
  }

  return decoded;
}

function newLog(): CallbackLog {
  return { thrown: [], columnKeys: [] };
}

/** Whether the fragments occur in the text, each after the end of the one before. */
function containsInOrder(text: string, fragments: readonly Text[]): boolean {
  let from = 0;
  for (const fragment of fragments) {
    const found = text.indexOf(textToString(fragment), from);
    if (found < 0) {
      return false;
    }
    from = found + textToString(fragment).length;
  }

  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checks a thrown value against the error a case expects: its class, its fields and the fragments of its message; a `CallerError` must be an exception one of the options' callbacks threw, the very object. */
function expectError(
  thrown: unknown,
  expected: SqlErrorData,
  log: CallbackLog,
): void {
  const message = errorMessage(thrown);
  expect(
    containsInOrder(message, expected.message),
    `the message ${JSON.stringify(message)} lacks ${JSON.stringify(expected.message)}`,
  ).toBe(true);
  switch (expected.name) {
    case "CallerError":
      expect(log.thrown, "the error is one a callback threw").toContain(thrown);
      break;
    case "UnsupportedNodeError":
      expect(thrown).toBeInstanceOf(UnsupportedNodeError);
      expect(thrown).toMatchObject({
        name: expected.name,
        nodeKind: expected.nodeKind,
        path: expected.path,
      });
      expect(
        containsInOrder(
          thrown instanceof UnsupportedNodeError ? thrown.reason : "",
          expected.reason,
        ),
        "the reason lacks the fragments",
      ).toBe(true);
      break;
    case "InvalidColumnError":
      expect(thrown).toBeInstanceOf(InvalidColumnError);
      expect(thrown).toMatchObject({
        name: expected.name,
        referenceKey: expected.referenceKey,
        column: expected.column,
      });
      break;
    case "InvalidCollectionTableError":
      expect(thrown).toBeInstanceOf(InvalidCollectionTableError);
      expect(thrown).toMatchObject({
        name: expected.name,
        collectionKey: expected.collectionKey,
        table: expected.table,
      });
      break;
    case "UnknownDialectError":
      expect(thrown).toBeInstanceOf(UnknownDialectError);
      expect(thrown).toMatchObject({
        name: expected.name,
        dialect: expected.dialect,
        implemented: expected.implemented,
      });
      break;
  }
}

/** The result of a function that may throw, held as a value so the case decides which it expected. */
type Outcome<T> = { readonly returned: T } | { readonly thrown: unknown };

function attempt<T>(run: () => T): Outcome<T> {
  try {
    return { returned: run() };
  } catch (error) {
    return { thrown: error };
  }
}

/**
 * Whether the compiled parameters are the expected ones, by kind and value. A timestamp is the instant's text and the TypeScript implementation holds it as a string, exactly as it holds a text, so for a timestamp this checks the value and that it is a string; the number, boolean and text kinds are checked in full.
 */
function paramProblems(
  actual: readonly unknown[],
  expected: readonly SqlParamData[],
): readonly string[] {
  if (actual.length !== expected.length) {
    return [
      `${String(actual.length)} parameters, expected ${String(expected.length)}`,
    ];
  }

  return expected.flatMap((param, index) => {
    const value = actual[index];
    const matches =
      param.type === "number"
        ? typeof value === "number" && Object.is(value, param.value)
        : param.type === "boolean"
          ? value === param.value
          : typeof value === "string" && value === param.value;

    return matches
      ? []
      : [
          `parameter ${String(index + 1)} is ${JSON.stringify(value)}, expected ${param.type} ${JSON.stringify(param.value)}`,
        ];
  });
}

export function runCompileCase(testCase: SqlCompileCase): void {
  const log = newLog();
  const outcome = attempt(() =>
    compilePredicateNode(
      treeOf(testCase.tree),
      buildOptions(testCase.options, log),
    ),
  );
  if ("error" in testCase.expect) {
    expect(outcome, "the compilation must be refused").toHaveProperty("thrown");
    if ("thrown" in outcome) {
      expectError(outcome.thrown, testCase.expect.error, log);
    }
  } else {
    expect("returned" in outcome ? outcome.returned.sql : outcome.thrown).toBe(
      testCase.expect.sql,
    );
    if ("returned" in outcome) {
      expect(
        paramProblems(outcome.returned.params, testCase.expect.params),
      ).toEqual([]);
    }
  }
  if (testCase.expectColumnCalls !== undefined) {
    expect(log.columnKeys).toEqual(testCase.expectColumnCalls);
  }
}

export function runGuardCase(testCase: SqlGuardCase): void {
  const log = newLog();
  const outcome = attempt(() =>
    findUnpushableNodeKind(
      treeOf(testCase.tree),
      testCase.options === undefined
        ? undefined
        : buildOptions(testCase.options, log),
    ),
  );
  const { expect: expected } = testCase;
  if (expected !== null && "error" in expected) {
    expect(outcome, "the guard must throw").toHaveProperty("thrown");
    if ("thrown" in outcome) {
      expectError(outcome.thrown, expected.error, log);
    }

    return;
  }
  expect(outcome, "the guard must not throw").toHaveProperty("returned");
  if (!("returned" in outcome)) {
    return;
  }
  const found = outcome.returned;
  if (found === undefined || expected === null) {
    expect(found ?? null).toEqual(expected);

    return;
  }
  expect({ nodeKind: found.kind, path: found.path }).toEqual({
    nodeKind: expected.nodeKind,
    path: expected.path,
  });
  expect(
    containsInOrder(found.reason, expected.reason),
    `the reason ${JSON.stringify(found.reason)} lacks ${JSON.stringify(expected.reason)}`,
  ).toBe(true);
}

export function runPatternCase(testCase: SqlPatternCase): void {
  const node = parseRegex(textToString(testCase.pattern));
  const render =
    testCase.dialect === "postgres"
      ? renderPostgresPattern
      : renderSqliteGlobPattern;
  const outcome = attempt(() => render(node));
  if ("error" in testCase.expect) {
    expect(outcome, "the pattern must be refused").toHaveProperty("thrown");
    if ("thrown" in outcome) {
      expect(outcome.thrown).toBeInstanceOf(PortablePatternUnsupportedError);
      expect(
        containsInOrder(
          errorMessage(outcome.thrown),
          testCase.expect.error.message,
        ),
      ).toBe(true);
    }
  } else {
    expect("returned" in outcome ? outcome.returned : outcome.thrown).toBe(
      testCase.expect.text,
    );
  }
}
