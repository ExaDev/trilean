/** The declared SQL value kind of a mapped column. `"timestamp"` names trilean's `instant` kind, whose values are ISO-8601 strings. */
export type SqlParamType = "text" | "number" | "boolean" | "timestamp";

/** What a `reference` node's key maps onto in the target schema. */
export interface SqlColumnBinding {
  /** The column, optionally qualified with a table or schema by dots (`"orders.total"`). Each dot-separated segment is emitted as its own double-quoted identifier, so a segment may contain any character except a dot itself. */
  column: string;
  /**
   * The column's value kind, if the caller knows it. Optional, and worth supplying: it is the only thing that lets the compiler check a comparison against the column for the kind mismatches trilean itself treats as `wrong-type` -- comparing a text column with `compare` rather than `textCompare`, ordering a boolean, comparing a number against an instant. Left undeclared, those comparisons compile, and PostgreSQL may coerce its way to a definite answer where trilean would have returned indeterminate.
   *
   * It does not affect the emitted SQL, only whether the comparison is emitted at all. Every literal placeholder is already cast to the type its own trilean kind implies, and a comparison that survives the check is one whose operand kinds agree, so there is nothing left for the column's declared kind to change.
   */
  paramType?: SqlParamType;
}

export interface SqlCompileOptions {
  /** PostgreSQL is the only dialect implemented. It is a required field rather than a default so that adding a second dialect later is a new value here, not a change of behaviour for callers who never said which one they meant. */
  dialect: "postgres";
  /**
   * Maps a `reference` node's key onto a column. Called once per reference occurrence.
   *
   * Only string reference keys reach it: trilean allows any JSON value as a key, and a non-string one is refused as unpushable before this is called. Throwing from here is how a caller rejects a key it has no column for -- the exception propagates out of `compilePredicateNode` unchanged, rather than being wrapped or swallowed.
   */
  columnFor: (referenceKey: string) => SqlColumnBinding;
}

export interface CompiledSql {
  /** A self-contained boolean expression, always parenthesised, suitable for dropping straight into a `WHERE` clause (or a `CHECK`, a `HAVING`, or a filtered index predicate). It carries no `WHERE` keyword of its own. */
  sql: string;
  /** Positional parameters, in `$1`-first order, to pass alongside `sql`. Every caller-supplied literal in the tree is here; none is ever written into `sql`. */
  params: unknown[];
}

/** The PostgreSQL type each declared value kind is cast to. `timestamptz` rather than `timestamp`: trilean's `instant` is an ISO-8601 string that may carry an offset, and parsing one as a naive `timestamp` would silently discard it. */
export const POSTGRES_TYPE_NAME: Readonly<Record<SqlParamType, string>> = {
  text: "text",
  number: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
};
