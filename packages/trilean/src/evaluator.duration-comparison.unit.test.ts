import { describe, expect, it } from "vitest";
import { evaluatePredicate } from "./evaluator-factory";
import type { Resolution, Resolvers } from "./resolvers";
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
    // 25959408 / 1440 rounds to 18027.366666666665, the same double as the literal below, so the rounded values tie. The exact span of the minutes is a little more than that double, which is a little below 18027.3666... days.
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

describe("comparing durations that are not finite numbers", () => {
  const values: Record<string, { value: number; unit: DurationUnit }> = {
    nanSeconds: { value: Number.NaN, unit: "s" },
    fiveSeconds: { value: 5, unit: "s" },
    infiniteDays: { value: Number.POSITIVE_INFINITY, unit: "d" },
    infiniteMilliseconds: { value: Number.POSITIVE_INFINITY, unit: "ms" },
    negativeInfiniteHours: { value: Number.NEGATIVE_INFINITY, unit: "h" },
  };
  const valueResolvers: Resolvers = {
    resolveValue: async (key) => {
      const entry = typeof key === "string" ? values[key] : undefined;
      const resolution: Resolution =
        entry === undefined
          ? { found: false }
          : { found: true, value: { kind: "duration", ...entry } };

      return Promise.resolve(resolution);
    },
    resolveLookup: async () => Promise.resolve({ found: false }),
    resolveCollection: async () => Promise.resolve([]),
  };

  function reference(key: string): ExpressionNode {
    return { kind: "reference", key };
  }

  async function compareReferences(
    op: ComparisonOperator,
    left: string,
    right: string,
  ) {
    const result = await evaluatePredicate(
      { kind: "compare", op, left: reference(left), right: reference(right) },
      undefined,
      valueResolvers,
    );

    return result.status === "definite" ? result.value : result.reason;
  }

  async function memberReferences(operand: string, candidate: string) {
    const result = await evaluatePredicate(
      {
        kind: "memberOf",
        op: "in",
        operand: reference(operand),
        candidates: [reference(candidate)],
      },
      undefined,
      valueResolvers,
    );

    return result.status === "definite" ? result.value : result.reason;
  }

  it.each(["eq", "lt", "lte", "gt", "gte"] as const)(
    "%s with a NaN on either side is false, as it is for numbers",
    async (op) => {
      expect(await compareReferences(op, "nanSeconds", "fiveSeconds")).toBe(
        false,
      );
      expect(await compareReferences(op, "fiveSeconds", "nanSeconds")).toBe(
        false,
      );
      expect(await compareReferences(op, "nanSeconds", "nanSeconds")).toBe(
        false,
      );
    },
  );

  it("neq with a NaN is true, and a NaN is not a member of anything", async () => {
    expect(await compareReferences("neq", "nanSeconds", "fiveSeconds")).toBe(
      true,
    );
    expect(await memberReferences("nanSeconds", "nanSeconds")).toBe(false);
    expect(await memberReferences("nanSeconds", "fiveSeconds")).toBe(false);
  });

  it("finds equal infinities equal whatever their units", async () => {
    expect(
      await compareReferences("eq", "infiniteDays", "infiniteMilliseconds"),
    ).toBe(true);
    expect(
      await compareReferences("gt", "infiniteDays", "infiniteMilliseconds"),
    ).toBe(false);
    expect(await memberReferences("infiniteDays", "infiniteMilliseconds")).toBe(
      true,
    );
  });

  it("orders infinities against finite values and against each other", async () => {
    expect(await compareReferences("gt", "infiniteDays", "fiveSeconds")).toBe(
      true,
    );
    expect(
      await compareReferences("lt", "negativeInfiniteHours", "fiveSeconds"),
    ).toBe(true);
    expect(
      await compareReferences("lt", "negativeInfiniteHours", "infiniteDays"),
    ).toBe(true);
    expect(await compareReferences("gt", "fiveSeconds", "infiniteDays")).toBe(
      false,
    );
  });
});
