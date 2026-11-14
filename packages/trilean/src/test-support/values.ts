import type { ComputedValue } from "../computed-value";
import type { Json } from "./corpus-types";

const NAMED_NUMBERS: Readonly<Record<string, number>> = {
  "-0": -0,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
  NaN: Number.NaN,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value with every `{ "$number": "-0" | "Infinity" | "-Infinity" | "NaN" }` replaced by the number it names, which is how a corpus file holds a number the canonical JSON form cannot (a negative zero is written as `0` there) or JSON cannot write. */
export function decodeNumbers(value: Json): Json;
export function decodeNumbers(value: unknown): unknown;
export function decodeNumbers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeNumbers);
  }
  if (!isRecord(value)) {
    return value;
  }
  const named = value.$number;
  if (typeof named === "string" && Object.keys(value).length === 1) {
    const decoded = NAMED_NUMBERS[named];
    if (decoded === undefined) {
      throw new Error(
        `$number names ${named}, which is not a number a corpus file names`,
      );
    }

    return decoded;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decodeNumbers(item)]),
  );
}

const COMPUTED_KINDS: ReadonlySet<string> = new Set([
  "number",
  "text",
  "boolean",
  "instant",
  "duration",
  "complex",
]);

function isComputedValue(value: unknown): value is ComputedValue {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    COMPUTED_KINDS.has(value.kind)
  );
}

/**
 * The computed value a corpus JSON value denotes. It is not run through the package's schema: the evaluator reads a resolver's answer without validating it, and a case may deliberately hand it a value the schema refuses (a non-finite number), which is what pins how the evaluator treats one.
 */
export function toComputedValue(value: Json): ComputedValue {
  const decoded = decodeNumbers(value);
  if (!isComputedValue(decoded)) {
    throw new Error(`not a computed value: ${JSON.stringify(value)}`);
  }

  return decoded;
}
