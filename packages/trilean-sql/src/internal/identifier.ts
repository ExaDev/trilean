import type { SqlDialect } from "../options";

/**
 * What a dialect can carry in a quoted identifier and in a bound text value, in one place: the guard decides with it before compilation and the compiler's own drift checks use it, so the two cannot disagree.
 *
 * The reasons describe the character or the count and never repeat the input, so an error built from one cannot carry a caller's value into a log.
 */

const NUL = "\u0000";

/** The most bytes of an identifier PostgreSQL keeps: "The system uses no more than NAMEDATALEN -1 bytes of an identifier; longer names can be written in commands, but they will be truncated. By default, NAMEDATALEN is 64 so the maximum identifier length is 63 bytes" (https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS). Each dot-separated segment is an identifier of its own, and the count is of bytes in UTF-8, not of characters. A longer name is cut silently, so two distinct names that agree in their first 63 bytes would name one column. */
export const POSTGRES_IDENTIFIER_BYTES = 63;

const encoder = new TextEncoder();

/** The most dot-separated segments a column may have: `schema.table.column`. SQLite's expression syntax is `schema-name.table-name.column-name` (https://www.sqlite.org/lang_expr.html). PostgreSQL's page on schemas says that "the even more general syntax database.schema.table can be used too, but at present this is just for pro forma compliance with the SQL standard. If you write a database name, it must be the same as the database you are connected to" (https://www.postgresql.org/docs/current/ddl-schemas.html). The compiler does not know the database the connection is on, so a leading database segment is refused as a choice, and the caller omits it. */
export const MAX_COLUMN_SEGMENTS: Readonly<Record<SqlDialect, number>> = {
  postgres: 3,
  sqlite: 3,
};

/** The most dot-separated segments a table may have: `schema.table`. SQLite's `FROM` takes `schema-name.table-name` (https://www.sqlite.org/syntax/table-or-subquery.html), and for PostgreSQL a leading database segment is refused for the reason given at {@link MAX_COLUMN_SEGMENTS}. */
export const MAX_TABLE_SEGMENTS: Readonly<Record<SqlDialect, number>> = {
  postgres: 2,
  sqlite: 2,
};

/**
 * Why a column or table name cannot be rendered as a quoted identifier for `dialect`, or `undefined` when it can.
 *
 * Refused: an empty name or segment; the NUL character, which neither engine accepts in a quoted identifier (PostgreSQL: "Quoted identifiers can contain any character, except the character with code zero", https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) and which ends the statement text SQLite is given ("zSql is read up to the first zero terminator", https://www.sqlite.org/c3ref/prepare.html); an unpaired UTF-16 surrogate, which has no UTF-8 form, the encoding both engines read the statement in; more segments than the dialect accepts; and, for PostgreSQL, a segment of more than {@link POSTGRES_IDENTIFIER_BYTES} bytes in UTF-8. Every other character, a quote included, is carried by doubling the quote.
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
    return dialect === "postgres"
      ? `the name has ${String(segments.length)} dot-separated segments and at most ${String(most)} are accepted for a ${role}: PostgreSQL takes a leading database name only when it is the database the connection is on, which the compiler cannot know`
      : `the name has ${String(segments.length)} dot-separated segments and SQLite accepts at most ${String(most)} for a ${role}`;
  }

  if (dialect === "postgres") {
    const longest = Math.max(
      ...segments.map((segment) => encoder.encode(segment).length),
    );
    if (longest > POSTGRES_IDENTIFIER_BYTES) {
      return `a dot-separated segment of the name is ${String(longest)} bytes in UTF-8 and PostgreSQL keeps at most ${String(POSTGRES_IDENTIFIER_BYTES)} bytes of an identifier, so a longer name is cut short and two names that agree in their first ${String(POSTGRES_IDENTIFIER_BYTES)} bytes would be one`;
    }
  }

  return undefined;
}

/**
 * Why a text, pattern or instant value cannot be bound for `dialect`, or `undefined` when it can.
 *
 * An unpaired surrogate has no UTF-8 form, and a driver silently replaces it with U+FFFD, so the engine would compare a value other than the one the evaluator saw. The NUL character is carried by SQLite as text but not by PostgreSQL, which rejects it with an invalid byte sequence error (a string constant "cannot contain the character with code zero", https://www.postgresql.org/docs/current/sql-syntax-lexical.html). The pattern of `portableMatches` and `portableNotMatches` is compiled to SQLite's `GLOB`, which reads it only up to its first NUL, so a NUL there is refused for SQLite as well; the pattern of `matches` and `notMatches` is a `REGEXP` argument and a registered function receives it whole.
 */
export function valueProblem(
  value: string,
  dialect: SqlDialect,
  role: "text" | "glob-pattern",
): string | undefined {
  if (!value.isWellFormed()) {
    return "the value contains an unpaired surrogate, which has no UTF-8 form and would be replaced before the engine compared it";
  }
  if (!value.includes(NUL)) return undefined;
  if (dialect === "postgres") {
    return "PostgreSQL cannot carry the NUL character in a text value and rejects the statement with an invalid byte sequence error";
  }

  return role === "glob-pattern"
    ? "SQLite's GLOB reads a pattern only up to its first NUL character, so the pattern would match as a shorter one"
    : undefined;
}

/**
 * Why SQL text a caller wrote, which the compiler writes into the statement as given (a collection's `join`), cannot be carried, or `undefined` when it can. The same two classes a name is refused for apply, in both dialects: the NUL character, which ends the statement text SQLite is given ("zSql is read up to the first zero terminator", https://www.sqlite.org/c3ref/prepare.html) and which PostgreSQL does not accept in a statement (a string constant "cannot contain the character with code zero", https://www.postgresql.org/docs/current/sql-syntax-lexical.html), so the engine would read a statement other than the one compiled; and an unpaired UTF-16 surrogate, which has no UTF-8 form, the encoding both engines read the statement in. Nothing else of the text is judged: it is the caller's SQL.
 */
export function statementTextProblem(text: string): string | undefined {
  if (text.includes(NUL)) {
    return "the SQL text contains a NUL character, which a statement cannot carry";
  }
  if (!text.isWellFormed()) {
    return "the SQL text contains an unpaired surrogate, which has no UTF-8 form";
  }

  return undefined;
}
