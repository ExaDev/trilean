import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCorpus } from "../../src/test-support/corpus";
import type { SqlCompileCase } from "../../src/test-support/corpus-types";
import { decodeNumbers } from "../../src/test-support/numbers";
import { bindable, openPostgres, openSqlite } from "./corpus-engines";
import type { Engine } from "./corpus-engines";
import { readFixture } from "./corpus-fixtures";

/**
 * Every `sql-compile` case that records a statement is run against the engine it is for, with its parameters bound, and the engine must accept the statement: a recorded text the engine rejects can never be pinned. The statement is run as `SELECT 1 FROM "subjects" WHERE <fragment>`, over a temporary `subjects` table made for the case from its own options: an `id` and one column for each single-segment column the options map, typed by its declared kind (and, for a column that declares none, by the first of text, number, boolean and timestamp that the engine accepts the statement with). The correlated `subject_tags` table is the fixture's.
 *
 * A name the table cannot hold, a dotted path or a table that is not the fixture's, is accepted when the engine gets as far as resolving it: PostgreSQL answers with the error classes for an undefined table, column or schema, and SQLite with "no such table" or "no such column", and no other error is accepted, so a syntax error, a bad cast, an invalid parameter or a regular expression the engine refuses fails the case. The execute cases run the identifier shapes against fixtures that do have them.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../../conformance/", import.meta.url),
);

/** The error classes of PostgreSQL that mean a name did not resolve, which the statement got past parsing to reach: undefined table, undefined column, invalid schema name. */
const POSTGRES_UNRESOLVED = new Set(["42P01", "42703", "3F000"]);
const SQLITE_UNRESOLVED = /^no such (?:table|column)\b/u;

const checked = checkCorpus(CORPUS_ROOT);
const cases = checked.files
  .flatMap(({ file }) => file.cases)
  .filter(
    (testCase): testCase is SqlCompileCase =>
      testCase.kind === "sql-compile" && "sql" in testCase.expect,
  );

function codeOf(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Outcome {
  readonly accepted: number;
  readonly unresolved: number;
  readonly failures: readonly string[];
}

/** The PostgreSQL type of each declared kind, and the order in which an undeclared column is tried. */
const POSTGRES_KINDS: Readonly<Record<string, string>> = {
  text: "text",
  number: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
};
const UNDECLARED_ORDER = ["text", "number", "boolean", "timestamp"] as const;
const NOT_TRIED = new Error("no kind was tried");

type Dialect = "postgres" | "sqlite";

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** The single-segment columns a case's options map, with the kind each declares or none. */
function mappedColumns(
  testCase: SqlCompileCase,
): readonly { readonly name: string; readonly kind: string | undefined }[] {
  const seen = new Map<string, string | undefined>();
  for (const binding of Object.values(testCase.options.columns ?? {})) {
    if (!binding.column.includes(".") && binding.column !== "id") {
      seen.set(binding.column, binding.paramType);
    }
  }

  return [...seen].map(([name, kind]) => ({ name, kind }));
}

/** Makes the case's temporary `subjects` table, runs its statement and drops the table; the error the statement raised, if any. */
async function attempt(
  engine: Readonly<Engine>,
  dialect: Dialect,
  testCase: SqlCompileCase,
  undeclared: string,
): Promise<unknown> {
  if (!("sql" in testCase.expect)) {
    return undefined;
  }
  const columns = mappedColumns(testCase).map(({ name, kind }) =>
    dialect === "sqlite"
      ? quote(name)
      : `${quote(name)} ${POSTGRES_KINDS[kind ?? undeclared] ?? "text"}`,
  );
  await engine.query(
    `CREATE TEMP TABLE "subjects" ("id" text${columns.map((column) => `, ${column}`).join("")})`,
    [],
  );
  try {
    await engine.query(
      `SELECT 1 FROM "subjects" WHERE ${testCase.expect.sql}`,
      testCase.expect.params.map((param) =>
        bindable(decodeNumbers(param.value)),
      ),
    );

    return undefined;
  } catch (error) {
    return error;
  } finally {
    await engine.query(
      `DROP TABLE ${dialect === "postgres" ? "pg_temp" : "temp"}."subjects"`,
      [],
    );
  }
}

/** The error of the last kind tried, or none when one of them was accepted: a kind is tried only after the one before it failed. */
async function firstAccepted(
  engine: Readonly<Engine>,
  dialect: Dialect,
  testCase: SqlCompileCase,
): Promise<unknown> {
  const hasUndeclared = mappedColumns(testCase).some(
    ({ kind }) => kind === undefined,
  );
  const kinds =
    dialect === "postgres" && hasUndeclared
      ? UNDECLARED_ORDER
      : [UNDECLARED_ORDER[0]];

  return kinds.reduce<Promise<unknown>>(
    async (previous, kind) =>
      (await previous) === undefined
        ? undefined
        : attempt(engine, dialect, testCase, kind),
    Promise.resolve(NOT_TRIED),
  );
}

/** Runs each case's statement on an engine and sorts the outcomes: run to the end, stopped at an unresolved name, or rejected. */
async function run(
  engine: Readonly<Engine>,
  dialect: Dialect,
  selected: readonly SqlCompileCase[],
  unresolved: (error: unknown) => boolean,
): Promise<Outcome> {
  const errors = await selected.reduce<Promise<(readonly [string, unknown])[]>>(
    async (previous, testCase) => [
      ...(await previous),
      [testCase.id, await firstAccepted(engine, dialect, testCase)] as const,
    ],
    Promise.resolve([]),
  );
  const failures = errors.filter(
    ([, error]) => error !== undefined && !unresolved(error),
  );

  return {
    accepted: errors.filter(([, error]) => error === undefined).length,
    unresolved: errors.filter(
      ([, error]) => error !== undefined && unresolved(error),
    ).length,
    failures: failures.map(([id, error]) => `${id}: ${messageOf(error)}`),
  };
}

let container: StartedPostgreSqlContainer;
let postgres: Engine;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  postgres = await openPostgres(
    container.getConnectionUri(),
    readFixture("subjects"),
  );
});

afterAll(async () => {
  await postgres.close();
  await container.stop();
});

/**
 * A text parameter that holds a NUL is rejected by PostgreSQL when the statement runs ("invalid byte sequence"), and the compiler does not refuse it yet; the corpus records the statements until the compiler does, so the check leaves them out and says so. Its removal comes with the compiler change that refuses such a value.
 */
function holdsNul(testCase: SqlCompileCase): boolean {
  return (
    "sql" in testCase.expect &&
    testCase.expect.params.some(
      (param) =>
        typeof param.value === "string" && param.value.includes("\u0000"),
    )
  );
}

describe("the statements the compile cases record are accepted by their engine", () => {
  it("runs every recorded PostgreSQL statement, and the ones with a NUL are the ones it leaves out", async () => {
    const forPostgres = cases.filter(
      (testCase) => testCase.options.dialect === "postgres",
    );
    const selected = forPostgres.filter((testCase) => !holdsNul(testCase));
    const outcome = await run(postgres, "postgres", selected, (error) =>
      POSTGRES_UNRESOLVED.has(codeOf(error) ?? ""),
    );
    expect(outcome.failures).toEqual([]);
    expect(outcome.accepted + outcome.unresolved).toBe(selected.length);
    expect(outcome.accepted).toBeGreaterThan(0);
    expect(forPostgres.length - selected.length).toBeGreaterThan(0);
  });

  it("runs every recorded SQLite statement", async () => {
    const selected = cases.filter(
      (testCase) => testCase.options.dialect === "sqlite",
    );
    const engine = openSqlite(readFixture("subjects"), true);
    try {
      const outcome = await run(engine, "sqlite", selected, (error) =>
        SQLITE_UNRESOLVED.test(messageOf(error)),
      );
      expect(outcome.failures).toEqual([]);
      expect(outcome.accepted + outcome.unresolved).toBe(selected.length);
      expect(outcome.accepted).toBeGreaterThan(0);
    } finally {
      await engine.close();
    }
  });
});
