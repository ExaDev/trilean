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

/** The entries a value holds, counted over every list in it: a list holds one entry per item plus the entries of each item that is itself a list, and any other value holds none. It is what `maxValueEntries` bounds and what a `call` is charged for the lists it is given. */
export function valueEntryCount(value: ComputedValue): number {
  if (value.kind !== "list") return 0;

  return value.items.reduce(
    (total, item) => total + 1 + valueEntryCount(item),
    0,
  );
}
