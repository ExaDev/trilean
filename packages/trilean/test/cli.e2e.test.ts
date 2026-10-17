// Runs the built command (dist-cli/trilean.mjs) as a child process, the way `npx trilean` does, so what is checked is the shipped file: its shebang line, its bundled dependencies, its stdin handling and its exit status. The `bin` entry in package.json must name that same file, which is checked here too.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const binPath = fileURLToPath(
  new URL("../dist-cli/trilean.mjs", import.meta.url),
);

function runCli(args: readonly string[], stdin?: string) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    input: stdin,
  });
}

describe("the trilean command", () => {
  it("is the file package.json's bin names, with a node shebang", () => {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    expect(manifest).toMatchObject({
      bin: { trilean: "./dist-cli/trilean.mjs" },
    });
    expect(existsSync(binPath)).toBe(true);
    expect(statSync(binPath).size).toBeGreaterThan(0);
    expect(
      readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node\n"),
    ).toBe(true);
  });

  it("evaluates a tree read from standard input and exits 0", () => {
    const result = runCli(
      ["evaluate", "-"],
      JSON.stringify({
        kind: "call",
        fn: "squareRoot",
        args: [{ kind: "numberLiteral", value: 49 }],
      }),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "definite",
      value: { kind: "number", value: 7 },
    });
  });

  it("exits 1 for an indeterminate result", () => {
    const result = runCli(
      ["evaluate", "-"],
      JSON.stringify({ kind: "reference", key: "absent" }),
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "indeterminate",
    });
  });

  it("exits 2 with the problem on standard error for an invalid tree", () => {
    const result = runCli(["evaluate", "-"], '{"kind":"nope"}');

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/kind: /);
    expect(result.stdout).toBe("");
  });

  it("reports the package version", () => {
    const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : undefined;

    expect(runCli(["--version"]).stdout.trim()).toBe(version);
  });
});
