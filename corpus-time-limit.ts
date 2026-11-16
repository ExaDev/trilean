/** The one copy of the time limit for a test that walks the corpus: the workspace root's tests and every package's tests import this file by a relative path. It is not under any package, so no package's `files`, build or release picks it up. */

/**
 * The time limit of a test that walks the corpus, derived from the work it does and not from the runner's default of five seconds, which fits one file and not a corpus that grows (ExaDev/trilean#167). The limit is a fixed setup allowance plus the number of units the test handles times a ceiling per unit; a test names its units and passes the result as its `timeout`.
 *
 * The setup allowance covers what a test pays once whatever its size: importing a formatter or a schema compiler and resolving its configuration on a cold cache. A unit is one file read and checked, or one case validated. Each ceiling is about thirty times the cost of that work on a core to itself, a margin that a loaded shared host stays under and a walk that grew quadratic does not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** What a test pays once, for module loading and configuration on a cold cache. */
export const SETUP_ALLOWANCE_MS = 10_000;

/** The most one file may cost a test that reads and checks it: one parse and one or two schema validations of a document of a few kilobytes. */
export const FILE_CEILING_MS = 25;

/** The most one case may cost a test that validates every case of the corpus: its share of one schema validation. */
export const CASE_CEILING_MS = 10;

/** How many `.json` files lie under a directory, however deep: the work of a test that reads them all. */
export function jsonFilesUnder(directory: string): number {
  return readdirSync(directory, { recursive: true }).filter((name) =>
    String(name).endsWith(".json"),
  ).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many cases the corpus holds across all its files, as its manifest counts them: the work of a test that validates every case. */
export function manifestCases(corpusRoot: string): number {
  const manifest: unknown = JSON.parse(
    readFileSync(join(corpusRoot, "manifest.json"), "utf8"),
  );
  if (!isRecord(manifest) || !isRecord(manifest.files)) {
    throw new Error("the manifest holds no files");
  }

  return Object.values(manifest.files).reduce<number>(
    (sum, entry) =>
      sum +
      (isRecord(entry) && typeof entry.cases === "number" ? entry.cases : 0),
    0,
  );
}

/** The limit, in milliseconds, for a test that handles `files` files. */
export function fileLimit(files: number): number {
  return SETUP_ALLOWANCE_MS + files * FILE_CEILING_MS;
}

/** The limit, in milliseconds, for a test that handles `cases` cases. */
export function caseLimit(cases: number): number {
  return SETUP_ALLOWANCE_MS + cases * CASE_CEILING_MS;
}
