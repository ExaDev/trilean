import type { ComputedValue, Unit } from "./computed-value";
import {
  combineUnitsForMultiply,
  matrixShapeIssue,
  unitsEqual,
} from "./computed-value";
import type { FunctionFailure, FunctionRegistry } from "./functions";

type MatrixValue = Extract<ComputedValue, { kind: "matrix" }>;
type FunctionResult = ComputedValue | FunctionFailure;

/** The unit of a number or complex value, which the other kinds do not carry as a dimension map. */
function unitOf(value: ComputedValue): Unit | undefined {
  return value.kind === "number" || value.kind === "complex"
    ? value.unit
    : undefined;
}

/** A matrix as grids of numbers: the real part and an imaginary part that is all zeros when the matrix is real. */
interface Grids {
  readonly real: readonly (readonly number[])[];
  readonly imaginary: readonly (readonly number[])[];
}

const isMatrix = (value: FunctionResult | undefined): value is MatrixValue =>
  value !== undefined && "kind" in value && value.kind === "matrix";

const gridsOf = (matrix: MatrixValue): Grids => ({
  real: matrix.rows,
  imaginary: matrix.imaginary ?? matrix.rows.map((row) => row.map(() => 0)),
});

const columnsOf = (matrix: MatrixValue): number => matrix.rows[0]?.length ?? 0;

/** A matrix from grids, holding an imaginary part only when some entry has one, and refusing a result that left the finite range, which a computed value cannot carry. */
function matrixOf(
  name: string,
  { real, imaginary }: Grids,
  unit: Unit | undefined,
): MatrixValue | FunctionFailure {
  const finite = [...real, ...imaginary].every((row) =>
    row.every((part) => Number.isFinite(part)),
  );
  if (!finite) {
    return { domainError: `${name} produced an entry that is not finite` };
  }
  const complex = imaginary.some((row) => row.some((part) => part !== 0));
  const rows = real.map((row) => [...row]);
  const base = { kind: "matrix" as const, rows };

  return {
    ...base,
    ...(complex ? { imaginary: imaginary.map((row) => [...row]) } : {}),
    ...(unit === undefined ? {} : { unit }),
  };
}

/** The `[real, imaginary]` parts of a number or complex value, or `undefined` for any other value. */
function partsOf(value: ComputedValue): readonly [number, number] | undefined {
  if (value.kind === "number") return [value.value, 0];
  if (value.kind === "complex") return [value.re, value.im];

  return undefined;
}

function fromList(args: readonly ComputedValue[]): FunctionResult {
  const [list, ...extra] = args;
  if (list?.kind !== "list" || extra.length > 0) {
    return { wrongType: "matrix requires one list of rows" };
  }
  const real: number[][] = [];
  const imaginary: number[][] = [];
  let unit: Unit | undefined;
  let first = true;
  for (const row of list.items) {
    if (row.kind !== "list") {
      return { wrongType: "matrix requires every row to be a list" };
    }
    const realRow: number[] = [];
    const imaginaryRow: number[] = [];
    for (const cell of row.items) {
      const parts = partsOf(cell);
      if (parts === undefined) {
        return { wrongType: "matrix requires every entry to be a number" };
      }
      const cellUnit = unitOf(cell);
      if (first) {
        unit = cellUnit;
        first = false;
      } else if (!unitsEqual(unit, cellUnit)) {
        return { wrongType: "matrix requires every entry to share one unit" };
      }
      realRow.push(parts[0]);
      imaginaryRow.push(parts[1]);
    }
    real.push(realRow);
    imaginary.push(imaginaryRow);
  }
  const built = matrixOf("matrix", { real, imaginary }, unit);
  if (!isMatrix(built)) return built;
  const issue = matrixShapeIssue(built);

  return issue === undefined ? built : { domainError: issue };
}

function sizeOf(
  name: "rows" | "columns",
  args: readonly ComputedValue[],
): FunctionResult {
  const [matrix, ...extra] = args;
  if (!isMatrix(matrix) || extra.length > 0) {
    return { wrongType: `${name} requires exactly one matrix argument` };
  }

  return {
    kind: "number",
    value: name === "rows" ? matrix.rows.length : columnsOf(matrix),
  };
}

/** A whole-number index without a unit, or `undefined` when the value is not one. */
function indexOf(value: ComputedValue | undefined): number | undefined {
  return value?.kind === "number" &&
    unitsEqual(value.unit, undefined) &&
    Number.isInteger(value.value)
    ? value.value
    : undefined;
}

function entryOf(args: readonly ComputedValue[]): FunctionResult {
  const [matrix, rowArg, columnArg, ...extra] = args;
  if (
    !isMatrix(matrix) ||
    extra.length > 0 ||
    rowArg?.kind !== "number" ||
    columnArg?.kind !== "number"
  ) {
    return { wrongType: "entry requires a matrix, a row and a column" };
  }
  const row = indexOf(rowArg);
  const column = indexOf(columnArg);
  if (row === undefined || column === undefined) {
    return {
      domainError: "entry requires whole-number indices without a unit",
    };
  }
  const real = matrix.rows[row]?.[column];
  if (real === undefined) {
    return {
      domainError: "entry requires a row and a column within the matrix",
    };
  }
  const { unit } = matrix;
  const imaginary = matrix.imaginary?.[row]?.[column];
  if (imaginary === undefined) {
    return unit === undefined
      ? { kind: "number", value: real }
      : { kind: "number", value: real, unit };
  }

  return unit === undefined
    ? { kind: "complex", re: real, im: imaginary }
    : { kind: "complex", re: real, im: imaginary, unit };
}

function transposeOf(args: readonly ComputedValue[]): FunctionResult {
  const [matrix, ...extra] = args;
  if (!isMatrix(matrix) || extra.length > 0) {
    return { wrongType: "transpose requires exactly one matrix argument" };
  }
  const flip = (grid: readonly (readonly number[])[]): number[][] =>
    (grid[0] ?? []).map((_cell, column) => grid.map((row) => row[column] ?? 0));
  const { real, imaginary } = gridsOf(matrix);

  return matrixOf(
    "transpose",
    { real: flip(real), imaginary: flip(imaginary) },
    matrix.unit,
  );
}

function addOf(args: readonly ComputedValue[]): FunctionResult {
  const [left, right, ...extra] = args;
  if (!isMatrix(left) || !isMatrix(right) || extra.length > 0) {
    return { wrongType: "matrixAdd requires exactly two matrices" };
  }
  if (!unitsEqual(left.unit, right.unit)) {
    return { wrongType: "matrixAdd requires matrices of the same unit" };
  }
  if (
    left.rows.length !== right.rows.length ||
    columnsOf(left) !== columnsOf(right)
  ) {
    return { domainError: "matrixAdd requires matrices of the same shape" };
  }
  const a = gridsOf(left);
  const b = gridsOf(right);
  const sum = (x: Grids["real"], y: Grids["real"]): number[][] =>
    x.map((row, r) => row.map((cell, c) => cell + (y[r]?.[c] ?? 0)));

  return matrixOf(
    "matrixAdd",
    {
      real: sum(a.real, b.real),
      imaginary: sum(a.imaginary, b.imaginary),
    },
    left.unit,
  );
}

function scaleOf(args: readonly ComputedValue[]): FunctionResult {
  const [matrix, factor, ...extra] = args;
  const parts = factor === undefined ? undefined : partsOf(factor);
  if (!isMatrix(matrix) || parts === undefined || extra.length > 0) {
    return { wrongType: "scale requires a matrix and a number" };
  }
  const [re, im] = parts;
  const { real, imaginary } = gridsOf(matrix);
  const factorUnit = factor === undefined ? undefined : unitOf(factor);
  const unit = combineUnitsForMultiply(matrix.unit, factorUnit);

  return matrixOf(
    "scale",
    {
      real: real.map((row, r) =>
        row.map((cell, c) => cell * re - (imaginary[r]?.[c] ?? 0) * im),
      ),
      imaginary: real.map((row, r) =>
        row.map((cell, c) => cell * im + (imaginary[r]?.[c] ?? 0) * re),
      ),
    },
    Object.keys(unit).length === 0 ? undefined : unit,
  );
}

function multiplyOf(args: readonly ComputedValue[]): FunctionResult {
  const [left, right, ...extra] = args;
  if (!isMatrix(left) || !isMatrix(right) || extra.length > 0) {
    return { wrongType: "matrixMultiply requires exactly two matrices" };
  }
  if (columnsOf(left) !== right.rows.length) {
    return {
      domainError:
        "matrixMultiply requires the left matrix's columns to equal the right matrix's rows",
    };
  }
  const a = gridsOf(left);
  const b = gridsOf(right);
  const width = columnsOf(right);
  const product = (
    pick: (r: number, k: number, c: number) => number,
  ): number[][] =>
    a.real.map((_row, r) =>
      Array.from(
        { length: width },
        (_cell, c) =>
          a.real[r]?.reduce((total, _entry, k) => total + pick(r, k, c), 0) ??
          0,
      ),
    );
  const at = (grid: Grids["real"], r: number, c: number): number =>
    grid[r]?.[c] ?? 0;
  const unit = combineUnitsForMultiply(left.unit, right.unit);

  return matrixOf(
    "matrixMultiply",
    {
      real: product(
        (r, k, c) =>
          at(a.real, r, k) * at(b.real, k, c) -
          at(a.imaginary, r, k) * at(b.imaginary, k, c),
      ),
      imaginary: product(
        (r, k, c) =>
          at(a.real, r, k) * at(b.imaginary, k, c) +
          at(a.imaginary, r, k) * at(b.real, k, c),
      ),
    },
    Object.keys(unit).length === 0 ? undefined : unit,
  );
}

/** The matrix functions of the built-in registry. */
export const matrixFunctions: FunctionRegistry = {
  matrix: fromList,
  rows: (args) => sizeOf("rows", args),
  columns: (args) => sizeOf("columns", args),
  entry: entryOf,
  transpose: transposeOf,
  matrixAdd: addOf,
  scale: scaleOf,
  matrixMultiply: multiplyOf,
};

/**
 * The work a call does beyond reading its arguments, in the units the node budget counts: the multiply-adds of a matrix product, charged before it runs so a product too large to compute ends as a resource-exhausted result without computing it. Every other function does work in proportion to the entries it reads, which the call is charged for already.
 */
export function matrixWork(
  fnName: string,
  args: readonly ComputedValue[],
): number {
  const [left, right] = args;
  if (fnName !== "matrixMultiply" || !isMatrix(left) || !isMatrix(right)) {
    return 0;
  }

  return left.rows.length * columnsOf(left) * columnsOf(right);
}
