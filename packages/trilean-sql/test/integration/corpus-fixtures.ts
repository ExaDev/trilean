import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFixture } from "../../src/test-support/fixture";
import type {
  CellValue,
  ColumnType,
  FixtureFile,
} from "../../src/test-support/fixture";
import { readJson } from "../../src/test-support/read-json";

/**
 * The tables a `sql-execute` case runs against, read from `conformance/trilean-sql/execute/fixtures/<name>.json` and validated by `src/test-support/fixture.ts`. The format is described in `conformance/README.md`.
 */

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
  readonly evaluator: FixtureFile["evaluator"];
}

export const FIXTURE_DIRECTORY = fileURLToPath(
  new URL(
    "../../../../conformance/trilean-sql/execute/fixtures/",
    import.meta.url,
  ),
);

/** The names of the fixture files, without their extension. */
export function fixtureNames(): readonly string[] {
  return readdirSync(FIXTURE_DIRECTORY)
    .map((name) => {
      if (!name.endsWith(".json")) {
        throw new Error(`${name} is not a fixture file`);
      }

      return name.slice(0, -".json".length);
    })
    .sort();
}

/** Reads one fixture by name, refusing one that does not validate. */
export function readFixture(name: string): FixtureData {
  const result = validateFixture(
    readJson(join(FIXTURE_DIRECTORY, `${name}.json`)),
  );
  if (!result.ok) {
    throw new Error(`fixture ${name}:\n${result.problems.join("\n")}`);
  }
  const { value } = result;

  return {
    evaluator: value.evaluator,
    tables: Object.entries(value.tables).map(([tableName, table]) => ({
      name: tableName,
      columns: Object.entries(table.columns).map(([columnName, type]) => ({
        name: columnName,
        type,
      })),
      primaryKey: table.primaryKey,
      rows: table.rows,
    })),
  };
}
