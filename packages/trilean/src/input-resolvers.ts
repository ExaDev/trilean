import type { ComputedValue } from "./computed-value";
import { ComputedValueSchema } from "./computed-value";
import { isPlainRecord } from "./plain-record";
import type { SyncResolvers } from "./resolvers";

/** A plain JSON number, string or boolean is the unit-less value of that kind; anything else must already be a complete `ComputedValue` (the only way to supply units, durations, instants or complex values). Both routes end in `ComputedValueSchema`, so a number that is not finite (`1e999` parses to `Infinity`) is refused whichever way it was written, and a field the schema does not define is dropped rather than carried along. */
function toComputedValue(raw: unknown): ComputedValue | undefined {
  const candidate: unknown =
    typeof raw === "number"
      ? { kind: "number", value: raw }
      : typeof raw === "string"
        ? { kind: "text", value: raw }
        : typeof raw === "boolean"
          ? { kind: "boolean", value: raw }
          : raw;
  const parsed = ComputedValueSchema.safeParse(candidate);

  return parsed.success ? parsed.data : undefined;
}

/** One element of a list input: the named values a `reference` resolves against while a `fold`, `some` or `every` is evaluating that element. */
export type InputItem = ReadonlyMap<string, ComputedValue>;

export type InputsParseResult =
  | {
      ok: true;
      /** The named values: every entry that is not an array. */
      inputs: ReadonlyMap<string, ComputedValue>;
      /** The lists of items: every entry that is an array, which a `fold`, `some` or `every` names as its `collection`. */
      collections: ReadonlyMap<string, readonly InputItem[]>;
    }
  | { ok: false; issues: readonly string[] };

const NOT_A_VALUE =
  "expected a finite number, text, boolean or a complete computed value";

/** Every item this module has parsed, so a resolver can tell the item it is being asked about from any other evaluation context without trusting its shape. */
const parsedItems = new WeakSet<object>();

function isInputItem(context: unknown): context is InputItem {
  return (
    typeof context === "object" && context !== null && parsedItems.has(context)
  );
}

interface ParsedItem {
  item: InputItem | undefined;
  issues: readonly string[];
}

/** Validates one element of a list input: a plain object whose every entry is a value, each by the same rules as a top-level input. */
function parseItem(label: string, raw: unknown): ParsedItem {
  if (!isPlainRecord(raw)) {
    return {
      item: undefined,
      issues: [`${label}: expected an object of named values`],
    };
  }
  const item = new Map<string, ComputedValue>();
  const issues: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const computed = toComputedValue(value);
    if (computed === undefined) {
      issues.push(`${label}.${name}: ${NOT_A_VALUE}`);
    } else {
      item.set(name, computed);
    }
  }
  if (issues.length > 0) return { item: undefined, issues };
  parsedItems.add(item);

  return { item, issues };
}

/**
 * Validates a plain object of inputs and splits it into named values and lists of items. An entry that is an array is a list: every element must be an object of named values (see `toComputedValue` for the accepted shapes of each value), and the list is what a `fold`, `some` or `every` resolves its `collection` to. Any other entry is one named value. Every entry is checked up front, so a malformed input is reported as one by name and position rather than surfacing later as a `not-found` reference.
 */
export function parseInputs(raw: unknown): InputsParseResult {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      issues: ["inputs must be a JSON object of named values"],
    };
  }
  const inputs = new Map<string, ComputedValue>();
  const collections = new Map<string, readonly InputItem[]>();
  const issues: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const items: InputItem[] = [];
      value.forEach((element: unknown, index) => {
        const parsedItem = parseItem(
          `inputs.${name}[${String(index)}]`,
          element,
        );
        issues.push(...parsedItem.issues);
        if (parsedItem.item !== undefined) items.push(parsedItem.item);
      });
      collections.set(name, items);
      continue;
    }
    const computed = toComputedValue(value);
    if (computed === undefined) {
      issues.push(`inputs.${name}: ${NOT_A_VALUE}`);
    } else {
      inputs.set(name, computed);
    }
  }

  return issues.length === 0
    ? { ok: true, inputs, collections }
    : { ok: false, issues };
}

/**
 * Synchronous resolvers over named inputs and lists of items. A `reference` whose key is a string resolves to the value of that name: against the top-level inputs outside a `fold`, `some` or `every`, and against the current item alone inside one, since descending into a collection replaces the evaluation context with the item (an item does not see the top-level inputs, so a value an item needs is written into the item). Every other key, and every `lookup`, is `not-found`. `resolveCollection` returns the list of items the inputs hold under the collection's name, and throws for a collection the inputs do not hold: an empty list would silently change what a `fold`, `some` or `every` means, and a missing list is a mistake in the tree or the inputs, not an empty collection. `delegate` and `treeReference` nodes are left unresolved, so they are `wrong-type` like any node whose optional resolver is absent.
 */
export function createInputResolvers(
  inputs: ReadonlyMap<string, ComputedValue>,
  collections: ReadonlyMap<string, readonly InputItem[]> = new Map(),
): SyncResolvers {
  return {
    resolveValue: (key, context) => {
      const scope = isInputItem(context) ? context : inputs;
      const value = typeof key === "string" ? scope.get(key) : undefined;

      return value === undefined ? { found: false } : { found: true, value };
    },
    resolveLookup: () => ({ found: false }),
    resolveCollection: (collection) => {
      const items =
        typeof collection === "string"
          ? collections.get(collection)
          : undefined;
      if (items === undefined) {
        throw new Error(
          `collection ${JSON.stringify(collection)} cannot be resolved: the inputs hold no list of items under that name`,
        );
      }

      return [...items];
    },
  };
}
