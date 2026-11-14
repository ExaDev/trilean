import { join } from "node:path";
import { selectCorpusFiles } from "./corpus-files";
import type { CorpusFile } from "./corpus-types";
import { readJson } from "./read-json";
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

/** What the files of a corpus say about themselves, in the manifest's own shape: how many cases, and per implementation the ids marked to be skipped by it. */
function describeFiles(files: readonly LoadedFile[]): Record<string, string> {
  const marked = (file: CorpusFile, implementation: "ts" | "rust") =>
    file.cases
      .filter((testCase) => testCase.skip === implementation)
      .map((testCase) => testCase.id)
      .sort();

  return Object.fromEntries(
    files.map(({ name, file }) => [
      name,
      JSON.stringify({
        cases: file.cases.length,
        skip: { ts: marked(file, "ts"), rust: marked(file, "rust") },
      }),
    ]),
  );
}

/** What a runner records about itself while it runs: every case id at the moment it registers the case with the test framework, those it registers as skipped, and every case whose body starts. The three are written by the runner's own registration loop and test bodies, never computed from the parsed corpus, so a loop that drops or filters cases, a registration that skips more than the manifest allows and a body that never runs each show. */
export interface RunRecord {
  readonly registered: string[];
  readonly skipped: string[];
  readonly started: string[];
}

export function createRunRecord(): RunRecord {
  return { registered: [], skipped: [], started: [] };
}

/** What the registration of a case needs of it. */
export interface RegisteredCase {
  readonly id: string;
  readonly from: string;
  readonly skip?: string;
}

/**
 * The one registration loop of a runner: each case is recorded the moment it is registered, as skipped when it is marked for this implementation (`ts`), and again when its body starts, before the case runs. `define` hands the test to the test framework, saying whether it is registered as skipped; a case marked for the other implementation is registered to run.
 */
export function registerCases<Case extends RegisteredCase>(
  cases: readonly Case[],
  record: RunRecord,
  define: (title: string, skipped: boolean, body: () => Promise<void>) => void,
  run: (testCase: Case) => void | Promise<void>,
): void {
  for (const testCase of cases) {
    record.registered.push(testCase.id);
    const skipped = testCase.skip === "ts";
    if (skipped) {
      record.skipped.push(testCase.id);
    }
    define(`${testCase.id} (${testCase.from})`, skipped, async () => {
      record.started.push(testCase.id);
      await run(testCase);
    });
  }
}

/** The ids that occur more than once, each once. */
function repeated(ids: readonly string[]): readonly string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

/**
 * The completeness check of one implementation, from what the runner recorded and what the manifest says it must run: the manifest's total number of cases and the ids it lists for this implementation's skips. Registered must equal the total, no id may be registered twice, the ids registered as skipped must be exactly the manifest's list, and every registered case that is not skipped must have started, once. Cases marked for the other implementation are registered and run here.
 */
export function completenessProblems(
  manifest: { readonly total: number; readonly skip: readonly string[] },
  record: RunRecord,
): readonly string[] {
  const problems: string[] = [];
  const { registered, skipped, started } = record;
  if (registered.length !== manifest.total) {
    problems.push(
      `registered ${String(registered.length)} cases, and the manifest has ${String(manifest.total)}`,
    );
  }
  for (const id of repeated(registered)) {
    problems.push(`${id} is registered more than once`);
  }
  const registeredSet = new Set(registered);
  const skippedSet = new Set(skipped);
  for (const id of skippedSet) {
    if (!registeredSet.has(id)) {
      problems.push(`${id} is skipped and was never registered`);
    }
    if (!manifest.skip.includes(id)) {
      problems.push(`${id} is skipped here and not marked in the manifest`);
    }
  }
  for (const id of manifest.skip) {
    if (!skippedSet.has(id)) {
      problems.push(`${id} is marked in the manifest and not skipped here`);
    }
  }
  const startedSet = new Set(started);
  for (const id of repeated(started)) {
    problems.push(`${id} started more than once`);
  }
  for (const id of registeredSet) {
    if (!skippedSet.has(id) && !startedSet.has(id)) {
      problems.push(`${id} is registered to run and its body never started`);
    }
  }
  for (const id of startedSet) {
    if (!registeredSet.has(id) || skippedSet.has(id)) {
      problems.push(`${id} started and was not registered to run`);
    }
  }

  return problems;
}

export function checkCorpus(root: string): CheckedCorpus {
  const selection = selectCorpusFiles(root);
  const problems = selection.problems.map(
    (path) => `${path}: not a corpus file and not a recognised root file`,
  );
  const files: LoadedFile[] = [];
  const ids = new Set<string>();
  for (const name of selection.selected) {
    let document: unknown;
    try {
      document = readJson(join(root, name));
    } catch (error) {
      problems.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const result = validateCorpusFile(document);
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
        JSON.stringify({
          cases: entry.cases,
          skip: { ts: entry.skip.ts, rust: entry.skip.rust },
        }),
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
