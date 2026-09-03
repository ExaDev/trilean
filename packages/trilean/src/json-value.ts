import { z } from "zod";

/**
 * A JSON value with no further meaning imposed by this schema -- used for every opaque payload (reference keys, table identifiers, collection references, delegation payloads). "Opaque" means "uninterpreted by this package", not "untyped" -- every one of these must still be plain, serialisable JSON.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
