import { choice, collect, count, defineModel } from "combinatrix";
import { describe, expect, it } from "vitest";
import { coveringArray, isCoveringArray, trileanConstraint } from "./index";

const LOW = 0.3;
const HIGH = 0.5;
/** The README lists retries of 0, 1 and 3. */
const MOST_RETRIES = 3;
const RETRIES = [0, 1, MOST_RETRIES];
/** What the README's comment states: "safe" with every ratio (3 x 2 x 3) plus "fast" with the one ratio of at least 0.5 (1 x 2 x 3). */
const VALID_COMBINATIONS = 24;

/** The worked example in README.md, run as written, so the claims its comments make are checked. */
describe("the README example", () => {
  it("counts the valid combinations the comment states and covers every pair of them", () => {
    const dimensions = [
      choice("mode", ["fast", "safe"]),
      choice("ratio", [undefined, LOW, HIGH]),
      choice("cache", [true, false]),
      choice("retries", RETRIES),
    ];
    const fastNeedsRatio = trileanConstraint(
      {
        kind: "or",
        left: {
          kind: "textCompare",
          op: "notEquals",
          left: { kind: "reference", key: "mode" },
          right: { kind: "textLiteral", value: "fast" },
        },
        right: {
          kind: "and",
          left: {
            kind: "exists",
            operand: { kind: "reference", key: "ratio" },
          },
          right: {
            kind: "compare",
            op: "gte",
            left: { kind: "reference", key: "ratio" },
            right: { kind: "numberLiteral", value: HIGH },
          },
        },
      },
      { dimensions, name: "fast needs a ratio of at least 0.5" },
    );
    const model = defineModel({ dimensions, constraints: [fastNeedsRatio] });
    const limit = 10_000;

    expect(count(model, { limit })).toBe(VALID_COMBINATIONS);
    const rows = collect(model, {
      strategy: coveringArray({ strength: 2, limit }),
      limit,
    }).map(({ values }) => values);
    expect(isCoveringArray(rows, model, { strength: 2, limit })).toBe(true);
    expect(rows.length).toBeLessThan(VALID_COMBINATIONS);
  });
});
