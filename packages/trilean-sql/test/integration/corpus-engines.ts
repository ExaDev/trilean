import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import type {
  ComputedValue,
  JsonValue,
  PredicateNode,
  Resolution,
  Resolvers,
} from "trilean";
import { evaluatePredicate } from "trilean";
import type { CellValue, ColumnType } from "../../src/test-support/fixture";
import type { FixtureData, TableData } from "./corpus-fixtures";

/**
 * The two engines the `sql-execute` cases run against, and the evaluator bridge that gives trilean's own evaluator exactly the knowledge the engine has about a row. Both are described in `conformance/README.md`.
 */

export type Rows = readonly (readonly unknown[])[];

/** The rows of a query read in array mode, each checked to be an array. */
function arrayRows(rows: readonly unknown[]): Rows {
  return rows.map((row) => {
    if (!Array.isArray(row)) {
      throw new Error("a row read in array mode must be an array");
    }

    return row.map((cell: unknown) => cell);
  });
}

export interface Engine {
  query: (sql: string, params: readonly unknown[]) => Promise<Rows>;
  close: () => Promise<void>;
}

const SQLITE_TYPES: Readonly<Record<ColumnType, string>> = {
  any: "",
  text: "TEXT",
  number: "REAL",
  boolean: "INTEGER",
  timestamp: "TEXT",
};

const POSTGRES_TYPES: Readonly<Record<ColumnType, string>> = {
  any: "",
  text: "text",
  number: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
};

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createStatement(
  table: TableData,
  types: Readonly<Record<ColumnType, string>>,
): string {
  const columns = table.columns.map(({ name, type }) => {
    if (type === "any" && types === POSTGRES_TYPES) {
      throw new Error(
        `${table.name}.${name} is of kind any, which only SQLite can hold`,
      );
    }

    return `${quote(name)} ${types[type]}${name === table.primaryKey ? " PRIMARY KEY" : ""}`.trimEnd();
  });

  return `CREATE TABLE ${quote(table.name)} (${columns.join(", ")})`;
}

/** An INSERT of `rowCount` rows, the placeholders numbered in row order. */
function insertStatement(
  table: TableData,
  placeholder: (index: number) => string,
  rowCount: number,
): string {
  const names = table.columns.map(({ name }) => quote(name)).join(", ");
  const width = table.columns.length;
  const rows = Array.from(
    { length: rowCount },
    (_, row) =>
      `(${table.columns.map((_column, column) => placeholder(row * width + column + 1)).join(", ")})`,
  );

  return `INSERT INTO ${quote(table.name)} (${names}) VALUES ${rows.join(", ")}`;
}

/** SQLite has no boolean type and better-sqlite3 refuses a JavaScript boolean as a bound parameter, so the caller binding a compiled fragment converts one to the integer 0 or 1, as `README.md` documents. */
export function bindable(value: unknown): unknown {
  if (isPlainRecord(value) && typeof value.blob === "string") {
    return Buffer.from(value.blob, "utf8");
  }

  return typeof value === "boolean" ? Number(value) : value;
}

/** An in-memory SQLite connection holding the fixture, with the `regexp` function registered unless the case says otherwise. */
export function openSqlite(
  fixture: FixtureData,
  regexpFunction: boolean,
): Engine {
  const db = new Database(":memory:");
  if (regexpFunction) {
    // SQLite reserves REGEXP as syntax for a function the connection registers. It answers NULL when either argument is not a text, so a NULL operand stays unknown under a negated match, and 1 or 0 otherwise, since better-sqlite3 refuses a JavaScript boolean from a user function.
    db.function("regexp", (pattern: unknown, text: unknown) =>
      typeof pattern !== "string" || typeof text !== "string"
        ? null
        : new RegExp(pattern).test(text)
          ? 1
          : 0,
    );
  }
  for (const table of fixture.tables) {
    db.exec(createStatement(table, SQLITE_TYPES));
    db.prepare(insertStatement(table, () => "?", table.rows.length)).run(
      ...table.rows.flatMap((row) =>
        table.columns.map(({ name }) => bindable(row[name] ?? null)),
      ),
    );
  }

  return {
    query: async (sql, params) => {
      const statement = db.prepare<unknown[], unknown[]>(sql);
      const bound = params.map(bindable);
      if (!statement.reader) {
        statement.run(...bound);

        return Promise.resolve([]);
      }

      return Promise.resolve(arrayRows(statement.raw().all(...bound)));
    },
    close: async () => {
      db.close();

      return Promise.resolve();
    },
  };
}

/** A connected PostgreSQL client holding the fixture. */
export async function openPglite(fixture: FixtureData): Promise<Engine> {
  // PGlite is PostgreSQL itself compiled to WebAssembly and run in this process, so each fixture gets its own in-memory database with no server, port or container.
  const db = new PGlite();
  // A connection runs one query at a time, so the tables are created and filled one after another, each filled by a single statement.
  await fixture.tables.reduce(async (previous, table) => {
    await previous;
    await db.query(createStatement(table, POSTGRES_TYPES));
    await db.query(
      insertStatement(table, (index) => `$${String(index)}`, table.rows.length),
      table.rows.flatMap((row) =>
        table.columns.map(({ name }) => row[name] ?? null),
      ),
    );
  }, Promise.resolve());

  return {
    query: async (sql, params) => {
      const result = await db.query(sql, [...params], { rowMode: "array" });

      return arrayRows(result.rows);
    },
    close: async () => db.close(),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A computed value for a cell of a column of the given type, or none when the cell is NULL: a NULL means the same as a reference that resolves to nothing, the value is not known. */
function computedFor(
  type: ColumnType,
  cell: CellValue,
): ComputedValue | undefined {
  if (cell === null) {
    return undefined;
  }
  if (type === "number" && typeof cell === "number") {
    return { kind: "number", value: cell };
  }
  if (type === "boolean" && typeof cell === "boolean") {
    return { kind: "boolean", value: cell };
  }
  if ((type === "timestamp" || type === "any") && typeof cell === "string") {
    return { kind: "instant", value: cell };
  }
  if (type === "text" && typeof cell === "string") {
    return { kind: "text", value: cell };
  }

  return undefined;
}

/** Whether an item's value is the computed value its cell was read as: items are given to the evaluator already typed by their column. */
function isComputed(value: unknown): value is ComputedValue {
  return isPlainRecord(value) && typeof value.kind === "string";
}

function tableOf(fixture: FixtureData, name: string): TableData {
  const found = fixture.tables.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`the fixture has no table ${name}`);
  }

  return found;
}

/**
 * Resolves a reference key against one row of the evaluator's table, mapping a NULL cell to `found: false`, and a reference inside a `some`, `every` or `fold` item against the item alone (a plain record of the child row's item columns). A collection key names a child table whose rows hold the foreign key of the row's id.
 */
function resolversFor(
  fixture: FixtureData,
  row: Readonly<Record<string, CellValue>>,
): Resolvers {
  const subject = tableOf(fixture, fixture.evaluator.table);
  const id = row[fixture.evaluator.idColumn];

  return {
    resolveValue: async (key: JsonValue, context: unknown) => {
      if (context !== undefined) {
        if (typeof key !== "string" || !isPlainRecord(context)) {
          return Promise.resolve<Resolution>({ found: false });
        }
        const value = Object.hasOwn(context, key) ? context[key] : undefined;

        return Promise.resolve<Resolution>(
          isComputed(value) ? { found: true, value } : { found: false },
        );
      }
      const column =
        typeof key === "string"
          ? subject.columns.find(
              ({ name }) => name === key && name !== fixture.evaluator.idColumn,
            )
          : undefined;
      const value =
        column === undefined
          ? undefined
          : computedFor(column.type, row[column.name] ?? null);

      return Promise.resolve<Resolution>(
        value === undefined ? { found: false } : { found: true, value },
      );
    },
    resolveLookup: () => {
      throw new Error("no tree in this suite uses a lookup");
    },
    resolveCollection: async (collection: JsonValue) => {
      const binding =
        typeof collection === "string" &&
        Object.hasOwn(fixture.evaluator.collections, collection)
          ? fixture.evaluator.collections[collection]
          : undefined;
      if (binding === undefined) {
        return Promise.resolve([]);
      }

      return Promise.resolve(
        (() => {
          const child = tableOf(fixture, binding.table);
          const typeOf = (item: string): ColumnType =>
            child.columns.find(({ name }) => name === item)?.type ?? "any";

          return child.rows
            .filter((candidate) => candidate[binding.foreignKey] === id)
            .map((candidate) =>
              Object.fromEntries(
                binding.items.map((item) => [
                  item,
                  computedFor(typeOf(item), candidate[item] ?? null) ?? null,
                ]),
              ),
            );
        })(),
      );
    },
  };
}

/** Sets the time zone of the process and returns the function that puts the previous one back. */
export function setZone(zone: string): () => void {
  const before = process.env.TZ;
  process.env.TZ = zone;

  return () => {
    if (before === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = before;
    }
  };
}

/** The evaluations waiting for the zone: each starts when the one before it has finished and put the zone back, so the zone, which belongs to the whole process, is never changed under an evaluation that is running. */
let evaluationQueue: Promise<unknown> = Promise.resolve();

let running = 0;
let mostRunningAtOnce = 0;

/** The most evaluations that were running at the same moment, which is one whenever they are serialised. */
export function mostEvaluationsAtOnce(): number {
  return mostRunningAtOnce;
}

/**
 * Runs `run` with the process time zone set to UTC, after every evaluation started before it has finished. The evaluator reads a stored instant that carries no zone (`2020-01-01T00:00:00`) through `Date.parse`, which reads it in the zone of the process, so the ids it selects over such a value depend on the machine unless the zone is fixed. The corpus fixes it to UTC for every evaluation, whatever zone the host or the caller is in, and one evaluation at a time, since the zone is a property of the process and not of the call.
 */
async function inUtc<T>(run: () => Promise<T>): Promise<T> {
  const turn = evaluationQueue.then(async () => {
    const restore = setZone("UTC");
    running += 1;
    mostRunningAtOnce = Math.max(mostRunningAtOnce, running);
    try {
      return await run();
    } finally {
      running -= 1;
      restore();
    }
  });
  evaluationQueue = turn.catch(() => undefined);

  return turn;
}

/** The ids of the rows for which the evaluator is definitely true, sorted, in UTC. */
export async function evaluatorRows(
  fixture: FixtureData,
  tree: PredicateNode,
): Promise<readonly string[]> {
  const subject = tableOf(fixture, fixture.evaluator.table);
  const evaluations = await inUtc(async () =>
    Promise.all(
      subject.rows.map(async (row) =>
        evaluatePredicate(tree, undefined, resolversFor(fixture, row)),
      ),
    ),
  );
  const matched = subject.rows.flatMap((row, index) => {
    const evaluation = evaluations[index];
    const id = row[fixture.evaluator.idColumn];
    if (evaluation?.status !== "definite" || !evaluation.value) {
      return [];
    }
    if (typeof id !== "string") {
      throw new Error("a row's id must be a text");
    }

    return [id];
  });

  return matched.sort();
}
