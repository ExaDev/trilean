/**
 * The shapes of the corpus cases this package executes, plus the kinds it validates against the schema but leaves to the package that owns them. `case.schema.json` is the definition; these types state what a document that passed it holds, so a value is trusted only after the schema has accepted it.
 */

import type { JsonValue } from "../json-value";

/** Any JSON value, as a corpus file holds it. */
export type Json = JsonValue;

/** The kinds of the packages that are not this one: validated by the schema, never executed here. */
export const FOREIGN_KINDS = [
  "regex-parse",
  "regex-match",
  "sql-compile",
  "sql-guard",
  "sql-pattern",
  "sql-execute",
] as const;

/** The values of `skip`: the implementation that skips a case, never the host it runs on. */
export const SKIP_VALUES = ["ts", "rust"] as const;

export type Mode = "async" | "sync" | "compiled";

interface CaseBase {
  readonly id: string;
  readonly from: string;
  readonly skip?: (typeof SKIP_VALUES)[number];
  readonly reason?: string;
  readonly tolerance?: {
    readonly ulps?: number;
    readonly absolute?: number;
  };
}

export interface ValidateCase extends CaseBase {
  readonly kind: "validate";
  readonly schema: string;
  readonly input: Json;
  readonly expect:
    | { readonly ok: true; readonly value?: Json }
    | {
        readonly ok: false;
        readonly issues: readonly {
          readonly path: readonly (string | number)[];
          readonly message?: string;
        }[];
      };
}

export interface ComputedValueJson {
  readonly kind: string;
  readonly [key: string]: Json;
}

export type Resolution =
  | {
      readonly found: true;
      readonly value: ComputedValueJson;
      readonly settlesAfter?: number;
    }
  | {
      readonly found: false;
      readonly notYetKnown?: boolean;
      readonly settlesAfter?: number;
    }
  | { readonly throws: string; readonly settlesAfter?: number };

/** A context to match: any JSON value, or `*` (or omitted) for any context. */
export type ContextMatch = Json | undefined;

export interface ResolverData {
  readonly values?: readonly {
    readonly key: Json;
    readonly context?: ContextMatch;
    readonly result: Resolution;
  }[];
  readonly lookups?: readonly {
    readonly table: Json;
    readonly keys: readonly ComputedValueJson[];
    readonly context?: ContextMatch;
    readonly result: Resolution;
  }[];
  readonly collections?: readonly {
    readonly collection: Json;
    readonly context?: ContextMatch;
    readonly items: readonly Json[];
  }[];
  readonly delegates?: readonly {
    readonly system: string;
    readonly payload: Json;
    readonly context?: ContextMatch;
    readonly result: Resolution;
  }[];
  readonly trees?: readonly {
    readonly key: Json;
    readonly result:
      | { readonly found: true; readonly node: Json }
      | { readonly found: false; readonly notYetKnown?: boolean };
  }[];
  readonly fromContext?: boolean;
  readonly default?: Resolution;
}

export type EvaluateExpectation =
  | { readonly status: "definite"; readonly value?: Json }
  | {
      readonly status: "indeterminate";
      readonly code?: string;
      readonly message?: string;
      readonly messageIncludes?: readonly string[];
    }
  | {
      readonly throws: {
        readonly from: "resolver" | "function" | "type-error";
        readonly message?: string;
      };
    };

export interface ExpectedCall {
  readonly resolver: "value" | "lookup" | "collection" | "delegate" | "tree";
  readonly key?: Json;
  readonly table?: Json;
  readonly collection?: Json;
  readonly system?: string;
}

export interface EvaluateCase extends CaseBase {
  readonly kind: "evaluate";
  readonly as: "predicate" | "expression";
  readonly tree: Json;
  readonly context?: Json;
  readonly resolvers: ResolverData;
  readonly evaluator?: {
    readonly functions?: {
      readonly builtin?: boolean;
      readonly table?: Readonly<
        Record<
          string,
          readonly {
            readonly args: readonly ComputedValueJson[];
            readonly result: Json;
          }[]
        >
      >;
    };
    readonly maxNestingDepth?: Json;
    readonly maxNodes?: Json;
  };
  readonly modes?: readonly Mode[];
  readonly expect?: EvaluateExpectation;
  readonly expectCalls?: readonly ExpectedCall[];
}

/** The kinds this package has an executor for, which the schema must define and no others besides the foreign ones. */
export const EXECUTED_KINDS = [
  "validate",
  "build",
  "call",
  "evaluate",
  "inputs",
  "document",
  "cli",
  "serialise",
  "number-format",
] as const;

export interface BuildCase extends CaseBase {
  readonly kind: "build";
  readonly builder: string;
  readonly args: readonly Json[];
  readonly expect: Json;
}

export interface SerialiseCase extends CaseBase {
  readonly kind: "serialise";
  readonly schema: string;
  readonly input: string;
  readonly expect: string;
}

export interface NumberFormatCase extends CaseBase {
  readonly kind: "number-format";
  readonly value: Json;
  readonly expect: string;
}

export interface CliCase extends CaseBase {
  readonly kind: "cli";
  readonly args: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly expect: {
    readonly exit: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly stdoutJson?: Json;
    readonly stdoutJsonSubset?: Json;
    readonly stdoutExcludes?: readonly string[];
    readonly stderrIncludes?: readonly string[];
    readonly stderrStartsWith?: string;
  };
}

export interface InputsCase extends CaseBase {
  readonly kind: "inputs";
  readonly raw: Json;
  readonly expect:
    | { readonly ok: true; readonly inputs: Json; readonly collections: Json }
    | { readonly ok: false; readonly issues: readonly string[] };
}

export interface DocumentCase extends CaseBase {
  readonly kind: "document";
  readonly tree: Json;
  readonly as?: "predicate" | "expression";
  readonly inputs?: Json;
  readonly maxNodes?: Json;
  readonly expect?: Json;
  readonly expectSubset?: Json;
}

/** What a built-in function reports instead of a value: the failure and the fragments its message contains. */
export interface CallFailure {
  readonly domainError?: true;
  readonly wrongType?: true;
  readonly messageIncludes?: readonly string[];
}

export interface CallCase extends CaseBase {
  readonly kind: "call";
  readonly function: string;
  readonly args: readonly ComputedValueJson[];
  readonly expect: ComputedValueJson | CallFailure;
}

/** A trilean-regex parse case, of which this package reads only the tree to check its ranges and bounds. */
export interface RegexParseCase extends CaseBase {
  readonly kind: "regex-parse";
  readonly expect:
    | { readonly ast: unknown }
    | { readonly astSubset: unknown }
    | { readonly error: unknown };
}

/** A case of a kind this package has no executor for: a foreign kind, or one it does not run yet. */
export interface OtherCase extends CaseBase {
  readonly kind: Exclude<(typeof FOREIGN_KINDS)[number], "regex-parse">;
}

export type CorpusCase =
  | ValidateCase
  | EvaluateCase
  | CallCase
  | BuildCase
  | InputsCase
  | CliCase
  | DocumentCase
  | SerialiseCase
  | NumberFormatCase
  | RegexParseCase
  | OtherCase;

export interface CorpusFile {
  readonly cases: readonly CorpusCase[];
}

export interface Manifest {
  readonly files: Readonly<
    Record<string, { readonly cases: number; readonly skip: readonly string[] }>
  >;
}

export type Text = string | { readonly codeUnits: readonly number[] };
