import type { ComputedValue } from "../computed-value";
import { ComputedValueSchema } from "../computed-value";
import type { Json } from "./corpus-types";

/** The computed value a corpus JSON value denotes; a value the package's own schema refuses fails the case, since the case then pins nothing. */
export function toComputedValue(value: Json): ComputedValue {
  return ComputedValueSchema.parse(value);
}
