import { z } from "zod";

/** Dimension symbol -> exponent, e.g. `{ m: 1, s: -1 }` for metres per second. A bare symbol like `"kg"` is shorthand for `{ kg: 1 }`. */
export const UnitSchema = z.record(z.string(), z.number());
export type Unit = z.infer<typeof UnitSchema>;

export const DurationUnitSchema = z.enum(["ms", "s", "min", "h", "d"]);
export type DurationUnit = z.infer<typeof DurationUnitSchema>;

/**
 * A complex number can be authored as EITHER rectangular (`re`/`im`) OR polar (`magnitude`/`phase`, in radians) -- discriminated structurally by which fields are present, not by an extra `form` tag. `z.discriminatedUnion("kind", [...])` cannot host two members sharing one literal discriminant value (`kind: "complex"` twice; it throws at parse time), so the two shapes are a plain `z.union` of two `z.strictObject`s instead, and `ComputedValueSchema` below wraps its own existing discriminated union alongside this one rather than folding "complex" into it. See the "Complex values" section of README.md.
 */
export const ComplexRectangularSchema = z.strictObject({
  kind: z.literal("complex"),
  re: z.number(),
  im: z.number(),
  unit: UnitSchema.optional(),
});
export const ComplexPolarSchema = z.strictObject({
  kind: z.literal("complex"),
  magnitude: z.number(),
  phase: z.number(),
  unit: UnitSchema.optional(),
});
export const ComplexValueSchema = z.union([
  ComplexRectangularSchema,
  ComplexPolarSchema,
]);
export type ComplexValue = z.infer<typeof ComplexValueSchema>;

const CoreComputedValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("number"),
    value: z.number(),
    unit: UnitSchema.optional(),
  }),
  z.object({ kind: z.literal("text"), value: z.string() }),
  /** ISO-8601 timestamp. */
  z.object({ kind: z.literal("instant"), value: z.string() }),
  z.object({
    kind: z.literal("duration"),
    value: z.number(),
    unit: DurationUnitSchema,
  }),
]);

export const ComputedValueSchema = z.union([
  CoreComputedValueSchema,
  ComplexValueSchema,
]);
export type ComputedValue = z.infer<typeof ComputedValueSchema>;

/**
 * Normalises a complex value's rectangular components regardless of which form it was authored in -- the same treatment "Temporal values" already gives a `duration`, normalising every `DurationUnit` to milliseconds before combining two durations of different units. `'re' in value` narrows correctly here (unlike a single-object-with-optional-fields design) because `ComplexValue` is a genuine TS union of two distinct object types, not one type with optional fields plus a runtime check.
 */
export function toRectangular(value: ComplexValue): {
  re: number;
  im: number;
} {
  if ("re" in value) return { re: value.re, im: value.im };
  return {
    re: value.magnitude * Math.cos(value.phase),
    im: value.magnitude * Math.sin(value.phase),
  };
}

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
