/**
 * The shapes of the corpus cases this package executes, plus the kinds it validates against the schema but leaves to the package that owns them. `case.schema.json` is the definition; these types state what a document that passed it holds, so a value is trusted only after the schema has accepted it.
 */

/** The case kinds that belong to other packages: validated by the schema, never executed here. */
export const UNEXECUTED_KINDS = [
  "validate",
  "build",
  "call",
  "evaluate",
  "inputs",
  "document",
  "cli",
  "serialise",
  "number-format",
  "sql-compile",
  "sql-guard",
  "sql-pattern",
  "sql-execute",
] as const;

export type UnexecutedKind = (typeof UNEXECUTED_KINDS)[number];

/** The kinds this package executes. */
export const EXECUTED_KINDS = ["regex-parse", "regex-match"] as const;

/** The values of `skip`: the implementation that skips a case, never the host it runs on. */
export const SKIP_VALUES = ["ts", "rust"] as const;

/** A string as UTF-16 code units: a JSON string, or the code units themselves for content a JSON string cannot carry. */
export type Text = string | { readonly codeUnits: readonly number[] };

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

export type RegexParseExpectation =
  | { readonly ast: unknown }
  | { readonly astSubset: Readonly<Record<string, unknown>> }
  | {
      readonly error: {
        readonly index?: number;
        readonly message?: readonly Text[];
      };
    };

export interface RegexParseCase extends CaseBase {
  readonly kind: "regex-parse";
  readonly pattern: Text;
  readonly expect: RegexParseExpectation;
}

export interface RegexMatchCase extends CaseBase {
  readonly kind: "regex-match";
  /** `trilean`, the default, or `ecmascript` for a pattern the host's own `RegExp` reads, whose answers were recorded from it. */
  readonly dialect?: "trilean" | "ecmascript";
  readonly pattern: Text;
  readonly inputs: readonly {
    readonly input: Text;
    readonly matches: boolean;
  }[];
}

export interface UnexecutedCase extends CaseBase {
  readonly kind: UnexecutedKind;
}

export type CorpusCase = RegexParseCase | RegexMatchCase | UnexecutedCase;

export interface CorpusFile {
  readonly cases: readonly CorpusCase[];
}

export interface Manifest {
  readonly files: Readonly<
    Record<
      string,
      {
        readonly cases: number;
        /** Per implementation, the ids of the cases it skips because they are marked for it, each list in ascending order. */
        readonly skip: {
          readonly ts: readonly string[];
          readonly rust: readonly string[];
        };
        readonly generated?: true;
      }
    >
  >;
}
