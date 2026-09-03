import type { SqlColumnBinding, SqlCompileOptions } from "../options";

/**
 * The schema the unit tests and the integration suite both compile against, so a fragment asserted as a string in one is the same fragment executed against a real server in the other.
 *
 * `age`, `name`, `active` and `joined` each declare a `paramType`; `note` deliberately does not, which is what exercises the compiler's undeclared-column path (no operand-kind checking, and literal placeholders cast by their own kind instead of the column's).
 */
export const SUBJECT_COLUMNS: Readonly<Record<string, SqlColumnBinding>> = {
  age: { column: "age", paramType: "number" },
  name: { column: "name", paramType: "text" },
  active: { column: "active", paramType: "boolean" },
  joined: { column: "joined", paramType: "timestamp" },
  note: { column: "note" },
};

export const subjectOptions: SqlCompileOptions = {
  dialect: "postgres",
  columnFor: (referenceKey) => {
    const binding = SUBJECT_COLUMNS[referenceKey];
    if (binding === undefined) {
      throw new Error(`no column mapped for reference key '${referenceKey}'`);
    }
    return binding;
  },
};
