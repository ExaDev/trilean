import { readFileSync } from "node:fs";
import { keyProblems } from "./canonical-keys";

/** Strict: a file that is not valid UTF-8 is an error, never read with replacement characters, so every loader sees the same text (the Rust loader refuses such a file too). A byte order mark is kept in the text, not stripped, so it reaches the check that refuses it, as it does in the Rust loader. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Reads a corpus JSON file: strict UTF-8, valid JSON and canonical keys (see `canonical-keys.ts`). A file with any other key order, or a repeated key or an unpaired surrogate in a key, is an error, so every file a loader reads is in the one form. */
export function readJson(path: string): unknown {
  const text = decoder.decode(readFileSync(path));
  const parsed: unknown = JSON.parse(text);
  const problems = keyProblems(text);
  if (problems.length > 0) {
    throw new Error(`${path}: ${problems.join("; ")}`);
  }

  return parsed;
}
