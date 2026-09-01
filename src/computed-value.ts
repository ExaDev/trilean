import { z } from "zod";

/** Dimension symbol -> exponent, e.g. `{ m: 1, s: -1 }` for metres per second. A bare symbol like `"kg"` is shorthand for `{ kg: 1 }`. */
export const UnitSchema = z.record(z.string(), z.number());
export type Unit = z.infer<typeof UnitSchema>;

export const DurationUnitSchema = z.enum(["ms", "s", "min", "h", "d"]);
export type DurationUnit = z.infer<typeof DurationUnitSchema>;

export const ComputedValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("number"),
    value: z.number(),
    unit: UnitSchema.optional(),
  }),
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  /** ISO-8601 timestamp. */
  z.object({ kind: z.literal("instant"), value: z.string() }),
  z.object({
    kind: z.literal("duration"),
    value: z.number(),
    unit: DurationUnitSchema,
  }),
  /** Stored canonically in rectangular form -- `re` + `im`i -- rather than as a magnitude and phase, and with no `form` discriminant offering both: see the "Complex values" section of README.md for why one canonical form is the whole point, and `complex.ts` for the polar builder/accessor helpers that make the other form reachable without a second encoding of the same value. */
  z.object({
    kind: z.literal("complex"),
    re: z.number(),
    im: z.number(),
    unit: UnitSchema.optional(),
  }),
]);
export type ComputedValue = z.infer<typeof ComputedValueSchema>;

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
