import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compilePredicateNode } from "../../src/compile";
import {
  checkCorpus,
  collect,
  completenessProblems,
} from "../../src/test-support/corpus";
import type { SqlExecuteCase, Text } from "../../src/test-support/corpus-types";
import { decodeNumbers } from "../../src/test-support/numbers";
import { readJson } from "../../src/test-support/read-json";
import { treeOf } from "../../src/test-support/run-sql";
import { buildOptions } from "../../src/test-support/sql-options";
import type { CallbackLog } from "../../src/test-support/sql-options";
import { textToString } from "../../src/test-support/text";
import { validateManifest } from "../../src/test-support/validate";
import {
  bindable,
  evaluatorRows,
  openPostgres,
  openSqlite,
} from "./corpus-engines";
import type { Engine } from "./corpus-engines";
import { readFixture } from "./corpus-fixtures";

/**
 * Runs the `execute` directory of this package's share of the language-neutral conformance corpus (`conformance/trilean-sql/execute/`) against real engines: SQLite in memory, and PostgreSQL in an ephemeral container, which needs a Docker-compatible daemon, as the integration suite always has. A case compiles its tree for its dialect, runs the fragment over the fixture's rows and requires the rows to be the ones it states and to be the rows trilean's evaluator selects over the same fixture; the other forms are in `conformance/README.md`.
 */

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../../conformance/", import.meta.url),
);
const SHARE = "trilean-sql/execute/";

const checked = checkCorpus(CORPUS_ROOT);
if (checked.problems.length > 0) {
  throw new Error(`the corpus is malformed:\n${checked.problems.join("\n")}`);
}
const corpus = checked.files.filter(({ name }) => name.startsWith(SHARE));

// What this run registers, computed while the tests are collected, so the completeness check below holds whatever the run does with them afterwards.
const { registered, skipped } = collect(corpus);
const registeredIds = new Set(registered);

let container: StartedPostgreSqlContainer;
const postgresEngines = new Map<string, Engine>();

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  // A fixture's tables are created in the one database, so two fixtures must not share a table name.
  const fixtures = new Set(
    corpus.flatMap(({ file }) =>
      file.cases.flatMap((testCase) =>
        testCase.kind === "sql-execute" && testCase.dialect === "postgres"
          ? [testCase.fixture]
          : [],
      ),
    ),
  );
  await Promise.all(
    [...fixtures].map(async (name) => {
      postgresEngines.set(
        name,
        await openPostgres(container.getConnectionUri(), readFixture(name)),
      );
    }),
  );
});

afterAll(async () => {
  await Promise.all(
    [...postgresEngines.values()].map(async (engine) => engine.close()),
  );
  await container.stop();
});

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Whether the fragments occur in the message, each after the end of the one before, without regard to the case of the ASCII letters. */
function containsInOrder(message: string, fragments: readonly Text[]): boolean {
  const lower = message.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  let from = 0;
  for (const fragment of fragments) {
    const wanted = textToString(fragment).replace(/[A-Z]/gu, (letter) =>
      letter.toLowerCase(),
    );
    const found = lower.indexOf(wanted, from);
    if (found < 0) {
      return false;
    }
    from = found + wanted.length;
  }

  return true;
}

async function attempt<T>(
  run: () => Promise<T>,
): Promise<{ readonly rows: T } | { readonly error: string }> {
  try {
    return { rows: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function runCase(testCase: SqlExecuteCase): Promise<void> {
  if (
    ("sql" in testCase.run || testCase.run.options === undefined) &&
    (testCase.expectSql !== undefined ||
      testCase.expectTableCounts !== undefined)
  ) {
    throw new Error(
      "only a compiled tree has a text and table counts to check",
    );
  }
  if (testCase.connection !== undefined && testCase.dialect !== "sqlite") {
    throw new Error("only a SQLite connection is prepared by the case");
  }
  const fixture = readFixture(testCase.fixture);
  const engine =
    testCase.dialect === "sqlite"
      ? openSqlite(fixture, testCase.connection?.regexpFunction !== false)
      : postgresEngines.get(testCase.fixture);
  if (engine === undefined) {
    throw new Error(`no engine for the fixture ${testCase.fixture}`);
  }
  try {
    const { run, expect: expected } = testCase;
    if ("sql" in run) {
      const outcome = await attempt(async () =>
        engine.query(run.sql, run.params.map(decodeNumbers)),
      );
      if ("queryError" in expected) {
        expect(outcome, "the statement must fail").toHaveProperty("error");
        if ("error" in outcome) {
          expect(containsInOrder(outcome.error, expected.queryError)).toBe(
            true,
          );
        }
      } else if ("result" in expected) {
        expect(outcome).toEqual({ rows: decodeNumbers(expected.result) });
      } else {
        throw new Error("a statement's expectation is a result or an error");
      }

      return;
    }
    const tree = treeOf(run.tree);
    if (!("rows" in expected) && !("queryError" in expected)) {
      throw new Error("a tree's expectation is rows or an error");
    }
    if (run.options === undefined) {
      if (!("rows" in expected)) {
        throw new Error("a tree that is only evaluated expects rows");
      }
      expect(await evaluatorRows(fixture, tree)).toEqual(expected.rows);

      return;
    }
    const log: CallbackLog = { thrown: [], columnKeys: [] };
    const compiled = compilePredicateNode(
      tree,
      buildOptions({ ...run.options, dialect: testCase.dialect }, log),
    );
    if (testCase.expectSql !== undefined) {
      expect(compiled.sql).toBe(testCase.expectSql);
    }
    const { table, idColumn } = fixture.evaluator;
    const outcome = await attempt(async () =>
      engine.query(
        `SELECT ${quote(idColumn)} FROM ${quote(table)} WHERE ${compiled.sql} ORDER BY ${quote(idColumn)}`,
        compiled.params.map(bindable),
      ),
    );
    if ("queryError" in expected) {
      expect(outcome, "the query must fail").toHaveProperty("error");
      if ("error" in outcome) {
        expect(containsInOrder(outcome.error, expected.queryError)).toBe(true);
      }
    } else if ("rows" in expected) {
      expect(outcome).toHaveProperty("rows");
      if ("rows" in outcome) {
        expect(outcome.rows.map((row) => row[0])).toEqual(expected.rows);
      }
      expect(await evaluatorRows(fixture, tree)).toEqual(expected.rows);
    }
    const counts = Object.entries(testCase.expectTableCounts ?? {});
    const counted = await Promise.all(
      counts.map(async ([name]) => {
        const rows = await engine.query(
          `SELECT count(*) FROM ${quote(name)}`,
          [],
        );

        return Number(rows[0]?.[0]);
      }),
    );
    expect(counted).toEqual(counts.map(([, count]) => count));
  } finally {
    if (testCase.dialect === "sqlite") {
      await engine.close();
    }
  }
}

for (const { name, file } of corpus) {
  describe(`conformance ${name}`, () => {
    for (const testCase of file.cases) {
      it.skipIf(!registeredIds.has(testCase.id))(
        `${testCase.id} (${testCase.from})`,
        async () => {
          if (testCase.kind !== "sql-execute") {
            throw new Error(
              `no executor for the ${testCase.kind} kind in this runner`,
            );
          }
          await runCase(testCase);
        },
      );
    }
  });
}

describe("corpus completeness", () => {
  it("registers and skips cases so that they add up to the manifest's share for this runner", () => {
    const manifest = validateManifest(
      readJson(join(CORPUS_ROOT, "manifest.json")),
    );
    if (!manifest.ok) {
      throw new Error(manifest.problems.join("\n"));
    }
    const entries = Object.entries(manifest.value.files)
      .filter(([name]) => name.startsWith(SHARE))
      .map(([, entry]) => entry);
    expect(
      entries.length,
      "the manifest lists no file for this runner",
    ).toBeGreaterThan(0);
    expect(
      completenessProblems(
        entries.reduce((sum, entry) => sum + entry.cases, 0),
        new Set(entries.flatMap((entry) => entry.skip)),
        registered,
        skipped,
      ),
    ).toEqual([]);
  });
});
