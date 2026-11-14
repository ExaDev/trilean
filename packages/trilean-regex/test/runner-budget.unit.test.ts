import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The conformance runner is the one JavaScript the repository allows outside configuration and the Node glue of a package, and it is held to a size budget (conformance/README.md). */

const RUNNER = resolve(import.meta.dirname, "../../../conformance/runner");
const BUDGET_BYTES = 16384;

describe("conformance/runner", () => {
  const files = readdirSync(RUNNER);

  it("holds only .mjs files", () => {
    expect(files.filter((name) => !name.endsWith(".mjs"))).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
  });

  it("totals at most the budget", () => {
    const total = files
      .map((name) => statSync(join(RUNNER, name)).size)
      .reduce((sum, size) => sum + size, 0);
    expect(total).toBeLessThanOrEqual(BUDGET_BYTES);
  });
});
