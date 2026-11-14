import { expect } from "vitest";
import type { CliIo } from "../../cli/run";
import { run } from "../../cli/run";
import type { CliCase } from "./corpus-types";
import { jsonEquals, subsetMatches } from "./json-equal";
import { includesInOrder } from "./run-evaluate";

/** Runs the command over the case's in-memory files and standard input and compares the exit status and what it printed. */
export function runCliCase(testCase: CliCase): void {
  let out = "";
  let err = "";
  const io: CliIo = {
    readText: (path) => {
      const text = path === "-" ? testCase.stdin : testCase.files[path];
      if (text === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }

      return text;
    },
    writeStdout: (text) => {
      out += text;
    },
    writeStderr: (text) => {
      err += text;
    },
    version: "0.0.0",
  };
  const status = run(testCase.args, io);
  const wanted = testCase.expect;
  const label = `${testCase.id}: stdout ${JSON.stringify(out)}, stderr ${JSON.stringify(err)}`;
  expect(status, label).toBe(wanted.exit);
  if (wanted.stdout !== undefined) {
    expect(out, label).toBe(wanted.stdout);
  }
  if (wanted.stderr !== undefined) {
    expect(err, label).toBe(wanted.stderr);
  }
  if (wanted.stdoutJson !== undefined) {
    const printed: unknown = JSON.parse(out);
    expect(
      jsonEquals(printed, wanted.stdoutJson, testCase.tolerance),
      label,
    ).toBe(true);
  }
  if (wanted.stdoutJsonSubset !== undefined) {
    const printed: unknown = JSON.parse(out);
    expect(
      subsetMatches(printed, wanted.stdoutJsonSubset, testCase.tolerance),
      label,
    ).toBe(true);
  }
  for (const fragment of wanted.stdoutExcludes ?? []) {
    expect(out.includes(fragment), `${label}: stdout holds ${fragment}`).toBe(
      false,
    );
  }
  if (wanted.stderrIncludes !== undefined) {
    expect(includesInOrder(err, wanted.stderrIncludes), label).toBe(true);
  }
  if (wanted.stderrStartsWith !== undefined) {
    expect(err.startsWith(wanted.stderrStartsWith), label).toBe(true);
  }
}
