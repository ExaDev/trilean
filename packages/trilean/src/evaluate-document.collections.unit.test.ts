import { describe, expect, it } from "vitest";
import type { DocumentEvaluation } from "./evaluate-document";
import { evaluateDocument } from "./evaluate-document";

const ref = (key: string): unknown => ({ kind: "reference", key });
const literal = ({ value }: { value: number }): unknown => ({
  kind: "numberLiteral",
  value,
});
const arithmetic = (op: string, left: unknown, right: unknown): unknown => ({
  kind: "arithmetic",
  op,
  left,
  right,
});

/** The number a definite expression evaluation produced; anything else fails the test by name. */
function definiteNumber(result: DocumentEvaluation): number {
  if (result.outcome !== "evaluated") {
    throw new Error(`not evaluated: ${result.outcome}`);
  }
  const { evaluation } = result;
  if (evaluation.status !== "definite") {
    throw new Error(`not definite: ${evaluation.reason.message}`);
  }
  const { value } = evaluation;
  if (typeof value === "boolean" || value.kind !== "number") {
    throw new Error("not a number");
  }

  return value.value;
}

function indeterminateReason(result: DocumentEvaluation): {
  code: string;
  message: string;
} {
  if (
    result.outcome !== "evaluated" ||
    result.evaluation.status !== "indeterminate"
  ) {
    throw new Error("expected an indeterminate evaluation");
  }

  return result.evaluation.reason;
}

/** IEC 60076-7 clause 6.3, Equation (2): V = 2^((theta_h - 98) / 6). */
const ageingRate = arithmetic(
  "power",
  literal({ value: 2 }),
  arithmetic(
    "divide",
    arithmetic("subtract", ref("theta_h"), literal({ value: 98 })),
    literal({ value: 6 }),
  ),
);

/** Clause 6.4, Equation (4): the loss of life is the sum over the intervals of the relative ageing rate times the interval's duration. */
const lossOfLife = {
  kind: "fold",
  collection: "intervals",
  combiner: {
    mode: "reduce",
    initial: literal({ value: 0 }),
    combine: arithmetic(
      "add",
      { kind: "accumulator" },
      arithmetic("multiply", ageingRate, ref("hours")),
    ),
  },
};

describe("evaluateDocument with lists of items", () => {
  it("sums the loss of life over a load profile, each interval read from its own item", () => {
    // V is 1 at 98 C, 4 at 110 C and 0.25 at 86 C, so 1 * 24 + 4 * 2 + 0.25 * 10.
    const profile = {
      intervals: [
        { theta_h: 98, hours: 24 },
        { theta_h: 110, hours: 2 },
        { theta_h: 86, hours: 10 },
      ],
    };
    const weights = profile.intervals.map(
      ({ theta_h, hours }) => ageingRateOf({ theta_h }) * hours,
    );

    expect(
      definiteNumber(evaluateDocument({ tree: lossOfLife, inputs: profile })),
    ).toBe(weights.reduce((total, weight) => total + weight, 0));
  });

  it("folds an empty list to the initial value", () => {
    expect(
      definiteNumber(
        evaluateDocument({ tree: lossOfLife, inputs: { intervals: [] } }),
      ),
    ).toBe(0);
  });

  it("is indeterminate, naming the key, when an item lacks a value the fold reads", () => {
    const reason = indeterminateReason(
      evaluateDocument({
        tree: lossOfLife,
        inputs: { intervals: [{ theta_h: 98, hours: 24 }, { theta_h: 110 }] },
      }),
    );

    expect(reason.code).toBe("not-found");
    expect(reason.message).toContain("hours");
  });

  it("gives an item no view of the top-level inputs", () => {
    const reason = indeterminateReason(
      evaluateDocument({
        tree: lossOfLife,
        inputs: { hours: 24, intervals: [{ theta_h: 98 }] },
      }),
    );

    expect(reason.code).toBe("not-found");
    expect(reason.message).toContain("hours");
  });

  it("quantifies over the items of a list", () => {
    const anyHot = {
      kind: "some",
      collection: "intervals",
      item: {
        kind: "compare",
        op: "gt",
        left: ref("theta_h"),
        right: literal({ value: 110 }),
      },
    };
    const outcome = (intervals: readonly unknown[]): unknown => {
      const result = evaluateDocument({ tree: anyHot, inputs: { intervals } });

      return result.outcome === "evaluated" &&
        result.evaluation.status === "definite"
        ? result.evaluation.value
        : undefined;
    };

    expect(outcome([{ theta_h: 98 }, { theta_h: 120 }])).toBe(true);
    expect(outcome([{ theta_h: 98 }, { theta_h: 100 }])).toBe(false);
  });

  it("rejects an item that is not an object of values, naming its position", () => {
    expect(
      evaluateDocument({
        tree: lossOfLife,
        inputs: { intervals: [{ theta_h: 98, hours: 24 }, "not an object"] },
      }),
    ).toEqual({
      outcome: "rejected",
      reason: "invalid",
      issues: ["inputs.intervals[1]: expected an object of named values"],
    });
  });
});

/** The same ageing rate computed directly, to compare the fold with. */
function ageingRateOf({ theta_h }: { theta_h: number }): number {
  const reference = 98;
  const doublingStep = 6;

  return 2 ** ((theta_h - reference) / doublingStep);
}

describe("evaluateDocument with complex inputs", () => {
  const complexValue = ({ re, im }: { re: number; im: number }): unknown => ({
    kind: "complex",
    re,
    im,
  });

  /** The standard's neutral fault current is the magnitude of 3E over the loop impedance: for a mixed resistive and reactive loop the impedances add as complex numbers. */
  const ZERO_SEQUENCE_FACTOR = 3;
  /** Decimal places the two sides of a floating point comparison must agree to. */
  const AGREEMENT_DIGITS = 12;
  const faultCurrent = {
    kind: "call",
    fn: "magnitude",
    args: [
      arithmetic(
        "divide",
        arithmetic(
          "multiply",
          literal({ value: ZERO_SEQUENCE_FACTOR }),
          ref("E"),
        ),
        arithmetic(
          "add",
          ref("Z_transformer"),
          arithmetic(
            "multiply",
            literal({ value: ZERO_SEQUENCE_FACTOR }),
            ref("Z_neutral"),
          ),
        ),
      ),
    ],
  };

  it("adds mixed resistive and reactive impedances as complex numbers", () => {
    const loop = {
      E: 100,
      transformer: { re: 1, im: 2 },
      neutral: { re: 0, im: 1 },
    };
    // The loop impedance is (1 + 2j) + 3 * (0 + 1j) = 1 + 5j, so the current is 3E / |1 + 5j|.
    const expected =
      (ZERO_SEQUENCE_FACTOR * loop.E) /
      Math.hypot(
        loop.transformer.re + ZERO_SEQUENCE_FACTOR * loop.neutral.re,
        loop.transformer.im + ZERO_SEQUENCE_FACTOR * loop.neutral.im,
      );

    expect(
      definiteNumber(
        evaluateDocument({
          tree: faultCurrent,
          inputs: {
            E: loop.E,
            Z_transformer: complexValue(loop.transformer),
            Z_neutral: complexValue(loop.neutral),
          },
        }),
      ),
    ).toBeCloseTo(expected, AGREEMENT_DIGITS);
  });

  it("agrees with the scalar form when every impedance is reactive", () => {
    // 3 * 100 / (3 + 3 * 1) = 50, all on the imaginary axis.
    const loop = {
      E: 100,
      transformer: { re: 0, im: 3 },
      neutral: { re: 0, im: 1 },
    };

    expect(
      definiteNumber(
        evaluateDocument({
          tree: faultCurrent,
          inputs: {
            E: loop.E,
            Z_transformer: complexValue(loop.transformer),
            Z_neutral: complexValue(loop.neutral),
          },
        }),
      ),
    ).toBeCloseTo(
      (ZERO_SEQUENCE_FACTOR * loop.E) /
        (loop.transformer.im + ZERO_SEQUENCE_FACTOR * loop.neutral.im),
      AGREEMENT_DIGITS,
    );
  });

  it("reads the phase of a complex input in radians", () => {
    expect(
      definiteNumber(
        evaluateDocument({
          tree: { kind: "call", fn: "phase", args: [ref("z")] },
          inputs: { z: complexValue({ re: 0, im: 1 }) },
        }),
      ),
    ).toBe(Math.PI / 2);
  });
});
