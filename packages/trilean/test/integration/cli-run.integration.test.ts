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

describe("trilean evaluate", () => {
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

  it("names standard input, not a dash, when it cannot be read", () => {
    const captured = capture({});

    expect(run(["evaluate", "-"], captured.io)).toBe(EXIT_REJECTED);
    expect(captured.stderr()).toMatch(/^cannot read standard input: /);
  });

  it("prints the version for --version", () => {
    const captured = capture({});

    expect(run(["--version"], captured.io)).toBe(EXIT_DEFINITE);
    expect(captured.stdout()).toBe("9.9.9\n");
  });
});

describe("trilean evaluate with lists of items and complex values", () => {
  /** The loss of life of IEC 60076-7 clause 6.4: the sum over the intervals of the ageing rate 2^((theta_h - 98) / 6) times the interval's hours. */
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
  });
});
