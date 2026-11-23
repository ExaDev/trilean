import { builtinFunctions, createSyncEvaluator } from "trilean";
import type { ComputedValue } from "trilean";
import { describe, expect, it } from "vitest";
import { linearFunctions, solveLinear } from "./solve-linear";

type Matrix = Extract<ComputedValue, { kind: "matrix" }>;

const matrix = (
  rows: readonly number[][],
  extra: Omit<Matrix, "kind" | "rows"> = {},
): Matrix => ({
  kind: "matrix",
  rows: rows.map((row) => [...row]),
  ...extra,
});

describe("solveLinear", () => {
  it("solves a 3 by 3 system to the hand-worked solution", () => {
    // x + y + z = 6, 2y + 5z = -4, 2x + 5y - z = 27 has x = 5, y = 3, z = -2.
    const result = solveLinear([
      matrix([
        [1, 1, 1],
        [0, 2, 5],
        [2, 5, -1],
      ]),
      matrix([[6], [-4], [27]]),
    ]);

    expect(result).toMatchObject({ kind: "matrix" });
    const rows = (result as Matrix).rows.map(([cell]) => cell);
    expect(rows[0]).toBeCloseTo(5, 12);
    expect(rows[1]).toBeCloseTo(3, 12);
    expect(rows[2]).toBeCloseTo(-2, 12);
  });

  it("pivots past a zero on the diagonal", () => {
    expect(
      solveLinear([
        matrix([
          [0, 1],
          [1, 0],
        ]),
        matrix([[2], [3]]),
      ]),
    ).toEqual(matrix([[3], [2]]));
  });

  it("refuses a singular system as a domain error", () => {
    expect(
      solveLinear([
        matrix([
          [1, 2],
          [2, 4],
        ]),
        matrix([[1], [2]]),
      ]),
    ).toEqual({ domainError: "solveLinear requires a non-singular matrix" });
  });

  it("solves a complex system and keeps the imaginary part", () => {
    // (1 + i) x = 2i has x = 1 + i.
    const result = solveLinear([
      matrix([[1]], { imaginary: [[1]] }),
      matrix([[0]], { imaginary: [[2]] }),
    ]);

    expect(result).toEqual(matrix([[1]], { imaginary: [[1]] }));
  });

  it("measures the solution in the unit of b over the unit of A", () => {
    expect(
      solveLinear([
        matrix([[2]], { unit: { A: 1 } }),
        matrix([[6]], { unit: { V: 1 } }),
      ]),
    ).toEqual(matrix([[3]], { unit: { V: 1, A: -1 } }));
  });

  it("refuses a matrix that is not square and a column of another height", () => {
    const message =
      "solveLinear requires a square matrix and a column of the same height";
    expect(solveLinear([matrix([[1, 2]]), matrix([[1]])])).toEqual({
      domainError: message,
    });
    expect(
      solveLinear([
        matrix([
          [1, 0],
          [0, 1],
        ]),
        matrix([[1]]),
      ]),
    ).toEqual({ domainError: message });
  });

  it("refuses arguments that are not matrices as a wrong type", () => {
    expect(solveLinear([{ kind: "number", value: 1 }])).toEqual({
      wrongType: "solveLinear requires a matrix and a column matrix",
    });
  });
});

describe("solveLinear in an evaluation", () => {
  const evaluator = createSyncEvaluator({
    functions: { ...builtinFunctions, ...linearFunctions },
  });
  const system = {
    A: matrix([
      [2, 1],
      [1, 3],
    ]),
    B: matrix([[5], [10]]),
  };
  const resolvers = {
    resolveValue: (key: unknown) =>
      typeof key === "string" && key in system
        ? {
            found: true as const,
            value: system[key as keyof typeof system],
          }
        : { found: false as const },
    resolveLookup: () => ({ found: false as const }),
    resolveCollection: () => [],
  };

  it("reads one solved entry through a whole tree", () => {
    const tree = {
      kind: "call" as const,
      fn: "entry",
      args: [
        {
          kind: "call" as const,
          fn: "solveLinear",
          args: [
            { kind: "reference" as const, key: "A" },
            { kind: "reference" as const, key: "B" },
          ],
        },
        { kind: "numberLiteral" as const, value: 1 },
        { kind: "numberLiteral" as const, value: 0 },
      ],
    };

    const result = evaluator.evaluateValue(tree, undefined, resolvers);

    expect(result).toMatchObject({ status: "definite" });
    expect(
      result.status === "definite" ? result.value : undefined,
    ).toMatchObject({
      kind: "number",
    });
  });

  it("makes a singular system an indeterminate domain error", () => {
    const singular = {
      ...system,
      A: matrix([
        [1, 1],
        [1, 1],
      ]),
    };
    const result = evaluator.evaluateValue(
      {
        kind: "call",
        fn: "solveLinear",
        args: [
          { kind: "reference", key: "A" },
          { kind: "reference", key: "B" },
        ],
      },
      undefined,
      {
        ...resolvers,
        resolveValue: (key: unknown) =>
          typeof key === "string" && key in singular
            ? {
                found: true as const,
                value: singular[key as keyof typeof singular],
              }
            : { found: false as const },
      },
    );

    expect(result).toEqual({
      status: "indeterminate",
      reason: {
        code: "domain-error",
        message: "solveLinear requires a non-singular matrix",
      },
    });
  });
});
