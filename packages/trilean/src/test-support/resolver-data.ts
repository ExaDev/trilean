import type { ComputedValue } from "../computed-value";
import type {
  Resolution as EvaluatorResolution,
  Resolvers,
  SyncResolvers,
} from "../resolvers";
import type { TreeResolution } from "../resolvers";
import type {
  ContextMatch,
  ExpectedCall,
  Json,
  Resolution,
  ResolverData,
} from "./corpus-types";
import { jsonEquals } from "./json-equal";
import { decodeNumbers, toComputedValue } from "./values";

/** One resolver call as the evaluator made it. */
export interface RecordedCall {
  readonly resolver: ExpectedCall["resolver"];
  readonly key?: Json;
  readonly table?: Json;
  readonly collection?: Json;
  readonly system?: string;
}

export interface ResolverSet {
  readonly sync: SyncResolvers;
  readonly asynchronous: Resolvers;
  readonly calls: RecordedCall[];
}

function matchesContext(wanted: ContextMatch, actual: unknown): boolean {
  return wanted === undefined || wanted === "*" || jsonEquals(actual, wanted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text an evaluator is given to read: a resolver's answer for a key read straight from a context object, as `fromContext` defines it. */
function fromContextValue(key: Json, context: unknown): EvaluatorResolution {
  if (typeof key !== "string" || !isRecord(context) || !(key in context)) {
    return { found: false };
  }
  const value = context[key];
  if (typeof value === "boolean") {
    return { found: true, value: { kind: "boolean", value } };
  }
  if (typeof value === "number") {
    return { found: true, value: { kind: "number", value } };
  }
  if (typeof value === "string") {
    return { found: true, value: { kind: "text", value } };
  }

  return { found: false };
}

/** A resolution the evaluator accepts, or the exception the data says the resolver throws. */
function settle(resolution: Resolution): EvaluatorResolution {
  if ("throws" in resolution) {
    throw new Error(resolution.throws);
  }
  if (resolution.found) {
    return { found: true, value: toComputedValue(resolution.value) };
  }

  return resolution.notYetKnown === undefined
    ? { found: false }
    : { found: false, notYetKnown: resolution.notYetKnown };
}

async function delay(turns: number | undefined): Promise<void> {
  let waited = Promise.resolve();
  for (let turn = 0; turn < (turns ?? 0); turn += 1) {
    waited = waited.then(() => undefined);
  }

  return waited;
}

interface Answer<T> {
  /** The microtask turns an asynchronous resolver waits before answering. */
  readonly turns: number | undefined;
  /** The answer itself, or the exception the data says the resolver throws. */
  readonly give: () => T;
}

function answer(resolution: Resolution): Answer<EvaluatorResolution> {
  return { turns: resolution.settlesAfter, give: () => settle(resolution) };
}

/**
 * The resolvers a case's data describes, one set for the asynchronous evaluator and one for the synchronous evaluator and the compiled predicate, sharing one call log. The first entry whose key (and context) equals the call wins; a call nothing matches gets `default`, `{ found: false }` when absent; a collection nothing matches is empty; `resolveDelegate` and `resolveTree` exist only when the data lists any.
 */
export function buildResolvers(data: ResolverData): ResolverSet {
  const calls: RecordedCall[] = [];
  const fallback = data.default ?? { found: false };

  const value = (key: Json, context: unknown): Answer<EvaluatorResolution> => {
    calls.push({ resolver: "value", key });
    const entry = (data.values ?? []).find(
      (item) =>
        jsonEquals(key, item.key) && matchesContext(item.context, context),
    );
    if (entry === undefined && data.fromContext === true) {
      const read = fromContextValue(key, context);
      if (read.found) {
        return { turns: undefined, give: () => read };
      }
    }

    return answer(entry?.result ?? fallback);
  };
  const lookup = (
    table: Json,
    keys: readonly ComputedValue[],
    context: unknown,
  ): Answer<EvaluatorResolution> => {
    calls.push({ resolver: "lookup", table });
    const entry = (data.lookups ?? []).find(
      (item) =>
        jsonEquals(table, item.table) &&
        jsonEquals(keys, item.keys) &&
        matchesContext(item.context, context),
    );

    return answer(entry?.result ?? fallback);
  };
  const collection = (name: Json, context: unknown): unknown[] => {
    calls.push({ resolver: "collection", collection: name });
    const entry = (data.collections ?? []).find(
      (item) =>
        jsonEquals(name, item.collection) &&
        matchesContext(item.context, context),
    );

    return entry === undefined ? [] : entry.items.map(decodeNumbers);
  };
  const delegate = (
    system: string,
    payload: Json,
    context: unknown,
  ): Answer<EvaluatorResolution> => {
    calls.push({ resolver: "delegate", system });
    const entry = (data.delegates ?? []).find(
      (item) =>
        item.system === system &&
        jsonEquals(payload, item.payload) &&
        matchesContext(item.context, context),
    );

    return answer(entry?.result ?? fallback);
  };
  const tree = (key: Json): TreeResolution => {
    calls.push({ resolver: "tree", key });
    const entry = (data.trees ?? []).find((item) => jsonEquals(key, item.key));
    if (entry === undefined) {
      return { found: false };
    }

    return entry.result.found
      ? { found: true, node: decodeNumbers(entry.result.node) }
      : entry.result.notYetKnown === true
        ? { found: false, notYetKnown: true }
        : { found: false };
  };

  const hasDelegates = data.delegates !== undefined;
  const hasTrees = data.trees !== undefined;
  const sync: SyncResolvers = {
    resolveValue: (key, context) => value(key, context).give(),
    resolveLookup: (table, keys, context) =>
      lookup(table, keys, context).give(),
    resolveCollection: (name, context) => collection(name, context),
    ...(hasDelegates
      ? {
          resolveDelegate: (system, payload, context) =>
            delegate(system, payload, context).give(),
        }
      : {}),
    ...(hasTrees ? { resolveTree: (key) => tree(key) } : {}),
  };
  const later = async <T>(given: Answer<T>): Promise<T> => {
    await delay(given.turns);

    return given.give();
  };
  const asynchronous: Resolvers = {
    resolveValue: async (key, context) => later(value(key, context)),
    resolveLookup: async (table, keys, context) =>
      later(lookup(table, keys, context)),
    resolveCollection: async (name, context) =>
      Promise.resolve(collection(name, context)),
    ...(hasDelegates
      ? {
          resolveDelegate: async (system, payload, context) =>
            later(delegate(system, payload, context)),
        }
      : {}),
    ...(hasTrees
      ? { resolveTree: async (key) => Promise.resolve(tree(key)) }
      : {}),
  };

  return { sync, asynchronous, calls };
}
