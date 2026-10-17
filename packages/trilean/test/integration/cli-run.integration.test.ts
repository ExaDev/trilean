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

  it("prints usage on standard output for --help and exits 0", () => {
    const help = capture({});

    expect(run(["--help"], help.io)).toBe(EXIT_DEFINITE);
    expect(help.stdout()).toMatch(/^Usage: trilean evaluate/);
    expect(help.stderr()).toBe("");
  });

  it("prints usage on standard error and exits 2 when given no arguments", () => {
    const none = capture({});

    expect(run([], none.io)).toBe(EXIT_REJECTED);
    expect(none.stderr()).toMatch(/^Usage: trilean evaluate/);
    expect(none.stdout()).toBe("");
  });

  it("refuses to read both the tree and the inputs from standard input", () => {
    const captured = capture({
      "-": JSON.stringify({ kind: "numberLiteral", value: 1 }),
    });

    expect(run(["evaluate", "-", "--inputs", "-"], captured.io)).toBe(
      EXIT_REJECTED,
    );
    expect(captured.stderr()).toBe(
      "the tree and --inputs cannot both be read from standard input\n",
    );
    expect(captured.stdout()).toBe("");
  });

  it("takes the last of a repeated --inputs", () => {
    const captured = capture({
      "t.json": JSON.stringify({ kind: "reference", key: "x" }),
      "first.json": JSON.stringify({ x: 1 }),
      "second.json": JSON.stringify({ x: 2 }),
    });

    expect(
      run(
        [
          "evaluate",
          "t.json",
          "--inputs",
          "first.json",
          "--inputs",
          "second.json",
        ],
        captured.io,
      ),
    ).toBe(EXIT_DEFINITE);
    expect(JSON.parse(captured.stdout())).toMatchObject({
      value: { value: 2 },
    });
  });

  it("reports a wrong-type argument to a built-in as an indeterminate result, not a rejection", () => {
    const captured = capture({
      "t.json": JSON.stringify({
        kind: "call",
        fn: "minimum",
        args: [
          { kind: "numberLiteral", value: 1, unit: { m: 1 } },
          { kind: "numberLiteral", value: 2 },
        ],
      }),
    });

    expect(run(["evaluate", "t.json"], captured.io)).toBe(EXIT_INDETERMINATE);
    expect(JSON.parse(captured.stdout())).toMatchObject({
      status: "indeterminate",
      reason: { code: "wrong-type" },
    });
  });

  it("reports an overflow as a domain-error and never prints null", () => {
    const captured = capture({
      "t.json": JSON.stringify({
        kind: "arithmetic",
        op: "multiply",
        left: { kind: "numberLiteral", value: Number.MAX_VALUE },
        right: { kind: "numberLiteral", value: Number.MAX_VALUE },
      }),
    });

    expect(run(["evaluate", "t.json"], captured.io)).toBe(EXIT_INDETERMINATE);
    expect(captured.stdout()).not.toMatch(/null/);
    expect(JSON.parse(captured.stdout())).toMatchObject({
      reason: {
        code: "domain-error",
        message: "result is not a finite number",
      },
    });
  });

  it("rejects an input that is not finite, as the JSON text 1e999 parses to infinity", () => {
    const captured = capture({
      "t.json": JSON.stringify({ kind: "reference", key: "x" }),
      "in.json": '{"x":1e999}',
    });

    expect(
      run(["evaluate", "t.json", "--inputs", "in.json"], captured.io),
    ).toBe(EXIT_REJECTED);
    expect(captured.stderr()).toMatch(/inputs\.x: expected a finite number/);
  });

  describe("the resolvers the command cannot supply", () => {
    const quantified = {
      kind: "some",
      collection: "loads",
      item: {
        kind: "compare",
        op: "gt",
        left: { kind: "reference", key: "self" },
        right: { kind: "numberLiteral", value: 1 },
      },
    };

    it.each([
      [
        "a lookup is not-found",
        { kind: "lookup", table: "t", keys: [] },
        undefined,
        "not-found",
      ],
      [
        "a delegate is wrong-type",
        { kind: "delegate", system: "s", payload: null },
        undefined,
        "wrong-type",
      ],
      [
        "a treeReference is wrong-type",
        { kind: "treeReference", key: "k" },
        "predicate",
        "wrong-type",
      ],
    ])("%s, so the exit is 1", (_name, tree, as, code) => {
      const captured = capture({ "t.json": JSON.stringify(tree) });

      expect(
        run(
          as === undefined
            ? ["evaluate", "t.json"]
            : ["evaluate", "t.json", "--as", as],
          captured.io,
        ),
      ).toBe(EXIT_INDETERMINATE);
      expect(JSON.parse(captured.stdout())).toMatchObject({
        reason: { code },
      });
    });

    it("exits 2 for a quantifier over a collection", () => {
      const captured = capture({ "t.json": JSON.stringify(quantified) });

      expect(run(["evaluate", "t.json"], captured.io)).toBe(EXIT_REJECTED);
      expect(captured.stderr()).toMatch(/scalar values only/);
    });

    it("exits 2 even when a false operand would settle an `and`, because the evaluator asks for the collection", () => {
      const captured = capture({
        "t.json": JSON.stringify({
          kind: "and",
          left: {
            kind: "compare",
            op: "gt",
            left: { kind: "numberLiteral", value: 1 },
            right: { kind: "numberLiteral", value: 2 },
          },
          right: quantified,
        }),
      });

      expect(run(["evaluate", "t.json"], captured.io)).toBe(EXIT_REJECTED);
    });
  });

  it("prints the version for --version", () => {
    const captured = capture({});

    expect(run(["--version"], captured.io)).toBe(EXIT_DEFINITE);
    expect(captured.stdout()).toBe("9.9.9\n");
  });
});
