import type { ComputedValue, Unit } from "./computed-value";
import type { ComplexLiteralNode } from "./tree";

/**
 * The `complex` computed-value kind stores one canonical representation, rectangular (`re` + `im`i), with no `form` discriminant offering a polar alternative alongside it -- see the "Complex values" section of README.md for the reasoning. These four helpers are what keep the magnitude-and-phase view reachable for the domains that reason that way, as conversions at the edges rather than a second encoding of the same value that every operator would then have to branch on.
 *
 * Phase is in radians throughout, measured from the positive real axis, in the range [-pi, pi] that `complexPhase` below states, which differs from `Math.atan2`'s only for a zero imaginary part of either sign.
 */

type ComplexValue = Extract<ComputedValue, { kind: "complex" }>;
type NumberValue = Extract<ComputedValue, { kind: "number" }>;

export const complexFromPolar = (
  magnitude: number,
  phase: number,
  unit?: Unit,
): ComplexValue => ({
  kind: "complex",
  re: magnitude * Math.cos(phase),
  im: magnitude * Math.sin(phase),
  unit,
});

/** The `complexLiteral` node counterpart of `complexFromPolar`, for authoring a tree in polar terms; the conversion itself is done once, there, rather than repeated here. */
export const complexLiteralFromPolar = (
  magnitude: number,
  phase: number,
  unit?: Unit,
): ComplexLiteralNode => {
  const { re, im } = complexFromPolar(magnitude, phase, unit);

  return { kind: "complexLiteral", re, im, unit };
};

/** |z|, as a real number in the same unit the complex value itself carries -- the magnitude of an impedance in ohms is a real quantity in ohms. */
export const complexMagnitude = (value: ComplexValue): NumberValue => ({
  kind: "number",
  value: Math.hypot(value.re, value.im),
  unit: value.unit,
});

/**
 * arg(z), as a dimensionless real number of radians: an angle is a ratio of two lengths, so it carries no unit of its own regardless of what the value it was read from carried. The range is [-pi, pi]: `Math.atan2` returns -pi for a negative real number whose imaginary part is `-0` and +pi when it is `+0`, although the two are the same number and JSON writes both zeros as `0`, and the closed range is what the result can be because a tiny negative imaginary part also rounds to exactly -pi (`phase(-1 - 1e-17i)` is -pi, the true angle being a hair inside). Adding `+0` turns `-0` into `+0` without changing any other value, so a signed zero never gives -pi: a negative real number is +pi whatever the sign of its zero, and zero is 0.
 */
export const complexPhase = (value: ComplexValue): NumberValue => ({
  kind: "number",
  value: Math.atan2(value.im + 0, value.re + 0),
});
