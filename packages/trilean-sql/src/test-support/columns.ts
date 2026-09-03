import type { SqlColumnBinding, SqlCompileOptions } from "../options";

/**
 * The schema the unit tests and every integration suite compile against, so a fragment asserted as a string in one is the same fragment executed against a real engine in the others.
 *
 * `age`, `name`, `active` and `joined` each declare a `paramType`; `note` deliberately does not, which is what exercises the compiler's undeclared-column path (no operand-kind checking, and literal placeholders rendered by their own kind instead of the column's).
 */
export const SUBJECT_COLUMNS: Readonly<Record<string, SqlColumnBinding>> = {
  age: { column: "age", paramType: "number" },
  name: { column: "name", paramType: "text" },
  active: { column: "active", paramType: "boolean" },
  joined: { column: "joined", paramType: "timestamp" },
  note: { column: "note" },
};

function columnForSubject(referenceKey: string): SqlColumnBinding {
  const binding = SUBJECT_COLUMNS[referenceKey];
  if (binding === undefined) {
    throw new Error(`no column mapped for reference key '${referenceKey}'`);
  }
  return binding;
}

export const subjectOptions: SqlCompileOptions = {
  dialect: "postgres",
  columnFor: columnForSubject,
};

/** The same mapping compiled for SQLite. Sharing `columnFor` is the point: a column mapping is a property of the schema, not of the dialect, so the only difference between the two suites' options is the dialect they name. */
export const sqliteSubjectOptions: SqlCompileOptions = {
  dialect: "sqlite",
  columnFor: columnForSubject,
};
