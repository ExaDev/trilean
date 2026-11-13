/**
 * The shapes of the corpus cases this package executes, plus the kinds it validates against the schema but leaves to the package that owns them. `case.schema.json` is the definition; these types state what a document that passed it holds, so a value is trusted only after the schema has accepted it.
 */

/** The case kinds that belong to other packages: validated by the schema, never executed here. */
export type UnexecutedKind =
  | "validate"
  | "build"
  | "call"
  | "evaluate"
  | "inputs"
  | "document"
  | "cli"
  | "sql-compile"
  | "sql-guard"
  | "sql-pattern"
  | "sql-execute";

interface CaseBase {
  readonly id: string;
  readonly from: string;
  readonly only?: "js" | "native";
  readonly reason?: string;
  readonly tolerance?: { readonly ulps: number };
}

export type RegexParseExpectation =
  | { readonly ast: unknown }
  | { readonly astSubset: Readonly<Record<string, unknown>> }
  | {
      readonly error: {
        readonly index?: number;
        readonly message?: readonly string[];
      };
    };

export interface RegexParseCase extends CaseBase {
  readonly kind: "regex-parse";
  readonly pattern: string;
  readonly expect: RegexParseExpectation;
}

export interface RegexMatchCase extends CaseBase {
  readonly kind: "regex-match";
  readonly pattern: string;
  readonly inputs: readonly {
    readonly input: string;
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
    Record<string, { readonly cases: number; readonly only: readonly string[] }>
  >;
}
