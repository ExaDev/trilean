import { describe, expect, it } from "vitest";
import type { CliIo } from "../../cli/run";
import { DEFAULT_MAX_EVALUATION_NODES } from "../../src/evaluator-budget";
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
    expect(captured.stderr()).toBe(
      "(root): a treeReference is valid as a predicate and as an expression; pass --as predicate or --as expression\n",
    );
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
      "a tree that needs a list the inputs do not hold",
      ["evaluate", "fold.json"],
      {
        "fold.json": JSON.stringify({
          kind: "fold",
          collection: "loads",
          combiner: { mode: "max", item: { kind: "numberLiteral", value: 1 } },
        }),
      },
      /evaluation could not run: .*the inputs hold no list of items under that name/,
    ],
    [
      "a list with an element that is not an object of values",
      ["evaluate", "fold.json", "--inputs", "in.json"],
      {
        "fold.json": JSON.stringify({
          kind: "fold",
          collection: "loads",
          combiner: { mode: "max", item: { kind: "numberLiteral", value: 1 } },
        }),
        "in.json": '{"loads":[1]}',
      },
      /inputs\.loads\[0\]: expected an object of named values/,
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

  it("names standard input, not a dash, when it is not valid JSON", () => {
    const captured = capture({ "-": "{" });

    expect(run(["evaluate", "-"], captured.io)).toBe(EXIT_REJECTED);
    expect(captured.stderr()).toMatch(/^standard input is not valid JSON: /);
  });

  it("names standard input, not a dash, when it cannot be read", () => {
    const captured = capture({});

    expect(run(["evaluate", "-"], captured.io)).toBe(EXIT_REJECTED);
    expect(captured.stderr()).toMatch(/^cannot read standard input: /);
  });

  it("names standard input for inputs that are not valid JSON", () => {
    const captured = capture({
      "t.json": JSON.stringify({ kind: "numberLiteral", value: 1 }),
      "-": "{",
    });

    expect(run(["evaluate", "t.json", "--inputs", "-"], captured.io)).toBe(
      EXIT_REJECTED,
    );
    expect(captured.stderr()).toMatch(/^standard input is not valid JSON: /);
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

    it("exits 2 for a quantifier over a list the inputs do not hold", () => {
      const captured = capture({ "t.json": JSON.stringify(quantified) });

      expect(run(["evaluate", "t.json"], captured.io)).toBe(EXIT_REJECTED);
      expect(captured.stderr()).toMatch(
        /the inputs hold no list of items under that name/,
      );
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

describe("trilean evaluate with lists of items and complex values", () => {
  /** The loss of life of IEC 60076-7 clause 6.4: the sum over the intervals of the ageing rate 2^((theta_h - 98) / 6) times the interval's hours. */
  const lossOfLife = JSON.stringify({
    kind: "fold",
    collection: "intervals",
    combiner: {
      mode: "reduce",
      initial: { kind: "numberLiteral", value: 0 },
      combine: {
        kind: "arithmetic",
        op: "add",
        left: { kind: "accumulator" },
        right: {
          kind: "arithmetic",
          op: "multiply",
          left: {
            kind: "arithmetic",
            op: "power",
            left: { kind: "numberLiteral", value: 2 },
            right: {
              kind: "arithmetic",
              op: "divide",
              left: {
                kind: "arithmetic",
                op: "subtract",
                left: { kind: "reference", key: "theta_h" },
                right: { kind: "numberLiteral", value: 98 },
              },
              right: { kind: "numberLiteral", value: 6 },
            },
          },
          right: { kind: "reference", key: "hours" },
        },
      },
    },
  });

  it("sums over a list of items in the inputs and exits 0", () => {
    const captured = capture({
      "life.json": lossOfLife,
      "in.json": JSON.stringify({
        intervals: [
          { theta_h: 98, hours: 24 },
          { theta_h: 110, hours: 2 },
          { theta_h: 86, hours: 10 },
        ],
      }),
    });

    expect(
      run(["evaluate", "life.json", "--inputs", "in.json"], captured.io),
    ).toBe(EXIT_DEFINITE);
    expect(JSON.parse(captured.stdout())).toMatchObject({
      status: "definite",
      value: { kind: "number", value: 34.5 },
    });
  });

  it("takes the magnitude of a complex input and exits 0", () => {
    const captured = capture({
      "t.json": JSON.stringify({
        kind: "call",
        fn: "magnitude",
        args: [{ kind: "reference", key: "z" }],
      }),
      "in.json": JSON.stringify({ z: { kind: "complex", re: 3, im: -4 } }),
    });

    expect(
      run(["evaluate", "t.json", "--inputs", "in.json"], captured.io),
    ).toBe(EXIT_DEFINITE);
    expect(JSON.parse(captured.stdout())).toMatchObject({
      status: "definite",
      value: { kind: "number", value: 5 },
    });
  });

  describe("the node budget", () => {
    /** The loss-of-life sum over a load profile: two to the power of (hot-spot temperature minus 98) over 6, times the interval's hours, summed over the intervals. */
    const ageing = {
      kind: "fold",
      collection: "intervals",
      combiner: {
        mode: "reduce",
        initial: { kind: "numberLiteral", value: 0 },
        combine: {
          kind: "arithmetic",
          op: "add",
          left: { kind: "accumulator" },
          right: {
            kind: "arithmetic",
            op: "multiply",
            left: {
              kind: "arithmetic",
              op: "power",
              left: { kind: "numberLiteral", value: 2 },
              right: {
                kind: "arithmetic",
                op: "divide",
                left: {
                  kind: "arithmetic",
                  op: "subtract",
                  left: { kind: "reference", key: "theta_h" },
                  right: { kind: "numberLiteral", value: 98 },
                },
                right: { kind: "numberLiteral", value: 6 },
              },
            },
            right: { kind: "reference", key: "hours" },
          },
        },
      },
    };
    const ageingTree = JSON.stringify(ageing);
    /** The objects in a parsed tree that are nodes, which is what the evaluator's budget counts visits to. */
    function countNodes(value: unknown): number {
      if (Array.isArray(value)) {
        return value.reduce(
          (sum: number, element) => sum + countNodes(element),
          0,
        );
      }
      if (typeof value !== "object" || value === null) return 0;
      const own = "kind" in value ? 1 : 0;

      return Object.values(value).reduce(
        (sum: number, child) => sum + countNodes(child),
        own,
      );
    }
    const minutesInADay = 1440;
    const minutesPerHour = 60;
    const hoursPerMinute = 1 / minutesPerHour;
    const coolTemperature = 98;
    const hotTemperature = 104;
    const intervals = Array.from(
      { length: minutesInADay },
      (_unused, index) => ({
        theta_h: index % 2 === 0 ? coolTemperature : hotTemperature,
        hours: hoursPerMinute,
      }),
    );
    const files = {
      "life.json": ageingTree,
      "day.json": JSON.stringify({ intervals }),
    };
    const combineNodes = countNodes(ageing.combiner.combine);
    /** The fold and its initial value are visited once, and the combine expression once for every item. */
    const nodesNeeded =
      countNodes(ageing) + (intervals.length - 1) * combineNodes;
    // Half the minutes at weight 1 and half at weight 2, over 1/60 hour each: 12 + 24 hours of ageing.
    const expectedLoss = 36;
    const precisionDigits = 9;

    it("stops a day at one-minute resolution under the default budget", () => {
      const captured = capture(files);

      expect(
        run(["evaluate", "life.json", "--inputs", "day.json"], captured.io),
      ).toBe(EXIT_INDETERMINATE);
      expect(nodesNeeded).toBeGreaterThan(DEFAULT_MAX_EVALUATION_NODES);
      expect(captured.stdout()).toMatch(
        new RegExp(
          `exceeded the maximum of ${String(DEFAULT_MAX_EVALUATION_NODES)} nodes`,
        ),
      );
    });

    it("evaluates it with a raised budget", () => {
      const captured = capture(files);

      expect(
        run(
          [
            "evaluate",
            "life.json",
            "--inputs",
            "day.json",
            "--max-nodes",
            String(nodesNeeded),
          ],
          captured.io,
        ),
      ).toBe(EXIT_DEFINITE);
      const printed: unknown = JSON.parse(captured.stdout());
      expect(printed).toMatchObject({ status: "definite" });
      const value =
        typeof printed === "object" &&
        printed !== null &&
        "value" in printed &&
        typeof printed.value === "object" &&
        printed.value !== null &&
        "value" in printed.value
          ? printed.value.value
          : undefined;
      expect(value).toBeCloseTo(expectedLoss, precisionDigits);
    });

    it("stops the same tree one node short of what it needs", () => {
      const captured = capture(files);

      expect(
        run(
          [
            "evaluate",
            "life.json",
            "--inputs",
            "day.json",
            "--max-nodes",
            String(nodesNeeded - 1),
          ],
          captured.io,
        ),
      ).toBe(EXIT_INDETERMINATE);
      expect(captured.stdout()).toMatch(
        new RegExp(`exceeded the maximum of ${String(nodesNeeded - 1)} nodes`),
      );
    });

    it("lowers the budget below the default as well as raising it", () => {
      const captured = capture({
        "t.json": JSON.stringify({
          kind: "arithmetic",
          op: "add",
          left: { kind: "numberLiteral", value: 1 },
          right: { kind: "numberLiteral", value: 2 },
        }),
      });
      const treeNodes = 3;

      expect(
        run(
          ["evaluate", "t.json", `--max-nodes=${String(treeNodes)}`],
          captured.io,
        ),
      ).toBe(EXIT_DEFINITE);
      const lowered = capture({ "t.json": captured.io.readText("t.json") });
      expect(
        run(
          ["evaluate", "t.json", `--max-nodes=${String(treeNodes - 1)}`],
          lowered.io,
        ),
      ).toBe(EXIT_INDETERMINATE);
    });

    it.each([
      "0",
      "-1",
      "1.5",
      "abc",
      "1e3",
      "+5",
      "",
      " 5",
      "9007199254740993",
    ])("rejects --max-nodes=%j and says what it takes", (value) => {
      const captured = capture({
        "t.json": JSON.stringify({ kind: "numberLiteral", value: 1 }),
      });

      expect(
        run(["evaluate", "t.json", `--max-nodes=${value}`], captured.io),
      ).toBe(EXIT_REJECTED);
      expect(captured.stderr()).toBe(
        `--max-nodes must be a positive safe integer, not ${JSON.stringify(value)}\n`,
      );
      expect(captured.stdout()).toBe("");
    });
  });

  describe("the phase of a complex value", () => {
    function phaseOf(tree: unknown, inputs: string) {
      const captured = capture({
        "t.json": JSON.stringify(tree),
        "in.json": inputs,
      });
      const status = run(
        ["evaluate", "t.json", "--inputs", "in.json"],
        captured.io,
      );

      return { status, printed: JSON.parse(captured.stdout()) as unknown };
    }
    const phase = {
      kind: "call",
      fn: "phase",
      args: [{ kind: "reference", key: "z" }],
    };

    it("is +pi for a negative real input written with a negative zero imaginary part", () => {
      const { status, printed } = phaseOf(
        phase,
        '{"z":{"kind":"complex","re":-2,"im":-0}}',
      );

      expect(status).toBe(EXIT_DEFINITE);
      expect(printed).toMatchObject({ value: { value: Math.PI } });
    });

    it("is +pi for the negation of a positive real, as it is for the input written directly", () => {
      const { status, printed } = phaseOf(
        {
          kind: "call",
          fn: "phase",
          args: [
            {
              kind: "negate",
              operand: { kind: "reference", key: "z" },
            },
          ],
        },
        '{"z":{"kind":"complex","re":2,"im":0}}',
      );

      expect(status).toBe(EXIT_DEFINITE);
      expect(printed).toMatchObject({ value: { value: Math.PI } });
    });

    it("is 0 for the negation of zero", () => {
      const { printed } = phaseOf(
        {
          kind: "call",
          fn: "phase",
          args: [
            {
              kind: "negate",
              operand: { kind: "reference", key: "z" },
            },
          ],
        },
        '{"z":{"kind":"complex","re":0,"im":0}}',
      );

      expect(printed).toMatchObject({ value: { value: 0 } });
    });
  });
});
