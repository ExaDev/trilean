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
  ExactText,
  SqlCompileCase,
  SqlErrorData,
  SqlGuardCase,
  SqlParamData,
  SqlPatternCase,
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

/** The text a case states: exactly, or, for a text that relays another package's message, the concatenation of what comes before it, its parts with the separator between each two, and what comes after. */
function expectedText(expected: ExactText): string {
  return typeof expected === "string"
    ? expected
    : expected.before +
        expected.relayed
          .map(textToString)
          .join(textToString(expected.separator)) +
        expected.after;
}

/** The problems with a text against the one a case states, which it must equal character for character. */
function textProblems(actual: string, expected: ExactText): readonly string[] {
  const wanted = expectedText(expected);

  return actual === wanted
    ? []
    : [`${JSON.stringify(actual)} is not ${JSON.stringify(wanted)}`];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checks a thrown value against the error a case expects: its class, its fields and its message, each exactly; a `CallerError` must be an exception one of the options' callbacks threw, the very object. */
function expectError(
  thrown: unknown,
  expected: SqlErrorData,
  log: CallbackLog,
): void {
  expect(textProblems(errorMessage(thrown), expected.message)).toEqual([]);
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
        textProblems(
          thrown instanceof UnsupportedNodeError ? thrown.reason : "",
          expected.reason,
        ),
      ).toEqual([]);
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

/** The kind a PostgreSQL placeholder is cast to, by the cast the compiler writes after it. */
const POSTGRES_CASTS: Readonly<Record<string, SqlParamData["type"]>> = {
  text: "text",
  "double precision": "number",
  boolean: "boolean",
  timestamptz: "timestamp",
};

/** The kind of the `index`-th (1-based) PostgreSQL placeholder of a fragment, from its cast. */
function castKind(sql: string, index: number): string {
  const found = new RegExp(
    `\\$${String(index)}::(double precision|text|boolean|timestamptz)(?![a-z])`,
    "u",
  ).exec(sql);

  return found?.[1] === undefined
    ? "none"
    : (POSTGRES_CASTS[found[1]] ?? found[1]);
}

/**
 * The problems with the compiled parameters against the expected ones, by kind and value. Number, boolean and text values are checked in full, a number by `Object.is` so that -0 and NaN count. Under PostgreSQL the kind of every parameter is read from the cast the compiler wrote on its placeholder, so a timestamp bound as a text is a failure. Under SQLite a placeholder carries no kind and the engine binds a timestamp as the instant's text, so a timestamp there is checked as the string it is, and what the engine does with it is pinned by the execute cases.
 */
function paramProblems(
  dialect: string,
  sql: string,
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
    const wanted = decodeNumbers(param.value);
    const matches =
      param.type === "number"
        ? typeof value === "number" && Object.is(value, wanted)
        : param.type === "boolean"
          ? value === wanted
          : typeof value === "string" && value === wanted;
    const problems = matches
      ? []
      : [
          `parameter ${String(index + 1)} is ${JSON.stringify(value)}, expected ${param.type} ${JSON.stringify(param.value)}`,
        ];
    if (dialect === "postgres" && castKind(sql, index + 1) !== param.type) {
      problems.push(
        `parameter ${String(index + 1)} is cast as ${castKind(sql, index + 1)}, expected ${param.type}`,
      );
    }

    return problems;
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
        paramProblems(
          testCase.options.dialect,
          outcome.returned.sql,
          outcome.returned.params,
          testCase.expect.params,
        ),
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
  expect(textProblems(found.reason, expected.reason)).toEqual([]);
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
        textProblems(
          errorMessage(outcome.thrown),
          testCase.expect.error.message,
        ),
      ).toEqual([]);
    }
  } else {
    expect("returned" in outcome ? outcome.returned : outcome.thrown).toBe(
      testCase.expect.text,
    );
  }
}
