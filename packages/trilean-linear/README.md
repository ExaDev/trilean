# trilean-linear

`solveLinear(A, b)` for [trilean](../trilean/README.md): a registry function that solves a square linear system over [matrix values](../trilean/README.md#matrix-values) by Gaussian elimination with partial pivoting.

Solving is not closed-form, so it is not a node kind or a built-in function of `trilean`, whose scope is rules and closed-form formulas. A consumer that wants it merges this registry with the built-in one:

```ts
import { builtinFunctions, createSyncEvaluator } from "trilean";
import { linearFunctions } from "trilean-linear";

const evaluator = createSyncEvaluator({
  functions: { ...builtinFunctions, ...linearFunctions },
});
```

A tree then names it in a `call` node, `{ "kind": "call", "fn": "solveLinear", "args": [A, b] }`, where `A` is an n by n matrix and `b` an n by 1 matrix, and the result is the n by 1 matrix `x` with `A x = b`. Entries may be real or complex. The solution's unit is the unit of `b` over the unit of `A`.

- An `A` that is not square, or a `b` that is not a column of the same height, is a `domain-error`.
- A singular `A`, one whose elimination meets a pivot of exactly zero, is a `domain-error` with the message `solveLinear requires a non-singular matrix`, so it is an indeterminate result like every other failure, never a thrown error. A matrix that is only nearly singular is solved, and its entries are as large and as inexact as the arithmetic gives.
- Anything that is not a matrix is a `wrong-type`.
- The work is cubic in the height. `trilean`'s `maxValueEntries` bounds it, since `A` holds the square of the height in entries, and every entry is charged to the node budget before the function runs.

Iterating to a tolerance, such as Newton's method, is also not closed-form and is not part of this package: a host loop evaluates a step tree and tests a convergence predicate on each round.

## Build, test, and lint

```sh
pnpm --dir packages/trilean-linear build
pnpm --dir packages/trilean-linear lint
pnpm --dir packages/trilean-linear typecheck
pnpm --dir packages/trilean-linear test
```

## Licence

MIT, see [LICENSE](LICENSE).
