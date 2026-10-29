import type { Model, Strategy, Value } from "combinatrix";
import {
  LimitExceededError,
  StrategyError,
  choice,
  collect,
  count,
  defineModel,
  firstValid,
} from "combinatrix";
import { describe, expect, it } from "vitest";
import { coveringArray, isCoveringArray } from "./index";
import { randomModel } from "./test-support/random-model";

/** How many generated models each property is checked against. */
const MODELS = 300;
const SEED = 20_261_029;
/** Bounds every solution set the tests read; the generated models are far smaller. */
const LIMIT = 10_000;
/** The strongest coverage the property tests check: three-wise. */
const MAX_STRENGTH = 3;
/** Each value, pairwise and three-wise. */
const STRENGTHS = Array.from({ length: MAX_STRENGTH }, (_, index) => index + 1);
/** The share of the generated models the slower whole-model checks run on. */
const SAMPLE_DIVISOR = 10;
const SIZES = ["small", "medium", "large"] as const;

type Row = Readonly<Record<string, Value>>;

function rowsOf(model: Model<Row>, strategy: Strategy): Row[] {
  return collect(model, { strategy, limit: LIMIT }).map(({ values }) => values);
}

function generated(): ReturnType<typeof randomModel>[] {
  return Array.from({ length: MODELS }, (_, index) =>
    randomModel(SEED + index),
  );
}

describe("coveringArray", () => {
  it("yields each value once over, earliest first, at strength 1", () => {
    const model = defineModel({
      dimensions: [choice("size", SIZES), choice("shape", ["x", "y"])],
    });
    expect(rowsOf(model, coveringArray({ strength: 1, limit: LIMIT }))).toEqual(
      [
        { size: "small", shape: "x" },
        { size: "medium", shape: "y" },
        { size: "large", shape: "x" },
      ],
    );
  });

  it("yields every pair of an unconstrained two-dimensional model at strength 2", () => {
    const model = defineModel({
      dimensions: [choice("a", [undefined, true]), choice("b", ["x", "y"])],
    });
    expect(rowsOf(model, coveringArray({ strength: 2, limit: LIMIT }))).toEqual(
      [
        { a: undefined, b: "x" },
        { a: undefined, b: "y" },
        { a: true, b: "x" },
        { a: true, b: "y" },
      ],
    );
  });

  it("covers pairs of a three-by-three-by-three model in fewer rows than the product", () => {
    const values = [0, 1, 2];
    const model = defineModel({
      dimensions: [
        choice("a", values),
        choice("b", values),
        choice("c", values),
      ],
    });
    const rows = rowsOf(model, coveringArray({ strength: 2, limit: LIMIT }));
    expect(isCoveringArray(rows, model, { strength: 2, limit: LIMIT })).toBe(
      true,
    );
    expect(rows.length).toBeLessThan(values.length ** model.dimensions.length);
  });

  it("does not require a tuple no valid combination contains", () => {
    const model = defineModel({
      dimensions: [choice("a", [1, 2]), choice("b", ["x", "y"])],
      rules: [{ excludes: { all: [{ is: ["a", 1] }, { is: ["b", "y"] }] } }],
    });
    const rows = rowsOf(model, coveringArray({ strength: 2, limit: LIMIT }));
    expect(rows).toEqual([
      { a: 1, b: "x" },
      { a: 2, b: "x" },
      { a: 2, b: "y" },
    ]);
  });

  it("covers derived values and unset from inactivity like any other value", () => {
    const model = defineModel({
      dimensions: [
        choice("feature", [undefined, "on"]),
        choice("tuning", [1, 2], { activeWhen: { set: "feature" } }),
        firstValid("channel", ["stable", "beta"]),
      ],
      rules: [
        { requires: { is: ["channel", "beta"] }, when: { is: ["tuning", 2] } },
      ],
    });
    const rows = rowsOf(model, coveringArray({ strength: 2, limit: LIMIT }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { feature: undefined, tuning: undefined, channel: "stable" },
        { feature: "on", tuning: 2, channel: "beta" },
      ]),
    );
    expect(isCoveringArray(rows, model, { strength: 2, limit: LIMIT })).toBe(
      true,
    );
  });

  it("yields nothing for an empty solution set", () => {
    const model = defineModel({
      dimensions: [choice("a", [1])],
      rules: [{ excludes: { is: ["a", 1] } }],
    });
    expect(rowsOf(model, coveringArray({ strength: 2, limit: LIMIT }))).toEqual(
      [],
    );
    expect(isCoveringArray([], model, { strength: 2, limit: LIMIT })).toBe(
      true,
    );
  });

  it("refuses a solution set larger than its limit", () => {
    const model = defineModel({
      dimensions: [choice("a", SIZES), choice("b", SIZES)],
    });
    expect(() =>
      rowsOf(
        model,
        coveringArray({ strength: 2, limit: SIZES.length ** 2 - 1 }),
      ),
    ).toThrow(LimitExceededError);
    expect(
      rowsOf(model, coveringArray({ strength: 2, limit: SIZES.length ** 2 })),
    ).toHaveLength(SIZES.length ** 2);
  });

  it("refuses a strength that is not a positive integer and a limit that is not a non-negative integer", () => {
    expect(() => coveringArray({ strength: 0, limit: LIMIT })).toThrow(
      RangeError,
    );
    expect(() => coveringArray({ strength: 1.5, limit: LIMIT })).toThrow(
      RangeError,
    );
    expect(() => coveringArray({ strength: 2, limit: -1 })).toThrow(RangeError);
  });
});

describe("coveringArray against the isCoveringArray oracle", () => {
  it.each(STRENGTHS)(
    "is a covering array of strength %i on every generated model, of valid, distinct rows",
    (strength) => {
      for (const { model, seed } of generated()) {
        const rows = rowsOf(model, coveringArray({ strength, limit: LIMIT }));
        expect(
          isCoveringArray(rows, model, { strength, limit: LIMIT }),
          `seed ${String(seed)}`,
        ).toBe(true);
        expect(
          new Set(rows.map((row) => JSON.stringify(Object.entries(row)))).size,
        ).toBe(rows.length);
        expect(rows.length).toBeLessThanOrEqual(count(model, { limit: LIMIT }));
      }
    },
  );

  it("yields the same rows in the same order every time", () => {
    for (const { model } of generated().slice(0, MODELS / SAMPLE_DIVISOR)) {
      const strategy = coveringArray({ strength: 2, limit: LIMIT });
      expect(rowsOf(model, strategy)).toEqual(rowsOf(model, strategy));
    }
  });

  it("yields the whole solution set at a strength of at least the dimension count", () => {
    for (const { model } of generated().slice(0, MODELS / SAMPLE_DIVISOR)) {
      const strength = model.dimensions.length;
      expect(
        rowsOf(model, coveringArray({ strength, limit: LIMIT })),
      ).toHaveLength(count(model, { limit: LIMIT }));
    }
  });

  it("the oracle refuses the strategy's output with its last row dropped", () => {
    let checked = 0;
    for (const { model, seed } of generated()) {
      const rows = rowsOf(model, coveringArray({ strength: 2, limit: LIMIT }));
      if (rows.length === 0) continue;

      checked += 1;
      // The last row chosen covered at least one tuple no earlier row did, so without it that tuple is uncovered.
      expect(
        isCoveringArray(rows.slice(0, -1), model, {
          strength: 2,
          limit: LIMIT,
        }),
        `seed ${String(seed)}`,
      ).toBe(false);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the oracle refuses a row outside the solution set, and combinatrix refuses a strategy yielding one", () => {
    const model = defineModel({
      dimensions: [choice("a", [1, 2]), choice("b", ["x", "y"])],
      rules: [{ excludes: { all: [{ is: ["a", 1] }, { is: ["b", "y"] }] } }],
    });
    const rows = rowsOf(model, coveringArray({ strength: 2, limit: LIMIT }));
    const invalid = { a: 1, b: "y" };
    expect(
      isCoveringArray([...rows, invalid], model, { strength: 2, limit: LIMIT }),
    ).toBe(false);
    expect(
      isCoveringArray([...rows, { a: 1 }], model, {
        strength: 2,
        limit: LIMIT,
      }),
    ).toBe(false);
    const broken: Strategy = {
      name: "broken",
      select: (context) => [
        ...coveringArray({ strength: 2, limit: LIMIT }).select(context),
        invalid,
      ],
    };
    expect(() => rowsOf(model, broken)).toThrow(StrategyError);
  });
});
