import type { ComputedValue, Unit } from "../generated/schemas.js";

export type {
  ComputedValue,
  DurationUnit,
  Unit,
} from "../generated/schemas.js";
export {
  ComputedValueSchema,
  DurationUnitSchema,
  UnitSchema,
} from "../generated/schemas.js";

/** Drops zero-exponent dimensions so that, e.g., dividing a unit by itself normalises to the same dimensionless `{}` as an absent unit -- without this, `{ m: 0 }` and `{}` would compare unequal despite representing the same dimension. */
function normalizeUnit(unit: Unit | undefined): Unit {
  if (unit === undefined) return {};
  const normalized: Unit = {};
  for (const [dimension, exponent] of Object.entries(unit)) {
    if (exponent !== 0) normalized[dimension] = exponent;
  }

  return normalized;
}

/** An operand with no `unit` is dimensionless (an empty map) for comparison purposes. */
export function unitsEqual(a: Unit | undefined, b: Unit | undefined): boolean {
  const normalizedA = normalizeUnit(a);
  const normalizedB = normalizeUnit(b);
  const dimensionsA = Object.keys(normalizedA);
  const dimensionsB = Object.keys(normalizedB);
  if (dimensionsA.length !== dimensionsB.length) return false;

  return dimensionsA.every(
    (dimension) => normalizedA[dimension] === normalizedB[dimension],
  );
}

/** Multiplying two unit-tagged numbers adds exponents per dimension. An operand with no `unit` is treated as dimensionless (an empty map). */
export function combineUnitsForMultiply(
  a: Unit | undefined,
  b: Unit | undefined,
): Unit {
  const normalizedA = normalizeUnit(a);
  const normalizedB = normalizeUnit(b);
  const combined: Unit = { ...normalizedA };
  for (const [dimension, exponent] of Object.entries(normalizedB)) {
    combined[dimension] = (combined[dimension] ?? 0) + exponent;
  }

  return normalizeUnit(combined);
}

/** Dividing two unit-tagged numbers subtracts exponents per dimension. An operand with no `unit` is treated as dimensionless (an empty map). */
export function combineUnitsForDivide(
  a: Unit | undefined,
  b: Unit | undefined,
): Unit {
  const normalizedA = normalizeUnit(a);
  const normalizedB = normalizeUnit(b);
  const combined: Unit = { ...normalizedA };
  for (const [dimension, exponent] of Object.entries(normalizedB)) {
    combined[dimension] = (combined[dimension] ?? 0) - exponent;
  }

  return normalizeUnit(combined);
}

/** The entries a value holds, counted over every list and matrix in it: a list holds one entry per item plus the entries of each item that is itself a list or matrix, a matrix holds one per cell, and any other value holds none. It is what `maxValueEntries` bounds and what a `call` is charged for the lists and matrices it is given. */
export function valueEntryCount(value: ComputedValue): number {
  if (value.kind === "matrix") {
    return value.rows.reduce((total, row) => total + row.length, 0);
  }
  if (value.kind !== "list") return 0;

  return value.items.reduce(
    (total, item) => total + 1 + valueEntryCount(item),
    0,
  );
}

/** Why a value is not a well-formed matrix, or `undefined` when it is, looked for through every list it holds: a matrix needs at least one row of at least one entry, every row the same length, and an `imaginary` part, when present, the same shape as `rows`. The generated schema cannot say this, so a value read from outside is checked with it. */
export function matrixShapeIssue(value: ComputedValue): string | undefined {
  if (value.kind === "list") {
    for (const item of value.items) {
      const issue = matrixShapeIssue(item);
      if (issue !== undefined) return issue;
    }

    return undefined;
  }
  if (value.kind !== "matrix") return undefined;
  const width = value.rows[0]?.length ?? 0;
  if (width === 0 || value.rows.some((row) => row.length !== width)) {
    return "a matrix needs at least one row, each with the same number of entries and at least one";
  }
  const { imaginary } = value;
  if (
    imaginary !== undefined &&
    (imaginary.length !== value.rows.length ||
      imaginary.some((row) => row.length !== width))
  ) {
    return "a matrix's imaginary part must have the same shape as its rows";
  }

  return undefined;
}
