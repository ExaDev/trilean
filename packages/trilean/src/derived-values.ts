import type { ExpressionNode } from "./tree";

/**
 * `coalesce` is never its own evaluated node kind -- it assembles an ordinary `conditional` whose single case's `when` is an `exists` probe of the current candidate, the same "derived = composition, not new logic" treatment derived-connectives.ts and derived-aggregates.ts already give `xor`/`sum`/`average` (see the "Derived values" section of README.md). Falling through to the next candidate happens only on `exists`'s own `false` -- a genuinely absent value (`not-found`) -- never on a candidate that resolved to something unusable (`wrong-type`/`domain-error`): `exists` already draws exactly that line (see the `exists` section of README.md), and `coalesce` inherits it unmodified rather than re-deciding it.
 *
 * Built right-to-left over the full `[first, second, ...rest]` candidate list via `reduceRight`, which needs no seed value here -- `first`/`second` being required arguments (rather than accepting a single `ExpressionNode[]`) guarantees the list always has at least two elements, so the no-initial-value overload of `reduceRight` never hits an empty array.
 */
export const coalesce = (
  first: ExpressionNode,
  second: ExpressionNode,
  ...rest: readonly ExpressionNode[]
): ExpressionNode =>
  [first, second, ...rest].reduceRight(
    (fallback, candidate): ExpressionNode => ({
      kind: "conditional",
      cases: [
        { when: { kind: "exists", operand: candidate }, then: candidate },
      ],
      fallback,
    }),
  );
