import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The declarations a consumer receives must compile in a project that has only the ECMAScript library: no DOM library, no `esnext.disposable`, no Node types, whichever way modules are resolved. */

const ENTRY = resolve(import.meta.dirname, "../dist/index.js");

const CONSUMER = `
import {
  ExpressionNodeSchema,
  PredicateNodeSchema,
  count,
  expressionKinds,
  predicateKinds,
  type ExpressionNode,
  type PredicateNode,
  type StandardSchemaV1,
  type TrileanSchema,
} from ${JSON.stringify(ENTRY)};

const schema: TrileanSchema<PredicateNode> = PredicateNodeSchema;
const standard: StandardSchemaV1<unknown, ExpressionNode> = ExpressionNodeSchema;
const result = standard["~standard"].validate({ kind: "numberLiteral", value: 1 });
const kinds: readonly string[] = [...predicateKinds, ...expressionKinds];
const fold: ExpressionNode = count("items", { filter: undefined });
export const results: unknown[] = [schema.jsonSchema, result, kinds, fold];
`;

const ZOD_ENTRY = resolve(import.meta.dirname, "../dist/zod.js");

/** A dependant of `trilean/zod` that exports Zod schemas built from it without writing their types, so the declarations it emits have to name them: a recursive tree whose type TypeScript expanded instead would fail with TS7056. */
const ZOD_CONSUMER = `
import * as z from "zod";
import { ExpressionNodeSchema, PredicateNodeSchema, toZod } from ${JSON.stringify(ZOD_ENTRY)};
import { UnitSchema, type PredicateNode } from ${JSON.stringify(ENTRY)};

export const Rules = z.array(z.object({ when: PredicateNodeSchema.optional(), value: ExpressionNodeSchema }));
export const Units = z.record(z.string(), toZod(UnitSchema));
export const tree: PredicateNode | undefined = Rules.parse([])[0]?.when;
export type Rule = z.infer<typeof Rules>[number];
`;

/** How a dependant is compiled: written to a new directory under `parent`, with the libraries `lib`, its declarations emitted when `declaration` is set. */
interface Compilation {
  readonly source: string;
  readonly parent: string;
  readonly lib: readonly string[];
  readonly declaration: boolean;
}

/** The ECMAScript library alone, which is all a dependant of the package needs. */
const ES_ONLY: Compilation = {
  source: CONSUMER,
  parent: tmpdir(),
  lib: ["lib.es2022.d.ts"],
  declaration: false,
};

/** The dependant of `trilean/zod`, written under this package's `node_modules` so `zod` resolves to the version the package is tested with. Zod's own declarations name `URL`, which the ECMAScript library does not declare, so it is compiled with the WebWorker library too, as any dependant of Zod is compiled with a library or types that declare it; `trilean/zod` needs nothing beyond what Zod needs. */
const WITH_ZOD: Compilation = {
  source: ZOD_CONSUMER,
  parent: resolve(import.meta.dirname, "../node_modules"),
  lib: ["lib.es2022.d.ts", "lib.webworker.d.ts"],
  declaration: true,
};

/** The diagnostics of compiling a dependant under one module resolution. */
function diagnosticsOf(
  { source, parent, lib, declaration }: Compilation,
  moduleResolution: ts.ModuleResolutionKind,
  module: ts.ModuleKind,
): readonly string[] {
  const directory = mkdtempSync(join(parent, ".declarations-"));
  try {
    const file = join(directory, "consumer.mts");
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      lib: [...lib],
      types: [],
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      skipLibCheck: false,
      ...(declaration
        ? { declaration: true, emitDeclarationOnly: true }
        : { noEmit: true }),
    });
    const emitted = declaration
      ? program.emit(undefined, () => undefined).diagnostics
      : [];

    return [...ts.getPreEmitDiagnostics(program), ...emitted].map(
      (diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const RESOLUTIONS = [
  ["bundler", ts.ModuleResolutionKind.Bundler, ts.ModuleKind.ESNext],
  ["node16", ts.ModuleResolutionKind.Node16, ts.ModuleKind.Node16],
] as const;

describe("the package's declarations", () => {
  it.each(RESOLUTIONS)(
    "compile with the ES library alone under %s resolution",
    (_name, moduleResolution, module) => {
      expect(diagnosticsOf(ES_ONLY, moduleResolution, module)).toEqual([]);
    },
  );

  it.each(RESOLUTIONS)(
    "compile with zod, and name the types of schemas built from them in the declarations a dependant emits, under %s resolution",
    (_name, moduleResolution, module) => {
      expect(diagnosticsOf(WITH_ZOD, moduleResolution, module)).toEqual([]);
    },
  );
});
