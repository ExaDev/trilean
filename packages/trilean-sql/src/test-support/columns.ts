import type {
  SqlCollectionBinding,
  SqlColumnBinding,
  SqlCompileOptions,
} from "../options";

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

/** `subjectOptions` with PostgreSQL regular-expression pushdown opted into, for the tests that exercise `matches`/`notMatches` compiling to `~`/`!~` rather than the default refusal. See `postgresRegexpPushdown`'s own doc comment in options.ts. */
export const subjectOptionsWithPostgresRegexp: SqlCompileOptions = {
  ...subjectOptions,
  postgresRegexpPushdown: true,
};

/**
 * The one correlated child table every integration suite seeds alongside `subjects`, purely to exercise `some`/`every`/`fold` against a real connection -- a subject's own tags, each carrying an optional `weight`. `tag` and `weight` both declare a `paramType`, matching `SUBJECT_COLUMNS`'s own convention of describing every column an integration suite actually compares by kind.
 */
export const SUBJECT_TAG_COLUMNS: Readonly<Record<string, SqlColumnBinding>> = {
  tag: { column: "tag", paramType: "text" },
  weight: { column: "weight", paramType: "number" },
};

function columnForSubjectTag(referenceKey: string): SqlColumnBinding {
  const binding = SUBJECT_TAG_COLUMNS[referenceKey];
  if (binding === undefined) {
    throw new Error(`no column mapped for reference key '${referenceKey}'`);
  }
  return binding;
}

/** Maps the one collection key every integration suite's trees use, `"tags"`, onto `subject_tags`, correlated to the outer `subjects` row by `subjectId`. */
export function collectionForSubjectTags(
  collectionKey: string,
): SqlCollectionBinding {
  if (collectionKey !== "tags") {
    throw new Error(
      `no collection mapped for collection key '${collectionKey}'`,
    );
  }
  return {
    table: "subject_tags",
    join: `"subject_tags"."subjectId" = "subjects"."id"`,
    columnFor: columnForSubjectTag,
  };
}

/** `subjectOptions` with `collectionFor` supplied, for the integration suites' `some`/`every`/`fold` parity tests. */
export const subjectOptionsWithTags: SqlCompileOptions = {
  ...subjectOptions,
  collectionFor: collectionForSubjectTags,
};

/** The same mapping compiled for SQLite. */
export const sqliteSubjectOptionsWithTags: SqlCompileOptions = {
  ...sqliteSubjectOptions,
  collectionFor: collectionForSubjectTags,
};
