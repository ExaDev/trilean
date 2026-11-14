/**
 * How the SQLite dialect reads an instant, in one place.
 *
 * SQLite has no timestamp type, and its date functions read far more than an instant: the text `now` is the present time, a time of day is a date in the year 2000, a number is a Julian day. The evaluator reads none of these. So the SQL decides first, with a shape test that needs no extension, whether a stored value is an instant in exactly one grammar, and only then converts it; any other value is NULL (unknown) whatever the date functions would make of it, and the same grammar is applied to an `instantLiteral` when the tree is compiled.
 *
 * The grammar: four-digit year, `-`, two-digit month, `-`, two-digit day, `T` or one space, two-digit hour, `:`, minute, `:`, second, an optional `.` and one or more fractional digits, then `Z` or a sign, two-digit hours, `:` and two-digit minutes. The value must also be a real moment: a month 1 to 12, a day that exists in that month (so no `02-30`), an hour 0 to 23, a minute and second 0 to 59 (no leap second, no hour 24), and an offset of at most 23:59. Within it SQLite, PostgreSQL and the evaluator (`Date.parse`) read the same instant, to the millisecond; the fraction is truncated to three digits, as `Date.parse` does, and is not rounded as SQLite's own date functions would.
 */

/** The characters up to the seconds, in the form SQLite's `GLOB` reads: four digits, `-`, two, `-`, two, `T` or a space, two, `:`, two, `:`, two. */
const DATE_AND_TIME_SHAPE =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]:[0-9][0-9]";

const OFFSET_SHAPE = "[+-][0-9][0-9]:[0-9][0-9]";

/** The characters before the seconds end, which are the first nineteen of a value in the grammar. */
const SECONDS_END = 19;
/** Where the fraction's point, or the zone, starts (1-based). */
const AFTER_SECONDS = 20;
/** The width of a numeric offset, `+HH:MM`. */
const OFFSET_WIDTH = 6;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const FRACTION_DIGITS = 3;

/**
 * The SQL that reads `column` (an expression of one SQLite value) as whole milliseconds since the epoch, or NULL when it is not an instant in the grammar above. `column` appears many times, so it must be a column reference or a placeholder-free expression.
 */
export function sqliteInstantColumn(column: string): string {
  const length = `length(${column})`;
  const isZulu = `${column} GLOB '*Z'`;
  // The fraction's digits, when there is a fraction: from the character after the point to the one before the zone.
  const fractionLength = `(${length} - ${String(AFTER_SECONDS)} - CASE WHEN ${isZulu} THEN 1 ELSE ${String(OFFSET_WIDTH)} END)`;
  const zoneStart = `CASE WHEN ${isZulu} THEN ${length} ELSE ${length} - ${String(OFFSET_WIDTH - 1)} END`;
  const afterSeconds = `substr(${column}, ${String(AFTER_SECONDS)})`;
  const fractionOnly = `substr(${column}, ${String(AFTER_SECONDS + 1)}, ${fractionLength})`;

  const zoneShape = `(${afterSeconds} = 'Z' OR ${afterSeconds} GLOB '${OFFSET_SHAPE}' OR (substr(${column}, ${String(AFTER_SECONDS)}, 1) = '.' AND ${fractionLength} > 0 AND ${fractionOnly} NOT GLOB '*[^0-9]*' AND (${isZulu} OR ${column} GLOB '*${OFFSET_SHAPE}')))`;
  const shape = `instr(CAST(${column} AS BLOB), x'00') = 0 AND ${column} GLOB '${DATE_AND_TIME_SHAPE}*' AND ${zoneShape}`;

  const dateAndTime = `substr(${column}, 1, ${String(SECONDS_END)})`;
  const real = [
    `strftime('%Y-%m-%d', ${dateAndTime}) = substr(${column}, 1, 10)`,
    `strftime('%s', ${dateAndTime}) IS NOT NULL`,
    `substr(${column}, 12, 2) < '24'`,
    `(${isZulu} OR (substr(${column}, ${zoneStart} + 1, 2) <= '23' AND substr(${column}, ${zoneStart} + 4, 2) <= '59'))`,
  ].join(" AND ");

  const fraction = `CASE WHEN substr(${column}, ${String(AFTER_SECONDS)}, 1) = '.' THEN CAST(substr(${fractionOnly} || '00', 1, ${String(FRACTION_DIGITS)}) AS INTEGER) ELSE 0 END`;
  const offsetMinutes = `CASE WHEN ${isZulu} THEN 0 ELSE (CASE substr(${column}, ${zoneStart}, 1) WHEN '-' THEN -1 ELSE 1 END) * (CAST(substr(${column}, ${zoneStart} + 1, 2) AS INTEGER) * ${String(MINUTES_PER_HOUR)} + CAST(substr(${column}, ${zoneStart} + 4, 2) AS INTEGER)) END`;

  return `(CASE WHEN ${shape} AND ${real} THEN CAST(strftime('%s', ${dateAndTime}) AS INTEGER) * ${String(MILLISECONDS_PER_SECOND)} + ${fraction} - (${offsetMinutes}) * ${String(MILLISECONDS_PER_MINUTE)} END)`;
}

const INSTANT =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[T ](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.(?<fraction>\d+))?(?:Z|(?<sign>[+-])(?<zoneHour>\d{2}):(?<zoneMinute>\d{2}))$/u;

const LAST_HOUR = 23;
const LAST_MINUTE_OR_SECOND = 59;

/**
 * The bind value of an `instantLiteral` for SQLite: the whole milliseconds since the epoch of a text in the grammar above, computed from its parts with the rules the SQL applies to a stored value, or `null` (unknown) for any other text.
 */
export function sqliteInstantParameter(iso: string): number | null {
  const groups = INSTANT.exec(iso)?.groups;
  if (groups === undefined) return null;
  const part = (name: string): number => Number(groups[name] ?? 0);
  const [year, month, day] = [part("year"), part("month"), part("day")];
  const moment = new Date(0);
  moment.setUTCFullYear(year, month - 1, day);
  moment.setUTCHours(part("hour"), part("minute"), part("second"), 0);
  // A date that does not exist (month 13, `02-30`) rolls over into another one, which the round trip shows.
  const exists =
    moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 &&
    moment.getUTCDate() === day;
  if (
    !exists ||
    part("hour") > LAST_HOUR ||
    part("minute") > LAST_MINUTE_OR_SECOND ||
    part("second") > LAST_MINUTE_OR_SECOND ||
    part("zoneHour") > LAST_HOUR ||
    part("zoneMinute") > LAST_MINUTE_OR_SECOND
  ) {
    return null;
  }
  const milliseconds = Number(
    `${groups.fraction ?? ""}00`.slice(0, FRACTION_DIGITS),
  );
  const offset =
    (groups.sign === "-" ? -1 : 1) *
    (part("zoneHour") * MINUTES_PER_HOUR + part("zoneMinute")) *
    MILLISECONDS_PER_MINUTE;

  return moment.getTime() + milliseconds - offset;
}
