import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "./evaluator-factory";
import { resolvers } from "./evaluator-test-helpers";
import type { ComparisonOperator, ExpressionNode } from "./tree";

type DurationUnit = "ms" | "s" | "min" | "h" | "d";

/** Takes one object so a literal is an object-literal property value, which `no-magic-numbers` exempts, rather than a bare call argument. */
function duration({
  value,
  unit,
}: {
  value: number;
  unit: DurationUnit;
}): ExpressionNode {
  return { kind: "durationLiteral", value, unit };
}

async function compareDurations(
  op: ComparisonOperator,
  left: ExpressionNode,
  right: ExpressionNode,
) {
  const result = await evaluatePredicate(
    { kind: "compare", op, left, right },
    undefined,
    resolvers,
  );

  return result.status === "definite" ? result.value : result.reason;
}

async function isMember(operand: ExpressionNode, candidate: ExpressionNode) {
  const result = await evaluatePredicate(
    { kind: "memberOf", op: "in", operand, candidates: [candidate] },
    undefined,
    resolvers,
  );

  return result.status === "definite" ? result.value : result.reason;
}

const large = 1e305;
const larger = 2e305;

describe("comparing durations", () => {
  it.each([
    [
      "eq",
      duration({ value: 1, unit: "s" }),
      duration({ value: 1000, unit: "ms" }),
      true,
    ],
    [
      "eq",
      duration({ value: 1, unit: "d" }),
      duration({ value: 24, unit: "h" }),
      true,
    ],
    [
      "eq",
      duration({ value: 90, unit: "min" }),
      duration({ value: 1.5, unit: "h" }),
      true,
    ],
    [
      "lt",
      duration({ value: 59, unit: "s" }),
      duration({ value: 1, unit: "min" }),
      true,
    ],
    [
      "gt",
      duration({ value: 59, unit: "s" }),
      duration({ value: 1, unit: "min" }),
      false,
    ],
    [
      "neq",
      duration({ value: 1, unit: "h" }),
      duration({ value: 61, unit: "min" }),
      true,
    ],
  ] as const)(
    "%s of two ordinary durations in different units",
    async (op, left, right, expected) => {
      expect(await compareDurations(op, left, right)).toBe(expected);
    },
  );

  it.each([
    ["eq", false],
    ["neq", true],
    ["lt", true],
    ["lte", true],
    ["gt", false],
    ["gte", false],
  ] as const)(
    "%s of two different durations that both overflow when written in milliseconds",
    async (op, expected) => {
      expect(
        await compareDurations(
          op,
          duration({ value: large, unit: "d" }),
          duration({ value: larger, unit: "d" }),
        ),
      ).toBe(expected);
    },
  );

  it("orders huge durations in different units by their real size", async () => {
    // A day is longer than an hour, so the same count of days is the larger duration.
    expect(
      await compareDurations(
        "gt",
        duration({ value: large, unit: "d" }),
        duration({ value: large, unit: "h" }),
      ),
    ).toBe(true);
    expect(
      await compareDurations(
        "eq",
        duration({ value: large, unit: "d" }),
        duration({ value: large, unit: "h" }),
      ),
    ).toBe(false);
  });

  it("finds a huge duration equal to itself", async () => {
    expect(
      await compareDurations(
        "eq",
        duration({ value: large, unit: "d" }),
        duration({ value: large, unit: "d" }),
      ),
    ).toBe(true);
  });
});

describe("memberOf over durations", () => {
  it("matches the same duration written in another unit", async () => {
    expect(
      await isMember(
        duration({ value: 1000, unit: "ms" }),
        duration({ value: 1, unit: "s" }),
      ),
    ).toBe(true);
  });

  it("tells two different huge durations apart", async () => {
    expect(
      await isMember(
        duration({ value: large, unit: "d" }),
        duration({ value: larger, unit: "d" }),
      ),
    ).toBe(false);
    expect(
      await isMember(
        duration({ value: large, unit: "d" }),
        duration({ value: large, unit: "d" }),
      ),
    ).toBe(true);
  });

  it("tells huge durations in different units apart", async () => {
    expect(
      await isMember(
        duration({ value: large, unit: "d" }),
        duration({ value: large, unit: "h" }),
      ),
    ).toBe(false);
  });
});

describe("durations too small or too close for a division to tell apart", () => {
  it("orders the smallest subnormal against zero in a far larger unit", async () => {
    const smallest = duration({ value: 5e-324, unit: "ms" });
    const zero = duration({ value: 0, unit: "d" });

    expect(await compareDurations("gt", smallest, zero)).toBe(true);
    expect(await compareDurations("eq", smallest, zero)).toBe(false);
    expect(await isMember(smallest, zero)).toBe(false);
  });

  it("orders two durations whose quotients round to the same double", async () => {
    // 25959408 minutes is a little more than 18027.366666666665 days; both are 18027.366666666667 days once rounded.
    const minutes = duration({ value: 25959408, unit: "min" });
    const days = duration({ value: 18027.366666666665, unit: "d" });

    expect(await compareDurations("gt", minutes, days)).toBe(true);
    expect(await compareDurations("eq", minutes, days)).toBe(false);
    expect(await isMember(minutes, days)).toBe(false);
  });

  it("still finds the same span written in two units equal", async () => {
    expect(
      await compareDurations(
        "eq",
        duration({ value: 1, unit: "d" }),
        duration({ value: 86400000, unit: "ms" }),
      ),
    ).toBe(true);
  });
});
