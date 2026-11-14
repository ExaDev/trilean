import type { SqlDialect } from "./options";

/**
 * What a dialect can carry in a quoted identifier and in a bound text value, in one place: the guard decides with it before compilation and the compiler's own drift checks use it, so the two cannot disagree.
 *
 * The reasons describe the character or the count and never repeat the input, so an error built from one cannot carry a caller's value into a log.
 */

const NUL = "\u0000";

/** The most dot-separated segments a column may have: `schema.table.column`. SQLite's expression syntax is `schema-name.table-name.column-name` (https://www.sqlite.org/lang_expr.html), and PostgreSQL accepts a fourth, leading segment only as the current database's own name (https://www.postgresql.org/docs/current/ddl-schemas.html), which a compiler that does not know the database cannot tell from any other name. */
export const MAX_COLUMN_SEGMENTS: Readonly<Record<SqlDialect, number>> = {
  postgres: 3,
  sqlite: 3,
};

/** The most dot-separated segments a table may have: `schema.table`. SQLite's `FROM` takes `schema-name.table-name` (https://www.sqlite.org/syntax/table-or-subquery.html), and PostgreSQL's third, leading segment is the current database, with any other rejected as a cross-database reference (https://www.postgresql.org/docs/current/ddl-schemas.html). */
export const MAX_TABLE_SEGMENTS: Readonly<Record<SqlDialect, number>> = {
  postgres: 2,
  sqlite: 2,
};

/**
 * Why a column or table name cannot be rendered as a quoted identifier for `dialect`, or `undefined` when it can.
 *
 * Refused: an empty name or segment; the NUL character, which neither engine accepts in a quoted identifier (PostgreSQL: "Quoted identifiers can contain any character, except the character with code zero", https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) and which ends the statement text SQLite is given ("zSql is read up to the first zero terminator", https://www.sqlite.org/c3ref/prepare.html); an unpaired UTF-16 surrogate, which has no UTF-8 form, the encoding both engines read the statement in; and more segments than the dialect accepts. Every other character, a quote included, is carried by doubling the quote.
 */
export function identifierProblem(
  role: "column" | "table",
  name: string,
  dialect: SqlDialect,
): string | undefined {
  if (name.length === 0) return "the name is empty";
  if (name.includes(NUL)) {
    return "the name contains a NUL character, which a quoted identifier cannot carry";
  }
  if (!name.isWellFormed()) {
    return "the name contains an unpaired surrogate, which has no UTF-8 form";
  }
  const segments = name.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    return "a dot-separated segment is empty";
  }
  const most =
    role === "column"
      ? MAX_COLUMN_SEGMENTS[dialect]
      : MAX_TABLE_SEGMENTS[dialect];
  if (segments.length > most) {
    return `the name has ${String(segments.length)} dot-separated segments and ${dialect} accepts at most ${String(most)} for a ${role}`;
  }

  return undefined;
}

/**
 * Why a text, pattern or instant value cannot be bound for `dialect`, or `undefined` when it can.
 *
 * An unpaired surrogate has no UTF-8 form, and a driver silently replaces it with U+FFFD, so the engine would compare a value other than the one the evaluator saw. The NUL character is carried by SQLite as text but not by PostgreSQL, which rejects it with an invalid byte sequence error (a string constant "cannot contain the character with code zero", https://www.postgresql.org/docs/current/sql-syntax-lexical.html). A pattern is also read by SQLite's `GLOB` and `LIKE` only up to its first NUL, so a NUL in a pattern is refused for SQLite as well.
 */
export function valueProblem(
  value: string,
  dialect: SqlDialect,
  role: "text" | "pattern",
): string | undefined {
  if (!value.isWellFormed()) {
    return "the value contains an unpaired surrogate, which has no UTF-8 form and would be replaced before the engine compared it";
  }
  if (!value.includes(NUL)) return undefined;
  if (dialect === "postgres") {
    return "PostgreSQL cannot carry the NUL character in a text value and rejects the statement with an invalid byte sequence error";
  }

  return role === "pattern"
    ? "SQLite's GLOB and LIKE read a pattern only up to its first NUL character, so the pattern would match as a shorter one"
    : undefined;
}
