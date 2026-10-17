import { describe, expect, it } from "vitest";
import type { CliIo } from "../../cli/run";
import {
  EXIT_DEFINITE,
  EXIT_INDETERMINATE,
  EXIT_REJECTED,
  run,
} from "../../cli/run";

interface Captured {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
}

/** An io over an in-memory file system; reading a path that is not in it throws as a missing file would. */
function capture(files: Readonly<Record<string, string>>): Captured {
  let out = "";
  let err = "";

  return {
    io: {
      readText: (path) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);

        return text;
      },
      writeStdout: (text) => {
        out += text;
      },
      writeStderr: (text) => {
        err += text;
      },
      version: "9.9.9",
    },
    stdout: () => out,
    stderr: () => err,
  };
}

const area = JSON.stringify({
  kind: "arithmetic",
  op: "multiply",
  left: { kind: "reference", key: "width" },
  right: { kind: "reference", key: "height" },
});

describe("trilean evaluate", () => {
  it("prints a definite result and exits 0", () => {
    const captured = capture({
      "area.json": area,
      "in.json": JSON.stringify({ width: 3, height: 4 }),
    });

    const status = run(
      ["evaluate", "area.json", "--inputs", "in.json"],
      captured.io,
    );

    expect(status).toBe(EXIT_DEFINITE);
    expect(JSON.parse(captured.stdout())).toEqual({
      status: "definite",
      value: { kind: "number", value: 12, unit: {} },
    });
    expect(captured.stderr()).toBe("");
  });

  it("prints an indeterminate result and exits 1 when an input is missing", () => {
    const captured = capture({ "area.json": area });

    const status = run(["evaluate", "area.json"], captured.io);

    expect(status).toBe(EXIT_INDETERMINATE);
    expect(JSON.parse(captured.stdout())).toMatchObject({
      status: "indeterminate",
      reason: { code: "not-found" },
    });
  });

  it("evaluates a predicate to a boolean", () => {
    const captured = capture({
      "p.json": JSON.stringify({
        kind: "compare",
        op: "lt",
        left: { kind: "numberLiteral", value: 1 },
        right: { kind: "numberLiteral", value: 2 },
      }),
    });

    expect(run(["evaluate", "p.json"], captured.io)).toBe(EXIT_DEFINITE);
    expect(JSON.parse(captured.stdout())).toEqual({
      status: "definite",
      value: true,
    });
  });

  it("reads the tree from standard input for -", () => {
    const captured = capture({
      "-": JSON.stringify({ kind: "numberLiteral", value: 7 }),
    });

    expect(run(["evaluate", "-"], captured.io)).toBe(EXIT_DEFINITE);
    expect(JSON.parse(captured.stdout())).toMatchObject({
      value: { value: 7 },
    });
  });

  it("passes --as through to a treeReference root", () => {
    const captured = capture({
      "t.json": JSON.stringify({ kind: "treeReference", key: "k" }),
    });

    expect(run(["evaluate", "t.json"], captured.io)).toBe(EXIT_REJECTED);
    expect(run(["evaluate", "t.json", "--as", "predicate"], captured.io)).toBe(
      EXIT_INDETERMINATE,
    );
  });

  it.each([
    [
      "a missing tree file",
      ["evaluate", "missing.json"],
      {},
      /cannot read missing\.json/,
    ],
    [
      "a tree that is not JSON",
      ["evaluate", "bad.json"],
      { "bad.json": "{" },
      /bad\.json is not valid JSON/,
    ],
    [
      "a missing inputs file",
      ["evaluate", "area.json", "--inputs", "none.json"],
      { "area.json": area },
      /cannot read none\.json/,
    ],
    [
      "a tree that fails its schema",
      ["evaluate", "bad.json"],
      { "bad.json": '{"kind":"nope"}' },
      /kind: /,
    ],
    [
      "inputs that are not values",
      ["evaluate", "area.json", "--inputs", "in.json"],
      { "area.json": area, "in.json": '{"width":null}' },
      /inputs\.width/,
    ],
    [
      "a tree that needs a collection",
      ["evaluate", "fold.json"],
      {
        "fold.json": JSON.stringify({
          kind: "fold",
          collection: "loads",
          combiner: { mode: "max", item: { kind: "numberLiteral", value: 1 } },
        }),
      },
      /evaluation could not run: .*scalar values only/,
    ],
    [
      "an invalid --as",
      ["evaluate", "a.json", "--as", "other"],
      { "a.json": "1" },
      /--as must be/,
    ],
    [
      "an unknown command",
      ["frobnicate", "a.json"],
      {},
      /expected: trilean evaluate/,
    ],
    ["an unknown flag", ["evaluate", "a.json", "--nope"], {}, /nope/],
    [
      "a surplus argument",
      ["evaluate", "a.json", "b.json"],
      {},
      /expected: trilean evaluate/,
    ],
  ])("exits 2 and explains %s", (_name, args, files, message) => {
    const captured = capture(files);

    expect(run(args, captured.io)).toBe(EXIT_REJECTED);
    expect(captured.stderr()).toMatch(message);
    expect(captured.stdout()).toBe("");
  });

  it("prints usage for --help and exits 0, and for no arguments exits 2", () => {
    const help = capture({});
    expect(run(["--help"], help.io)).toBe(EXIT_DEFINITE);
    expect(help.stdout()).toMatch(/^Usage: trilean evaluate/);

    const none = capture({});
    expect(run([], none.io)).toBe(EXIT_REJECTED);
    expect(none.stdout()).toMatch(/^Usage: trilean evaluate/);
  });

  it("prints the version for --version", () => {
    const captured = capture({});

    expect(run(["--version"], captured.io)).toBe(EXIT_DEFINITE);
    expect(captured.stdout()).toBe("9.9.9\n");
  });
});
