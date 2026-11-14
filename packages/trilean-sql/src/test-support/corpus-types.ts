import type { JsonValue } from "trilean";

/**
 * The shapes of the corpus cases this package executes, plus the kinds it validates against the schema but leaves to the package that owns them. `case.schema.json` is the definition; these types state what a document that passed it holds, so a value is trusted only after the schema has accepted it.
 */

/** The case kinds the unit runner executes. */
export const EXECUTED_KINDS = [
  "sql-compile",
  "sql-guard",
  "sql-pattern",
] as const;

/** The case kind the integration runner executes against real engines. */
export const ENGINE_KINDS = ["sql-execute"] as const;

/** The case kinds that belong to other packages: validated by the schema, never executed here. */
export const FOREIGN_KINDS = [
  "regex-parse",
  "regex-match",
  "validate",
  "build",
  "call",
  "evaluate",
  "inputs",
  "document",
  "cli",
  "serialise",
  "number-format",
] as const;

/** The values of `skip`: the implementation that skips a case, never the host it runs on. */
export const SKIP_VALUES = ["ts", "rust"] as const;

/** A string as UTF-16 code units: a JSON string, or the code units themselves for content a JSON string cannot carry. */
export type Text = string | { readonly codeUnits: readonly number[] };

export type Json = JsonValue;

interface CaseBase {
  readonly id: string;
  readonly from: string;
  readonly skip?: (typeof SKIP_VALUES)[number];
  readonly reason?: string;
  readonly tolerance?: {
    readonly ulps?: number;
    readonly absolute?: number;
  };
}

export type SqlParamType = "text" | "number" | "boolean" | "timestamp";

export interface SqlColumnData {
  readonly column: string;
  readonly paramType?: SqlParamType;
}

export type SqlColumnsData = Readonly<Record<string, SqlColumnData>>;

export interface SqlCollectionData {
  readonly table: string;
  readonly join: string;
  readonly columns: SqlColumnsData;
}

/** The options of a compilation as data: the callbacks are built from the two maps, and `collections` present, even empty, means `collectionFor` is supplied. */
export interface SqlOptionsData {
  readonly columns?: SqlColumnsData;
  readonly collections?: Readonly<Record<string, SqlCollectionData>>;
  readonly postgresRegexpPushdown?: boolean;
  readonly sqliteRegexpAvailable?: boolean;
}

export interface SqlCompileOptionsData extends SqlOptionsData {
  readonly dialect: string;
}

export type SqlParamData =
  | { readonly type: "text" | "timestamp"; readonly value: string }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "number"; readonly value: number };

interface SqlErrorBase {
  readonly message: readonly Text[];
}

export type SqlErrorData =
  | (SqlErrorBase & {
      readonly name: "UnsupportedNodeError";
      readonly nodeKind: string;
      readonly path: string;
      readonly reason: readonly Text[];
    })
  | (SqlErrorBase & {
      readonly name: "InvalidColumnError";
      readonly referenceKey: string;
      readonly column: string;
    })
  | (SqlErrorBase & {
      readonly name: "InvalidCollectionTableError";
      readonly collectionKey: string;
      readonly table: string;
    })
  | (SqlErrorBase & {
      readonly name: "UnknownDialectError";
      readonly dialect: string;
      readonly implemented: readonly string[];
    })
  | (SqlErrorBase & { readonly name: "CallerError" });

export interface SqlCompileCase extends CaseBase {
  readonly kind: "sql-compile";
  readonly tree: Json;
  readonly options: SqlCompileOptionsData;
  readonly expect:
    | { readonly sql: string; readonly params: readonly SqlParamData[] }
    | { readonly error: SqlErrorData };
  readonly expectColumnCalls?: readonly string[];
}

export interface SqlGuardCase extends CaseBase {
  readonly kind: "sql-guard";
  readonly tree: Json;
  readonly options?: SqlCompileOptionsData;
  readonly expect:
    | null
    | {
        readonly nodeKind: string;
        readonly path: string;
        readonly reason: readonly Text[];
      }
    | { readonly error: SqlErrorData };
}

export interface SqlPatternCase extends CaseBase {
  readonly kind: "sql-pattern";
  readonly pattern: Text;
  readonly dialect: "postgres" | "sqlite";
  readonly expect:
    | { readonly text: string }
    | { readonly error: { readonly message: readonly Text[] } };
}

export interface SqlExecuteCase extends CaseBase {
  readonly kind: "sql-execute";
  readonly fixture: string;
  readonly dialect: "sqlite" | "postgres";
  readonly connection?: { readonly regexpFunction: false };
  readonly run:
    | { readonly tree: Json; readonly options: SqlOptionsData }
    | { readonly tree: Json; readonly options?: undefined }
    | { readonly sql: string; readonly params: readonly Json[] };
  readonly expect:
    | { readonly rows: readonly string[] }
    | { readonly result: readonly (readonly Json[])[] }
    | { readonly queryError: readonly Text[] };
  readonly expectSql?: string;
  readonly expectTableCounts?: Readonly<Record<string, number>>;
}

/** A trilean-regex parse case, of which this package reads only the tree to check its ranges and bounds. */
export interface RegexParseCase extends CaseBase {
  readonly kind: "regex-parse";
  readonly expect:
    | { readonly ast: unknown }
    | { readonly astSubset: unknown }
    | { readonly error: unknown };
}

/** A case of a kind another package executes. */
export interface ForeignCase extends CaseBase {
  readonly kind: Exclude<(typeof FOREIGN_KINDS)[number], "regex-parse">;
}

export type CorpusCase =
  | SqlCompileCase
  | SqlGuardCase
  | SqlPatternCase
  | SqlExecuteCase
  | RegexParseCase
  | ForeignCase;

export interface CorpusFile {
  readonly cases: readonly CorpusCase[];
}

export interface Manifest {
  readonly files: Readonly<
    Record<
      string,
      {
        readonly cases: number;
        readonly skip: readonly string[];
        readonly generated?: true;
      }
    >
  >;
}
