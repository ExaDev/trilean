import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_NESTING_DEPTH } from "./support/consumer-core.mjs";

/**
 * Where a host's stack gives out, measured and not recalled. The module is built with the limit on nesting lifted (`sh scripts/rust.sh xtask npm trilean --measure`, whose output the package does not ship), a value of each of several shapes is read at a depth found by bisection, and the deepest that is read without a trap is the depth at which the stack gives out for that shape, in the two stacks a read runs on: the module's own, which is 1 MiB, and a Node's call stack at its default, with the host's own frames beneath the module's. The limit is held to at most half of the smallest of them, so a reader at the limit has half of each stack to spare, and the measured depths are printed so that a change to the margin is a change anyone can read.
 */

const PACKAGE = resolve(import.meta.dirname, "..");
const MEASURE = resolve(PACKAGE, "measure");
const PROBE = resolve(import.meta.dirname, "support/depth-probe.mjs");
const SHAPES = [
  "negate chain",
  "nested call",
  "arithmetic left",
  "lookup keys",
  "conditional",
  "compare under not",
  "fold item",
  "allOf chain",
  "memberOf candidates",
  "arrays of arrays",
  "objects in arrays",
] as const;

/** The fraction of the smallest depth at which a stack gives out that the limit may be, which is the margin the documentation states. */
const MOST_OF_THE_SMALLEST = 0.5;
/** A stack far larger than the module's own, so that only the module's 1 MiB gives out. */
const LARGE_HOST_STACK_KB = 200_000;
const BUILD_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 900_000;
/** The deepest repetition tried: far more than any stack holds. */
const MOST_REPETITIONS = 200_000;
const FEWEST_REPETITIONS = 5;

function probe(shape: string, repetitions: number, stackKb?: number): string {
  const flags =
    stackKb === undefined ? [] : [`--stack-size=${String(stackKb)}`];

  return execFileSync(
    process.execPath,
    [...flags, PROBE, MEASURE, shape, String(repetitions)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** The deepest value of the shape, in levels of arrays and objects, that is read without a trap, found by bisection over how many times the shape is repeated. */
function deepest(shape: string, stackKb?: number): number {
  let low = FEWEST_REPETITIONS;
  let high = MOST_REPETITIONS;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (probe(shape, middle, stackKb).startsWith("trap")) {
      high = middle - 1;
    } else {
      low = middle;
    }
  }
  const levels = Number(probe(shape, low, stackKb).split(" ").at(-1));
  if (!Number.isInteger(levels)) {
    throw new Error(`the probe did not say how deep ${shape} is`);
  }

  return levels;
}

describe("the limit on nesting is well under where a stack gives out", () => {
  it(
    "is at most half of the smallest depth, over every shape, at which a Node's stack or the module's stack gives out",
    () => {
      execFileSync(
        "sh",
        ["../../scripts/rust.sh", "xtask", "npm", "trilean", "--measure"],
        {
          cwd: PACKAGE,
          stdio: "ignore",
          timeout: BUILD_TIMEOUT_MS,
        },
      );
      expect(existsSync(MEASURE)).toBe(true);
      const published: unknown = JSON.parse(
        execFileSync(process.execPath, [PROBE, MEASURE, "limits", "0"], {
          encoding: "utf8",
        }),
      );
      // The limit the tests of every host and the documentation use is the one the module holds.
      expect(Array.isArray(published) ? published[0] : undefined).toBe(
        MAX_NESTING_DEPTH,
      );
      const rows = SHAPES.map((shape) => {
        return {
          shape,
          host: deepest(shape),
          module: deepest(shape, LARGE_HOST_STACK_KB),
        };
      });
      console.table(rows);
      const smallest = Math.min(
        ...rows.flatMap((row) => [row.host, row.module]),
      );
      expect(MAX_NESTING_DEPTH).toBeLessThanOrEqual(
        Math.floor(smallest * MOST_OF_THE_SMALLEST),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
