import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { Validation } from "./validate";

/**
 * The fixture a `sql-execute` case runs against, validated against `conformance/trilean-sql/execute/schema/fixture.schema.json` and the rules a schema cannot express, which `conformance/README.md` lists: a cell has the type of its column, a row names only columns of its table, a primary key is a column whose values are present and distinct, and the evaluator's table, id column, foreign keys and item columns exist.
 */

export type ColumnType = "text" | "number" | "boolean" | "timestamp";

export type CellValue = string | number | boolean | null;

export interface FixtureTable {
  readonly columns: Readonly<Record<string, ColumnType>>;
  readonly primaryKey: string;
  readonly rows: readonly Readonly<Record<string, CellValue>>[];
}

export interface FixtureFile {
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
  readonly tables: Readonly<Record<string, FixtureTable>>;
}

let compiled: ValidateFunction<FixtureFile> | undefined;

function schemaValidator(): ValidateFunction<FixtureFile> {
  if (compiled === undefined) {
    const parsed: unknown = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../conformance/trilean-sql/execute/schema/fixture.schema.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("the fixture schema must be an object");
    }
    compiled = new Ajv2020({
      allErrors: true,
      strict: true,
    }).compile<FixtureFile>(Object.fromEntries(Object.entries(parsed)));
  }

  return compiled;
}

function cellFits(type: ColumnType, cell: CellValue): boolean {
  if (cell === null) {
    return true;
  }

  return type === "number"
    ? typeof cell === "number"
    : type === "boolean"
      ? typeof cell === "boolean"
      : typeof cell === "string";
}

function ruleProblems(file: FixtureFile): readonly string[] {
  const problems: string[] = [];
  for (const [name, table] of Object.entries(file.tables)) {
    if (!Object.hasOwn(table.columns, table.primaryKey)) {
      problems.push(
        `${name}: the primary key ${table.primaryKey} is not a column`,
      );
    }
    const keys = new Set<CellValue>();
    for (const [index, row] of table.rows.entries()) {
      for (const [column, cell] of Object.entries(row)) {
        const type = Object.hasOwn(table.columns, column)
          ? table.columns[column]
          : undefined;
        if (type === undefined) {
          problems.push(
            `${name} row ${String(index)}: ${column} is not a column`,
          );
        } else if (!cellFits(type, cell)) {
          problems.push(
            `${name} row ${String(index)}: ${column} is not a ${type}`,
          );
        }
      }
      const key = row[table.primaryKey] ?? null;
      if (key === null || keys.has(key)) {
        problems.push(
          `${name} row ${String(index)}: the primary key is unknown or repeated`,
        );
      }
      keys.add(key);
    }
  }
  const { evaluator } = file;
  const subject = Object.hasOwn(file.tables, evaluator.table)
    ? file.tables[evaluator.table]
    : undefined;
  if (subject === undefined) {
    problems.push(`the evaluator's table ${evaluator.table} does not exist`);
  } else if (!Object.hasOwn(subject.columns, evaluator.idColumn)) {
    problems.push(
      `the id column ${evaluator.idColumn} is not a column of ${evaluator.table}`,
    );
  }
  for (const [key, collection] of Object.entries(evaluator.collections)) {
    const child = Object.hasOwn(file.tables, collection.table)
      ? file.tables[collection.table]
      : undefined;
    if (child === undefined) {
      problems.push(
        `collection ${key}: the table ${collection.table} does not exist`,
      );
      continue;
    }
    for (const column of [collection.foreignKey, ...collection.items]) {
      if (!Object.hasOwn(child.columns, column)) {
        problems.push(
          `collection ${key}: ${column} is not a column of ${collection.table}`,
        );
      }
    }
  }

  return problems;
}

/** Validates a parsed fixture by the schema and then by the rules; the rules read only a value the schema accepted. */
export function validateFixture(value: unknown): Validation<FixtureFile> {
  const check = schemaValidator();
  if (!check(value)) {
    return {
      ok: false,
      problems: (check.errors ?? []).map(
        ({ instancePath, message }) =>
          `${instancePath === "" ? "(root)" : instancePath} ${message ?? "is invalid"}`,
      ),
    };
  }
  const problems = ruleProblems(value);

  return problems.length === 0 ? { ok: true, value } : { ok: false, problems };
}
