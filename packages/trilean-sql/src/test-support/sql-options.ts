import type {
  SqlCollectionBinding,
  SqlColumnBinding,
  SqlCompileOptions,
} from "../options";
import type { SqlColumnsData, SqlOptionsData } from "./corpus-types";

/**
 * What the options' callbacks did during one operation, so a case can assert that an exception the caller's callback threw reaches the caller unchanged and how often the top-level `columnFor` was asked.
 */
export interface CallbackLog {
  /** Every error a callback threw, in order. */
  readonly thrown: unknown[];
  /** The keys the top-level `columnFor` was given, in order. */
  readonly columnKeys: string[];
}

function columnLookup(
  columns: SqlColumnsData | undefined,
  log: CallbackLog,
  record: boolean,
): (referenceKey: string) => SqlColumnBinding {
  return (referenceKey) => {
    if (record) {
      log.columnKeys.push(referenceKey);
    }
    const binding =
      columns !== undefined && Object.hasOwn(columns, referenceKey)
        ? columns[referenceKey]
        : undefined;
    if (binding === undefined) {
      const error = new Error(
        `no column mapped for reference key '${referenceKey}'`,
      );
      log.thrown.push(error);
      throw error;
    }

    return binding.paramType === undefined
      ? { column: binding.column }
      : { column: binding.column, paramType: binding.paramType };
  };
}

/** The compile options a case's data denotes, with the callbacks the README defines: a key the map lacks makes the callback throw. */
export function buildOptions(
  data: SqlOptionsData & { readonly dialect: string },
  log: CallbackLog,
): SqlCompileOptions {
  const { collections } = data;
  const options: SqlCompileOptions = {
    dialect: "postgres",
    columnFor: columnLookup(data.columns, log, true),
    ...(data.postgresRegexpPushdown !== undefined && {
      postgresRegexpPushdown: data.postgresRegexpPushdown,
    }),
    ...(data.sqliteRegexpAvailable !== undefined && {
      sqliteRegexpAvailable: data.sqliteRegexpAvailable,
    }),
  };
  // The corpus names a dialect the package does not implement on purpose (an UnknownDialectError case), which the type's union cannot name, so the name is set reflectively, as a caller reading a configuration string would reach it.
  Reflect.set(options, "dialect", data.dialect);
  if (collections === undefined) {
    return options;
  }

  return {
    ...options,
    collectionFor: (collectionKey): SqlCollectionBinding => {
      const binding = Object.hasOwn(collections, collectionKey)
        ? collections[collectionKey]
        : undefined;
      if (binding === undefined) {
        const error = new Error(
          `no collection mapped for collection key '${collectionKey}'`,
        );
        log.thrown.push(error);
        throw error;
      }

      return {
        table: binding.table,
        join: binding.join,
        columnFor: columnLookup(binding.columns, log, false),
      };
    },
  };
}
