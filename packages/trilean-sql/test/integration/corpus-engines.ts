import Database from "better-sqlite3";
import pg from "pg";
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
  text: "TEXT",
  number: "REAL",
  boolean: "INTEGER",
  timestamp: "TEXT",
};

const POSTGRES_TYPES: Readonly<Record<ColumnType, string>> = {
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
  const columns = table.columns.map(
    ({ name, type }) =>
      `${quote(name)} ${types[type]}${name === table.primaryKey ? " PRIMARY KEY" : ""}`,
  );

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
    query: async (sql, params) =>
      Promise.resolve(
        arrayRows(
          db
            .prepare<unknown[], unknown[]>(sql)
            .raw()
            .all(...params.map(bindable)),
        ),
      ),
    close: async () => {
      db.close();

      return Promise.resolve();
    },
  };
}

/** A connected PostgreSQL client holding the fixture. */
export async function openPostgres(
  connectionString: string,
  fixture: FixtureData,
): Promise<Engine> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  // A client runs one query at a time, so the tables are created and filled one after another, each filled by a single statement.
  await fixture.tables.reduce(async (previous, table) => {
    await previous;
    await client.query(createStatement(table, POSTGRES_TYPES));
    await client.query(
      insertStatement(table, (index) => `$${String(index)}`, table.rows.length),
      table.rows.flatMap((row) =>
        table.columns.map(({ name }) => row[name] ?? null),
      ),
    );
  }, Promise.resolve());

  return {
    query: async (sql, params) => {
      const result = await client.query({
        text: sql,
        values: [...params],
        rowMode: "array",
      });

      return arrayRows(result.rows);
    },
    close: async () => client.end(),
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
  if (type === "timestamp" && typeof cell === "string") {
    return { kind: "instant", value: cell };
  }
  if (type === "text" && typeof cell === "string") {
    return { kind: "text", value: cell };
  }

  return undefined;
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
        if (typeof value === "number") {
          return Promise.resolve<Resolution>({
            found: true,
            value: { kind: "number", value },
          });
        }
        if (typeof value === "string") {
          return Promise.resolve<Resolution>({
            found: true,
            value: { kind: "text", value },
          });
        }

        return Promise.resolve<Resolution>({ found: false });
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
        tableOf(fixture, binding.table)
          .rows.filter((child) => child[binding.foreignKey] === id)
          .map((child) =>
            Object.fromEntries(
              binding.items.map((item) => [item, child[item] ?? null]),
            ),
          ),
      );
    },
  };
}

/** The ids of the rows for which the evaluator is definitely true, sorted. */
export async function evaluatorRows(
  fixture: FixtureData,
  tree: PredicateNode,
): Promise<readonly string[]> {
  const subject = tableOf(fixture, fixture.evaluator.table);
  const evaluations = await Promise.all(
    subject.rows.map(async (row) =>
      evaluatePredicate(tree, undefined, resolversFor(fixture, row)),
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
