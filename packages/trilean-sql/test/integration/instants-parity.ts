import type {
  ComparisonOperator,
  ComputedValue,
  JsonValue,
  PredicateNode,
  Resolution,
  Resolvers,
} from "trilean";
import { evaluatePredicate } from "trilean";
import type {
  SqlCollectionBinding,
  SqlColumnBinding,
  SqlCompileOptions,
  SqlDialect,
} from "../../src/options";

/**
 * The data and trees both engines' instant parity suites share, so the same stored forms, the same parameters and the same predicates run against SQLite and PostgreSQL and against the evaluator, and a row set that differs between them is a defect of whichever engine disagrees.
 *
 * An instant is compared at millisecond precision by the evaluator (`Date.parse`), so every stored form and every parameter here is exact to the millisecond: a form is written with an offset, with `Z`, with fractional seconds of differing precision, or in a different day than the instant it denotes in UTC.
 */

export interface MomentRow {
  readonly id: string;
  readonly at: string | null;
}

/** A stored value outside the grammar the compiler reads, for SQLite: whatever it holds, every comparison over it is unknown, so no predicate or its negation selects it. */
export interface RejectedRow {
  readonly id: string;
  readonly at: string | number | Buffer;
}

/** The stored forms. Several denote the same instant (`utc`, `utc-ms`, `utc-us`, `utc-zero-offset`, `east-two-hours`), and several fall on the other side of a day boundary from the way they read. */
export const MOMENTS: readonly MomentRow[] = [
  { id: "utc-space", at: "2020-01-01 00:00:00Z" },
  { id: "east-fourteen", at: "2020-01-01T14:00:00+14:00" },
  { id: "leap-day", at: "2000-02-29T12:00:00Z" },
  { id: "far-future", at: "9998-12-31T23:59:59.999Z" },
  { id: "utc", at: "2020-01-01T00:00:00Z" },
  { id: "utc-ms", at: "2020-01-01T00:00:00.000Z" },
  { id: "utc-us", at: "2020-01-01T00:00:00.000000Z" },
  { id: "utc-zero-offset", at: "2020-01-01T00:00:00+00:00" },
  { id: "east-two-hours", at: "2020-01-01T02:00:00+02:00" },
  { id: "east-one-hour-early", at: "2020-01-01T01:00:00+02:00" },
  { id: "east-half-past", at: "2020-01-01T00:30:00.5+01:00" },
  { id: "west-same-day", at: "2019-12-31T23:59:59-05:00" },
  { id: "just-before", at: "2019-12-31T23:59:59.999Z" },
  { id: "just-after", at: "2020-01-01T00:00:00.001Z" },
  { id: "later-day", at: "2020-01-02T00:00:00Z" },
  { id: "unknown", at: null },
];

/** The parameters, written in every form the stored values use. `2020-01-01T00:00:00Z` is the instant several rows denote. */
export const PARAMETERS: readonly string[] = [
  "2020-01-01 00:00:00Z",
  "2020-01-01T14:00:00+14:00",
  "2000-02-29T12:00:00Z",
  "2020-01-01T00:00:00Z",
  "2020-01-01T01:00:00+02:00",
  "2020-01-01T00:00:00.000Z",
  "2020-01-01T00:00:00.0000Z",
  "2020-01-01T02:00:00+02:00",
  "2019-12-31T23:59:59-05:00",
  "2019-12-31T19:00:00-05:00",
  "2019-12-31T23:59:59.999Z",
  "2020-01-01T00:00:00.5+01:00",
];

export const OPERATORS: readonly ComparisonOperator[] = [
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
];

/** Maps `"at"` onto the moments table and `"marks"` onto the child table of further instants, for either dialect. */
export const MOMENT_COLUMNS: Readonly<Record<string, SqlColumnBinding>> = {
  at: { column: "at", paramType: "timestamp" },
};

export const MARK_COLUMNS: Readonly<Record<string, SqlColumnBinding>> = {
  mark: { column: "mark", paramType: "timestamp" },
};

function columnFor(
  columns: Readonly<Record<string, SqlColumnBinding>>,
  referenceKey: string,
): SqlColumnBinding {
  const binding = columns[referenceKey];
  if (binding === undefined) {
    throw new Error(`no column mapped for reference key '${referenceKey}'`);
  }

  return binding;
}

function collectionFor(collectionKey: string): SqlCollectionBinding {
  if (collectionKey !== "marks") {
    throw new Error(`no collection mapped for '${collectionKey}'`);
  }

  return {
    table: "marks",
    join: `"marks"."momentId" = "moments"."id"`,
    columnFor: (referenceKey) => columnFor(MARK_COLUMNS, referenceKey),
  };
}

export function momentOptions(dialect: SqlDialect): SqlCompileOptions {
  return {
    dialect,
    columnFor: (referenceKey) => columnFor(MOMENT_COLUMNS, referenceKey),
    collectionFor,
  };
}

/** The further instants each moment owns, in the same mixed forms. */
export const MARKS: readonly {
  readonly id: string;
  readonly momentId: string;
  readonly mark: string | null;
}[] = [
  { id: "m1", momentId: "utc", mark: "2020-01-01T00:00:00+02:00" },
  { id: "m2", momentId: "utc", mark: "2019-12-31T22:00:00Z" },
  { id: "m3", momentId: "east-two-hours", mark: "2020-01-01T03:00:00+02:00" },
  { id: "m4", momentId: "east-two-hours", mark: "2020-01-01T00:00:00.0Z" },
  { id: "m5", momentId: "later-day", mark: null },
  { id: "m6", momentId: "later-day", mark: "2020-01-01T23:59:59-05:00" },
];

const column = { kind: "reference", key: "at" } as const;

/** Every comparison of the column with every parameter, the column on the left. */
export function comparisons(
  parameters: readonly string[] = PARAMETERS,
): readonly {
  readonly label: string;
  readonly tree: PredicateNode;
}[] {
  return OPERATORS.flatMap((op) =>
    parameters.map((value) => ({
      label: `at ${op} ${value}`,
      tree: {
        kind: "compare",
        op,
        left: column,
        right: { kind: "instantLiteral", value },
      } satisfies PredicateNode,
    })),
  );
}

/** The same comparisons with the parameter on the left. */
export function reversedComparisons(): readonly {
  readonly label: string;
  readonly tree: PredicateNode;
}[] {
  return OPERATORS.flatMap((op) =>
    PARAMETERS.map((value) => ({
      label: `${value} ${op} at`,
      tree: {
        kind: "compare",
        op,
        left: { kind: "instantLiteral", value },
        right: column,
      } satisfies PredicateNode,
    })),
  );
}

/** Membership, with candidates written in forms other than the stored one. */
export const MEMBERSHIPS: readonly {
  readonly label: string;
  readonly tree: PredicateNode;
}[] = [
  {
    label: "in two forms of one instant and a second instant",
    tree: {
      kind: "memberOf",
      op: "in",
      operand: column,
      candidates: [
        { kind: "instantLiteral", value: "2020-01-01T02:00:00+02:00" },
        { kind: "instantLiteral", value: "2019-12-31T23:59:59.999Z" },
      ],
    },
  },
  {
    label: "notIn the same candidates",
    tree: {
      kind: "memberOf",
      op: "notIn",
      operand: column,
      candidates: [
        { kind: "instantLiteral", value: "2020-01-01T02:00:00+02:00" },
        { kind: "instantLiteral", value: "2019-12-31T23:59:59.999Z" },
      ],
    },
  },
];

/** The latest and earliest of a moment's marks against a parameter, and a mark compared inside `some` and `every`. */
export const COLLECTIONS: readonly {
  readonly label: string;
  readonly tree: PredicateNode;
}[] = [
  ...(["max", "min"] as const).flatMap((mode) =>
    (["gt", "eq", "lte"] as const).map((op) => ({
      label: `fold ${mode} of the marks ${op} an offset parameter`,
      tree: {
        kind: "compare",
        op,
        left: {
          kind: "fold",
          collection: "marks",
          combiner: { mode, item: { kind: "reference", key: "mark" } },
        },
        right: { kind: "instantLiteral", value: "2019-12-31T23:59:59-05:00" },
      } satisfies PredicateNode,
    })),
  ),
  ...(["some", "every"] as const).map((kind) => ({
    label: `${kind} mark is at or after an offset parameter`,
    tree: {
      kind,
      collection: "marks",
      item: {
        kind: "compare",
        op: "gte",
        left: { kind: "reference", key: "mark" },
        right: { kind: "instantLiteral", value: "2020-01-01T01:00:00+02:00" },
      },
    } satisfies PredicateNode,
  })),
];

function instantResolution(value: string | null): Resolution {
  return value === null
    ? { found: false }
    : {
        found: true,
        value: { kind: "instant", value } satisfies ComputedValue,
      };
}

/** The ids of the moments the evaluator selects, one evaluation per moment. */
export async function evaluatorRows(
  tree: PredicateNode,
  moments: readonly MomentRow[] = MOMENTS,
): Promise<string[]> {
  const evaluations = await Promise.all(
    moments.map(async (moment) => {
      const marks = MARKS.filter((mark) => mark.momentId === moment.id);
      const resolvers: Resolvers = {
        resolveValue: async (key: JsonValue, context: unknown) => {
          if (context !== undefined) {
            const mark =
              typeof context === "object" &&
              context !== null &&
              "mark" in context
                ? context.mark
                : undefined;

            return Promise.resolve(
              key === "mark" && (typeof mark === "string" || mark === null)
                ? instantResolution(mark)
                : { found: false },
            );
          }

          return Promise.resolve(
            key === "at" ? instantResolution(moment.at) : { found: false },
          );
        },
        resolveLookup: () => {
          throw new Error("no tree here uses a lookup");
        },
        resolveCollection: async (collection: JsonValue) =>
          Promise.resolve(
            collection === "marks" ? marks.map(({ mark }) => ({ mark })) : [],
          ),
      };

      return {
        id: moment.id,
        evaluation: await evaluatePredicate(tree, undefined, resolvers),
      };
    }),
  );

  return evaluations
    .filter(
      ({ evaluation }) => evaluation.status === "definite" && evaluation.value,
    )
    .map(({ id }) => id)
    .sort();
}

/**
 * The stored values SQLite's date functions would read as dates, or as other things, and the evaluator rejects or the grammar does not include. Each is unknown for every comparison. `now` reads as the present time, a time of day as a day in the year 2000, a number as a Julian day, and so on.
 */
export const REJECTED: readonly RejectedRow[] = [
  { id: "r-now", at: "now" },
  { id: "r-now-upper", at: "NOW" },
  { id: "r-time-only", at: "10:00" },
  { id: "r-time-seconds", at: "10:00:00" },
  { id: "r-date-only", at: "2020-01-01" },
  { id: "r-trailing-space", at: "2020-01-01T00:00:00Z " },
  { id: "r-space-before-zone", at: "2020-01-01T00:00:00 Z" },
  { id: "r-leading-space", at: " 2020-01-01T00:00:00Z" },
  { id: "r-julian-text", at: "2459000.5" },
  { id: "r-julian-number", at: 2459000.5 },
  { id: "r-zero-text", at: "0" },
  { id: "r-unix-seconds", at: 1577836800 },
  { id: "r-unix-milliseconds", at: 1577836800000 },
  { id: "r-lower-t", at: "2020-01-01t00:00:00Z" },
  { id: "r-lower-z", at: "2020-01-01T00:00:00z" },
  { id: "r-no-offset", at: "2020-01-01T00:00:00" },
  { id: "r-offset-no-colon", at: "2020-01-01T00:00:00+0200" },
  { id: "r-utc-string", at: "Wed, 01 Jan 2020 00:00:00 GMT" },
  { id: "r-expanded-year", at: "+002020-01-01T00:00:00Z" },
  { id: "r-negative-year", at: "-0001-01-01T00:00:00Z" },
  { id: "r-month-13", at: "2020-13-01T00:00:00Z" },
  { id: "r-month-0", at: "2020-00-10T00:00:00Z" },
  { id: "r-day-0", at: "2020-01-00T00:00:00Z" },
  { id: "r-feb-30", at: "2020-02-30T00:00:00Z" },
  { id: "r-apr-31", at: "2020-04-31T00:00:00Z" },
  { id: "r-feb-29-common-year", at: "1900-02-29T00:00:00Z" },
  { id: "r-hour-24", at: "2020-01-01T24:00:00Z" },
  { id: "r-hour-24-minutes", at: "2020-01-01T24:30:00Z" },
  { id: "r-hour-25", at: "2020-01-01T25:00:00Z" },
  { id: "r-minute-60", at: "2020-01-01T00:60:00Z" },
  { id: "r-second-60", at: "2020-01-01T23:59:60Z" },
  { id: "r-offset-hour-24", at: "2020-01-01T00:00:00+24:00" },
  { id: "r-offset-minute-60", at: "2020-01-01T00:00:00+02:60" },
  { id: "r-empty-fraction", at: "2020-01-01T00:00:00.Z" },
  { id: "r-fraction-letter", at: "2020-01-01T00:00:00.5aZ" },
  { id: "r-fraction-zone-inside", at: "2020-01-01T00:00:00.5-05:00Z" },
  { id: "r-fraction-then-offset-text", at: "2020-01-01T00:00:00.5x+02:00" },
  { id: "r-nul-after", at: "2020-01-01T00:00:00Z\u0000" },
  { id: "r-blob-of-the-text", at: Buffer.from("2020-01-01T00:00:00Z") },
  { id: "r-garbage", at: "garbage" },
  { id: "r-empty", at: "" },
];

/** The rows of the grammar's edges whose fraction has more than three digits, or whose year PostgreSQL does not read, so only the evaluator and SQLite are compared on them. */
export const SQLITE_ONLY: readonly MomentRow[] = [
  { id: "x-year-0", at: "0000-01-01T00:00:00Z" },
  { id: "x-year-0-leap", at: "0000-02-29T00:00:00Z" },
  { id: "x-year-9999", at: "9999-12-31T23:59:59.999Z" },
  { id: "x-offset-max", at: "2020-01-01T00:00:00+23:59" },
  { id: "x-offset-min", at: "2020-01-01T00:00:00-23:59" },
  { id: "x-truncated", at: "2019-12-31T23:59:59.9996Z" },
  { id: "x-truncated-offset", at: "2020-01-01T01:59:59.9996+02:00" },
  { id: "x-long-fraction", at: "2020-01-01T00:00:00.123456789Z" },
];

/** Parameters only SQLite and the evaluator read in the same way. */
export const SQLITE_ONLY_PARAMETERS: readonly string[] = [
  "2020-01-01T00:00:00+23:59",
  "0000-01-01T00:00:00Z",
  "9999-12-31T23:59:59.999Z",
  "2019-12-31T23:59:59.9996Z",
  "2020-01-01T00:00:00.123456789Z",
];
