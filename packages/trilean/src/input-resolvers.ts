import type { ComputedValue } from "./computed-value";
import { ComputedValueSchema } from "./computed-value";
import type { SyncResolvers } from "./resolvers";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain JSON number, string or boolean is the unit-less value of that kind; anything else must already be a complete `ComputedValue` (the only way to supply units, durations, instants or complex values). */
function toComputedValue(raw: unknown): ComputedValue | undefined {
  if (typeof raw === "number") return { kind: "number", value: raw };
  if (typeof raw === "string") return { kind: "text", value: raw };
  if (typeof raw === "boolean") return { kind: "boolean", value: raw };
  const parsed = ComputedValueSchema.safeParse(raw);

  return parsed.success ? parsed.data : undefined;
}

export type InputsParseResult =
  | { ok: true; inputs: ReadonlyMap<string, ComputedValue> }
  | { ok: false; issues: readonly string[] };

/**
 * Validates a plain object of named inputs, one `ComputedValue` per name (see `toComputedValue` for the accepted shapes). Every entry is checked up front, so a malformed input is reported as one by name rather than surfacing later as a `not-found` reference.
 */
export function parseInputs(raw: unknown): InputsParseResult {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      issues: ["inputs must be a JSON object of named values"],
    };
  }
  const inputs = new Map<string, ComputedValue>();
  const issues: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const computed = toComputedValue(value);
    if (computed === undefined) {
      issues.push(
        `inputs.${name}: expected a number, text, boolean or a complete computed value`,
      );
    } else {
      inputs.set(name, computed);
    }
  }

  return issues.length === 0 ? { ok: true, inputs } : { ok: false, issues };
}

/**
 * Synchronous resolvers over a fixed set of named inputs: a `reference` whose key is a string naming an input resolves to it, and every other key, and every `lookup`, is `not-found`. `resolveCollection` throws, because a fixed map of scalars has no collection to hand back and an empty list would silently change what a `fold`, `some` or `every` means; `delegate` and `treeReference` nodes are left unresolved, so they are `wrong-type` like any node whose optional resolver is absent.
 */
export function createInputResolvers(
  inputs: ReadonlyMap<string, ComputedValue>,
): SyncResolvers {
  return {
    resolveValue: (key) => {
      const value = typeof key === "string" ? inputs.get(key) : undefined;

      return value === undefined ? { found: false } : { found: true, value };
    },
    resolveLookup: () => ({ found: false }),
    resolveCollection: (collection) => {
      throw new Error(
        `collection ${JSON.stringify(collection)} cannot be resolved: named inputs hold scalar values only`,
      );
    },
  };
}
