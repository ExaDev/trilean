import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../../src/test-support/read-json";

/**
 * The tables a `sql-execute` case runs against, read from `conformance/trilean-sql/execute/fixtures/<name>.json`. The shape is described in `conformance/README.md`; the file is not a corpus file, so no schema validates it and the reader below checks what it uses.
 */

export type ColumnType = "text" | "number" | "boolean" | "timestamp";

export type CellValue = string | number | boolean | null;

export interface TableData {
  readonly name: string;
  readonly columns: readonly {
    readonly name: string;
    readonly type: ColumnType;
  }[];
  readonly primaryKey: string;
  readonly rows: readonly Readonly<Record<string, CellValue>>[];
}

export interface FixtureData {
  readonly tables: readonly TableData[];
  readonly evaluator: {
    readonly table: string;
    readonly idColumn: string;
    readonly collections: Readonly<
      Record<
        string,
        {
          readonly table: string;
          readonly foreignKey: string;
          readonly items: readonly string[];
        }
      >
    >;
  };
}

const FIXTURE_DIRECTORY = fileURLToPath(
  new URL(
    "../../../../conformance/trilean-sql/execute/fixtures/",
    import.meta.url,
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object`);
  }

  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new Error(`${where} must be a string`);
  }

  return value;
}

function columnType(value: unknown, where: string): ColumnType {
  if (
    value === "text" ||
    value === "number" ||
    value === "boolean" ||
    value === "timestamp"
  ) {
    return value;
  }
  throw new Error(`${where} must be a column type`);
}

function cell(value: unknown, where: string): CellValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  throw new Error(`${where} must be a text, number, boolean or null`);
}

function stringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be a list`);
  }

  return value.map((item: unknown) => text(item, where));
}

/** Reads one fixture by name. */
export function readFixture(name: string): FixtureData {
  const where = `fixture ${name}`;
  const document = record(
    readJson(join(FIXTURE_DIRECTORY, `${name}.json`)),
    where,
  );
  const tables = Object.entries(record(document.tables, `${where}.tables`)).map(
    ([tableName, raw]): TableData => {
      const table = record(raw, `${where}.tables.${tableName}`);
      const columns = Object.entries(
        record(table.columns, `${where}.tables.${tableName}.columns`),
      ).map(([columnName, type]) => ({
        name: columnName,
        type: columnType(type, `${where}.${tableName}.${columnName}`),
      }));
      const rows = table.rows;
      if (!Array.isArray(rows)) {
        throw new Error(`${where}.tables.${tableName}.rows must be a list`);
      }

      return {
        name: tableName,
        columns,
        primaryKey: text(table.primaryKey, `${where}.${tableName}.primaryKey`),
        rows: rows.map((row: unknown) =>
          Object.fromEntries(
            Object.entries(record(row, `${where}.${tableName} row`)).map(
              ([key, value]) => [
                key,
                cell(value, `${where}.${tableName}.${key}`),
              ],
            ),
          ),
        ),
      };
    },
  );
  const evaluator = record(document.evaluator, `${where}.evaluator`);

  return {
    tables,
    evaluator: {
      table: text(evaluator.table, `${where}.evaluator.table`),
      idColumn: text(evaluator.idColumn, `${where}.evaluator.idColumn`),
      collections: Object.fromEntries(
        Object.entries(
          record(evaluator.collections, `${where}.evaluator.collections`),
        ).map(([key, raw]) => {
          const collection = record(
            raw,
            `${where}.evaluator.collections.${key}`,
          );

          return [
            key,
            {
              table: text(
                collection.table,
                `${where}.collections.${key}.table`,
              ),
              foreignKey: text(
                collection.foreignKey,
                `${where}.collections.${key}.foreignKey`,
              ),
              items: stringList(
                collection.items,
                `${where}.collections.${key}.items`,
              ),
            },
          ];
        }),
      ),
    },
  };
}
