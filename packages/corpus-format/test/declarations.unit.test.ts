import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** The declarations a consumer receives must compile in a project that has only the ECMAScript library: no DOM library, no `esnext.disposable`, no Node types. */

const ENTRY = resolve(import.meta.dirname, "../dist/index.js");

const CONSUMER = `
import {
  Completeness,
  CorpusFormatError,
  DecodeError,
  InternalError,
  checkCanonical,
  compare,
  decode,
  fragments,
  keyProblems,
  manifestProblems,
  select,
  subset,
  writeCanonical,
  type CaseSummary,
  type CorpusFile,
  type Mismatch,
  type Problem,
  type Selection,
  type Tolerance,
  type TreeEntry,
} from ${JSON.stringify(ENTRY)};
const entries: TreeEntry[] = [{ path: "a/b/c.json", kind: "file" }];
const selection: Selection = select(entries, 2);
const problem: Problem | undefined = checkCanonical(new Uint8Array());
const problems: Problem[] = keyProblems(new Uint8Array());
const text: string = writeCanonical("{}");
const value: unknown = decode("{}");
const tolerance: Tolerance = { ulps: 1 };
const mismatch: Mismatch | undefined = compare(value, value, tolerance);
const part: Mismatch | undefined = subset(value, value, undefined);
const why: string | undefined = fragments(text, ["a"], true);
const cases: CaseSummary[] = [{ id: "a", skip: "ts" }];
const files: CorpusFile[] = [{ name: "a/b/c.json", cases }];
const listed: string[] = manifestProblems(files, "{}", 2);
const completeness = new Completeness("a/");
completeness.register("a");
completeness.started("a");
completeness.skipped("a", "why");
const unfinished: string[] = completeness.finish("{}", "ts", [], 2);
completeness.free();
export const results: unknown[] = [selection, problem, problems, mismatch, part, why, listed, unfinished, CorpusFormatError, DecodeError, InternalError];
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
