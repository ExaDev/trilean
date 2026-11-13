import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectCorpusFiles } from "./corpus-files";
import type { CorpusFile } from "./corpus-types";
import { validateCorpusFile, validateManifest } from "./validate";

/**
 * Loads and checks a whole corpus root by every rule `conformance/README.md` states: the files selected, each file valid, ids unique across files, and the corpus equal to its manifest. The real corpus and every fixture corpus under `conformance/fixtures/corpora` go through this one function, so a rule has one definition.
 */

export interface LoadedFile {
  readonly name: string;
  readonly file: CorpusFile;
}

export interface CheckedCorpus {
  readonly files: readonly LoadedFile[];
  /** Everything wrong with the corpus; empty when it is sound. */
  readonly problems: readonly string[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** What the files of a corpus say about themselves, in the manifest's own shape. */
function describeFiles(files: readonly LoadedFile[]): Record<string, string> {
  return Object.fromEntries(
    files.map(({ name, file }) => [
      name,
      JSON.stringify({
        cases: file.cases.length,
        only: file.cases
          .filter((testCase) => testCase.only !== undefined)
          .map((testCase) => testCase.id)
          .sort(),
      }),
    ]),
  );
}

export function checkCorpus(root: string): CheckedCorpus {
  const selection = selectCorpusFiles(root);
  const problems = selection.problems.map(
    (path) => `${path}: not a corpus file and not a recognised root file`,
  );
  const files: LoadedFile[] = [];
  const ids = new Set<string>();
  for (const name of selection.selected) {
    const result = validateCorpusFile(readJson(join(root, name)));
    if (!result.ok) {
      problems.push(...result.problems.map((problem) => `${name}: ${problem}`));
      continue;
    }
    for (const { id } of result.value.cases) {
      if (ids.has(id)) {
        problems.push(`${name}: case id ${id} is used by another file`);
      }
      ids.add(id);
    }
    files.push({ name, file: result.value });
  }
  let manifest: ReturnType<typeof validateManifest>;
  try {
    manifest = validateManifest(readJson(join(root, "manifest.json")));
  } catch (error) {
    manifest = {
      ok: false,
      problems: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (!manifest.ok) {
    problems.push(
      ...manifest.problems.map((problem) => `manifest.json: ${problem}`),
    );
  } else {
    const recorded = Object.fromEntries(
      Object.entries(manifest.value.files).map(([name, entry]) => [
        name,
        JSON.stringify({ cases: entry.cases, only: entry.only }),
      ]),
    );
    const actual = describeFiles(files);
    for (const name of new Set([
      ...Object.keys(recorded),
      ...Object.keys(actual),
    ])) {
      if (recorded[name] !== actual[name]) {
        problems.push(
          `manifest.json does not match ${name}: the file holds ${actual[name] ?? "nothing"}, the manifest records ${recorded[name] ?? "nothing"}`,
        );
      }
    }
  }

  return { files, problems };
}
