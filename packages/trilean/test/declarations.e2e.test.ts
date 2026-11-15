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

describe("the package's declarations", () => {
  it.each([
    ["bundler", ts.ModuleResolutionKind.Bundler, ts.ModuleKind.ESNext],
    ["node16", ts.ModuleResolutionKind.Node16, ts.ModuleKind.Node16],
  ])(
    "compile with the ES library alone under %s resolution",
    (_name, moduleResolution, module) => {
      const directory = mkdtempSync(join(tmpdir(), "declarations-"));
      try {
        const file = join(directory, "consumer.mts");
        writeFileSync(file, CONSUMER);
        const program = ts.createProgram([file], {
          lib: ["lib.es2022.d.ts"],
          types: [],
          module,
          moduleResolution,
          target: ts.ScriptTarget.ES2022,
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        });
        const diagnostics = ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          );
        expect(diagnostics).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
