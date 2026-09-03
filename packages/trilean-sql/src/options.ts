import { UnknownDialectError } from "./errors";

/** The declared SQL value kind of a mapped column. `"timestamp"` names trilean's `instant` kind, whose values are ISO-8601 strings. */
export type SqlParamType = "text" | "number" | "boolean" | "timestamp";

/** The SQL dialects this compiler emits. A dialect is named rather than inferred: the same tree compiles to different text for each, and a caller that never said which one it meant would be relying on whichever happened to be the default. */
export type SqlDialect = "postgres" | "sqlite";

/** What a `reference` node's key maps onto in the target schema. */
export interface SqlColumnBinding {
  /** The column, optionally qualified with a table or schema by dots (`"orders.total"`). Each dot-separated segment is emitted as its own double-quoted identifier, so a segment may contain any character except a dot itself. */
  column: string;
  /**
   * The column's value kind, if the caller knows it. Optional, and worth supplying: it is the only thing that lets the compiler check a comparison against the column for the kind mismatches trilean itself treats as `wrong-type` -- comparing a text column with `compare` rather than `textCompare`, ordering a boolean, comparing a number against an instant. Left undeclared, those comparisons compile, and the database may coerce its way to a definite answer where trilean would have returned indeterminate.
   *
   * It does not affect the emitted SQL, only whether the comparison is emitted at all. Every literal placeholder is already cast to the type its own trilean kind implies (in the dialects that cast at all), and a comparison that survives the check is one whose operand kinds agree, so there is nothing left for the column's declared kind to change.
   */
  paramType?: SqlParamType;
}

export interface SqlCompileOptions {
  /** Which dialect to emit. It is a required field rather than a default so that a caller states the engine it is compiling for, instead of inheriting whichever one this package happened to implement first. */
  dialect: SqlDialect;
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
  /** Positional parameters, in emission order, to pass alongside `sql`. Every caller-supplied literal in the tree is here; none is ever written into `sql`. */
  params: unknown[];
}

/** The PostgreSQL type each declared value kind is cast to. `timestamptz` rather than `timestamp`: trilean's `instant` is an ISO-8601 string that may carry an offset, and parsing one as a naive `timestamp` would silently discard it. */
export const POSTGRES_TYPE_NAME: Readonly<Record<SqlParamType, string>> = {
  text: "text",
  number: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
};

/**
 * Everything about the emitted SQL that is a property of the dialect rather than of the tree.
 *
 * It is deliberately this small. Most of what the compiler emits is ANSI-standard and identical in both engines -- the six comparison operators, `=` and `<>` for `textCompare`'s `equals`/`notEquals`, `AND`/`OR`/`NOT`, `IN`/`NOT IN`, `IS NOT NULL`, and double-quoted identifiers with an embedded quote doubled -- so branching on the dialect anywhere else would be a branch that can never change the output. Three things genuinely differ, and they are the three fields below.
 */
export interface DialectConfig {
  /** The regular-expression match operator `textCompare`'s `matches` compiles to. */
  matches: string;
  /** The negated regular-expression match operator `textCompare`'s `notMatches` compiles to. */
  notMatches: string;
  /** Renders the `index`-th (1-based) bind placeholder, for a literal whose own trilean kind implies `castTo`. A dialect that does not need the cast ignores both arguments. */
  placeholder: (index: number, castTo: SqlParamType) => string;
  /** Appended to the bare `NULL` in the two forms an empty `memberOf` candidate list compiles to, for a dialect that needs the resulting expression annotated with a boolean type. */
  emptyMemberOfNullSuffix: string;
}

export const DIALECT_CONFIG: Readonly<Record<SqlDialect, DialectConfig>> = {
  postgres: {
    // PostgreSQL's own regular-expression match operators, so a pattern is matched by the server rather than shipped back to be matched in process. See the "Regular expressions" caveat in README.md: PostgreSQL's advanced regular expressions and ECMAScript's are close but not the same language.
    matches: "~",
    notMatches: "!~",
    // Casting every placeholder means a fragment's meaning never depends on how a particular driver decided to infer an untyped parameter, and it is what makes a comparison between two literals (`$1 < $2`, which PostgreSQL rejects outright as having undeterminable parameter types) compile to something executable at all.
    placeholder: (index, castTo) =>
      `$${String(index)}::${POSTGRES_TYPE_NAME[castTo]}`,
    emptyMemberOfNullSuffix: "::boolean",
  },
  sqlite: {
    // SQLite has no built-in regular-expression support: `REGEXP` is reserved syntax for a `regexp(pattern, value)` function the connection must register itself, and an unregistered one fails loudly at query time with "no such function: REGEXP" rather than answering wrongly. See the "Regular expressions" section in README.md for the registration the SQLite dialect therefore requires of its caller.
    matches: "REGEXP",
    notMatches: "NOT REGEXP",
    // SQLite parameters are dynamically typed and positional-by-order, so there is neither a number to write nor a type to cast to. A bare `?` is correct for every literal kind this compiler emits, including a comparison between two literals, which SQLite answers without needing either side annotated.
    placeholder: () => "?",
    // SQLite has no boolean type to annotate: `NULL` alone already carries the three-valued behaviour the empty-`memberOf` forms depend on.
    emptyMemberOfNullSuffix: "",
  },
};

/**
 * Refuses a dialect this version does not implement, before anything indexes a per-dialect table with it.
 *
 * Both entry points check their own argument, because both are reachable with a name the type describes but cannot enforce -- a dialect is exactly the sort of value that arrives as a configuration string asserted into the union at the boundary. Left unchecked, that name is not caught anywhere: the compiler reads an operator off `undefined` and throws a `TypeError` naming an internal field, and the guard, whose tables are only consulted for a node it actually objects to, answers "pushable" for a tree the compiler then fails on -- the one thing `findUnpushableNodeKind` exists to decide, decided wrongly.
 *
 * `DIALECT_CONFIG` is the list, rather than a second constant, so implementing a dialect cannot leave this behind.
 */
export function assertImplementedDialect(dialect: SqlDialect): void {
  if (!Object.hasOwn(DIALECT_CONFIG, dialect)) {
    throw new UnknownDialectError(dialect, Object.keys(DIALECT_CONFIG));
  }
}
