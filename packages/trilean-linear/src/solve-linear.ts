import type { ComputedValue, Unit } from "trilean";
import type { FunctionFailure, FunctionRegistry } from "trilean";

type MatrixValue = Extract<ComputedValue, { kind: "matrix" }>;
type FunctionResult = ComputedValue | FunctionFailure;

/** A complex number as its two parts, so one elimination serves real and complex systems alike. */
interface Cell {
  re: number;
  im: number;
}

const isMatrix = (value: ComputedValue | undefined): value is MatrixValue =>
  value?.kind === "matrix";

const magnitude = ({ re, im }: Cell): number => Math.hypot(re, im);

const multiply = (a: Readonly<Cell>, b: Readonly<Cell>): Cell => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});

const subtract = (a: Readonly<Cell>, b: Readonly<Cell>): Cell => ({
  re: a.re - b.re,
  im: a.im - b.im,
});

/** `a / b` by the conjugate: `b` is never zero here, since a zero pivot ends the elimination first. */
function divide(a: Readonly<Cell>, b: Readonly<Cell>): Cell {
  const scale = b.re * b.re + b.im * b.im;

  return {
    re: (a.re * b.re + a.im * b.im) / scale,
    im: (a.im * b.re - a.re * b.im) / scale,
  };
}

function cellsOf(matrix: MatrixValue): Cell[][] {
  return matrix.rows.map((row, r) =>
    row.map((re, c) => ({ re, im: matrix.imaginary?.[r]?.[c] ?? 0 })),
  );
}

/** The unit of `b` divided by the unit of `A`: the solution's entries are measured in it. */
function quotientUnit(
  numerator: Unit | undefined,
  denominator: Unit | undefined,
): Unit | undefined {
  const quotient: Record<string, number> = { ...numerator };
  for (const [dimension, exponent] of Object.entries(denominator ?? {})) {
    quotient[dimension] = (quotient[dimension] ?? 0) - exponent;
  }
  const kept = Object.entries(quotient).filter(
    ([, exponent]) => exponent !== 0,
  );

  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * Solves `A x = b` for a square `A` and a column `b`, both matrices, by Gaussian elimination with partial pivoting, over real or complex entries, and returns `x` as a matrix of one column whose unit is the unit of `b` over the unit of `A`. An `A` that is not square, a `b` that is not a column of the same height, and a matrix whose pivot is exactly zero, which is a singular system, are a `domain-error`; a non-matrix argument is a `wrong-type`. The work is cubic in the height, which `maxValueEntries` bounds, since `A` holds the square of it in entries.
 */
export function solveLinear(args: readonly ComputedValue[]): FunctionResult {
  const [matrixA, matrixB, ...extra] = args;
  if (!isMatrix(matrixA) || !isMatrix(matrixB) || extra.length > 0) {
    return { wrongType: "solveLinear requires a matrix and a column matrix" };
  }
  const size = matrixA.rows.length;
  if (
    (matrixA.rows[0]?.length ?? 0) !== size ||
    matrixB.rows.length !== size ||
    (matrixB.rows[0]?.length ?? 0) !== 1
  ) {
    return {
      domainError:
        "solveLinear requires a square matrix and a column of the same height",
    };
  }
  const a = cellsOf(matrixA);
  const b = cellsOf(matrixB);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        magnitude(a[row]?.[column] ?? { re: 0, im: 0 }) >
        magnitude(a[pivot]?.[column] ?? { re: 0, im: 0 })
      ) {
        pivot = row;
      }
    }
    const pivotRow = a[pivot];
    const pivotCell = pivotRow?.[column];
    if (
      pivotRow === undefined ||
      pivotCell === undefined ||
      magnitude(pivotCell) === 0
    ) {
      return { domainError: "solveLinear requires a non-singular matrix" };
    }
    [a[column], a[pivot]] = [pivotRow, a[column] ?? pivotRow];
    [b[column], b[pivot]] = [b[pivot] ?? [], b[column] ?? []];
    for (let row = column + 1; row < size; row += 1) {
      const factor = divide(a[row]?.[column] ?? { re: 0, im: 0 }, pivotCell);
      for (let k = column; k < size; k += 1) {
        const target = a[row];
        if (target !== undefined) {
          target[k] = subtract(
            target[k] ?? { re: 0, im: 0 },
            multiply(factor, a[column]?.[k] ?? { re: 0, im: 0 }),
          );
        }
      }
      const rhs = b[row];
      if (rhs !== undefined) {
        rhs[0] = subtract(
          rhs[0] ?? { re: 0, im: 0 },
          multiply(factor, b[column]?.[0] ?? { re: 0, im: 0 }),
        );
      }
    }
  }
  const solution: Cell[] = Array.from({ length: size }, () => ({
    re: 0,
    im: 0,
  }));
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = b[row]?.[0] ?? { re: 0, im: 0 };
    for (let k = row + 1; k < size; k += 1) {
      sum = subtract(
        sum,
        multiply(
          a[row]?.[k] ?? { re: 0, im: 0 },
          solution[k] ?? { re: 0, im: 0 },
        ),
      );
    }
    solution[row] = divide(sum, a[row]?.[row] ?? { re: 1, im: 0 });
  }
  if (
    !solution.every(
      (cell) => Number.isFinite(cell.re) && Number.isFinite(cell.im),
    )
  ) {
    return { domainError: "solveLinear produced an entry that is not finite" };
  }
  const unit = quotientUnit(matrixB.unit, matrixA.unit);
  const complex = solution.some((cell) => cell.im !== 0);

  return {
    kind: "matrix",
    rows: solution.map((cell) => [cell.re]),
    ...(complex ? { imaginary: solution.map((cell) => [cell.im]) } : {}),
    ...(unit === undefined ? {} : { unit }),
  };
}

/** The registry that holds `solveLinear`, to merge with the built-in functions when a tree names it. */
export const linearFunctions: FunctionRegistry = Object.freeze({
  solveLinear,
});
