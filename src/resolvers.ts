import type { ComputedValue } from "./computed-value";
import type { JsonValue } from "./json-value";

/**
 * An opaque, purely in-process value supplied by the caller, never itself part of the serialised tree and never required to be JSON-serialisable. Descending into a `fold` or a quantifier replaces the context for the sub-node's evaluation with the single resolved item. Deliberately left as bare `unknown` rather than `Readonly<unknown>`: TypeScript's `Readonly<T>` mapped type collapses `unknown` to `{}`, which (unlike `unknown`) rejects `undefined` -- a legitimate context value for a context-free predicate. Every `context: EvaluationContext` parameter below therefore carries its own eslint-disable-next-line against exadev/prefer-readonly-object-param, which otherwise misfires here: its "flat object" check passes vacuously for any property-less type, `unknown` included.
 */
export type EvaluationContext = unknown;

export type Resolution =
  { found: true; value: ComputedValue } | { found: false };

/**
 * Three independent points of extension, each supplied separately by the embedding consumer, each treated as pure data to hand over -- never as resolver logic living inside the schema itself. Plain TypeScript interfaces, not Zod schemas: resolvers are never serialised, only ever supplied in-process at evaluation time.
 */
export interface Resolvers {
  /** Resolver 1 -- a single opaque key to a single value (`reference`). */
  resolveValue: (
    key: JsonValue,
    // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment above
    context: EvaluationContext,
  ) => Promise<Resolution>;

  /** Resolver 2 -- an opaque table identifier plus computed keys to a single value (`lookup`). */
  resolveLookup: (
    table: JsonValue,
    keys: readonly ComputedValue[],
    // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment above
    context: EvaluationContext,
  ) => Promise<Resolution>;

  /** Resolver 3 -- an opaque collection reference to a concrete list of items (`fold`/`some`/`every`). Always returns the full candidate list; narrowing which items participate is handled uniformly, after resolution, by each node's own `filter`. */
  resolveCollection: (
    collection: JsonValue,
    // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment above
    context: EvaluationContext,
  ) => Promise<unknown[]>;

  /** Optional, separate from the three core contracts -- see the `delegate` node kind. */
  resolveDelegate?: (
    system: string,
    payload: JsonValue,
    // eslint-disable-next-line exadev/prefer-readonly-object-param -- see EvaluationContext's own doc comment above
    context: EvaluationContext,
  ) => Promise<Resolution>;
}
