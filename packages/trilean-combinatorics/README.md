# trilean-combinatorics

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/trilean) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/trilean-combinatorics) [![Release](https://img.shields.io/github/v/release/ExaDev/trilean?filter=trilean-combinatorics@*&label=release)](https://github.com/ExaDev/trilean/releases?q=trilean-combinatorics%40) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/trilean/ci.yml?branch=main)](https://github.com/ExaDev/trilean/actions)

Makes [trilean](https://www.npmjs.com/package/trilean) predicate trees the constraint language of a [combinatrix](https://www.npmjs.com/package/combinatrix) model, and covers the model's valid combinations with pairwise and t-wise covering arrays instead of enumerating all of them.

```sh
pnpm add trilean-combinatorics
```

`trilean` and `combinatrix` are dependencies rather than implementation details: the trees it takes are trilean's `PredicateNode`, and what it returns plugs into combinatrix's own `Constraint` and `Strategy` contracts. It is ESM only, as combinatrix is.

## The idea

A combinatrix model is a set of option dimensions and the constraints between them, and its solution set is every combination the constraints allow. combinatrix searches that set by assigning dimensions one at a time and asking each constraint, on the partial assignment, whether every completion satisfies it, none does, or it cannot tell yet. A constraint that answers early prunes a whole branch, which is only sound if the answer never changes as more dimensions are assigned.

trilean already evaluates rules three-valued: a tree is definitely true, definitely false, or indeterminate with a reason, and its connectives follow Kleene's strong tables, so an `or` with one true operand is true whatever the other is. The adapter feeds it the partial assignment through the resolvers: a dimension not yet assigned is reported as not yet known, which keeps everything reading it indeterminate (`exists` included), and a dimension assigned unset is reported as known absent, which `exists` reads as false. So a definite trilean answer on a partial assignment is the answer on every completion of it, and the tree prunes exactly as far as Kleene's logic allows.

The second half answers a different question. Enumerating every valid combination of many dimensions is often far more than a test suite can run, and most faults depend on how two or three settings interact, not on all of them at once. A covering array of strength t is a set of valid combinations in which every t-way combination of values that the model allows appears at least once. Coverage is measured against the solution set, so a pair the constraints forbid is never asked for, and a model whose solution set is empty yields no rows.

```ts
import { choice, collect, defineModel } from "combinatrix";
import { coveringArray, isCoveringArray, trileanConstraint } from "trilean-combinatorics";

const dimensions = [
  choice("mode", ["fast", "safe"]),
  choice("ratio", [undefined, 0.3, 0.5]),
  choice("cache", [true, false]),
  choice("retries", [0, 1, 3]),
];

// "fast" needs a ratio of at least 0.5. ratio can be unset, so its comparison is guarded with exists: when it is unset the guard is definitely false and absorbs the comparison. mode is never unset, so its comparison needs no guard.
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
      left: { kind: "exists", operand: { kind: "reference", key: "ratio" } },
      right: {
        kind: "compare",
        op: "gte",
        left: { kind: "reference", key: "ratio" },
        right: { kind: "numberLiteral", value: 0.5 },
      },
    },
  },
  { dimensions, name: "fast needs a ratio of at least 0.5" },
);

const model = defineModel({ dimensions, constraints: [fastNeedsRatio] });

// 24 valid combinations; every pair of values among them appears in at least one of these rows.
const rows = collect(model, { strategy: coveringArray({ strength: 2, limit: 10_000 }), limit: 10_000 }).map(({ values }) => values);
isCoveringArray(rows, model, { strength: 2, limit: 10_000 }); // true
```

## API

### `trileanConstraint(tree, { dimensions, name?, functions? })`

Turns a trilean predicate tree, given as plain JSON, into a combinatrix `Constraint`. `dimensions` are the dimensions of the model it will be given to, `name` labels it in diagnostics, and `functions` is the registry `call` nodes may name (trilean's empty registry by default).

When it is defined, the tree is validated with trilean's `PredicateNodeSchema` and walked. `PredicateTreeError` lists every defect, each with its path in the tree:

- a node kind the adapter has no resolver for: `some`, `every`, `fold` and `accumulator` (collections), `lookup` (tables), `delegate` and `treeReference`. The accepted kinds are listed explicitly, so a kind trilean adds later is refused until the adapter learns it;
- a `reference` whose key is not a string, names no dimension, or carries a `unit`, since dimension values carry none;
- a `call` to a name that is not one of the registry's own keys;
- a referenced choice or first-valid dimension that can take `null`.

`EvaluationBudgetError` is thrown when the tree has more nodes than trilean's `DEFAULT_MAX_EVALUATION_NODES` or nests to `DEFAULT_MAX_NESTING_DEPTH` (the root is at depth 0). The evaluator runs with those defaults, and a tree the adapter accepts visits each node at most once per evaluation, so checking the tree itself means an evaluation never meets the budget partway through.

`dependencies` are the dimensions the tree's references name, once each, in the order the tree first mentions them. `evaluate` runs trilean's synchronous evaluator over the assignment:

| The dimension is | `resolveValue` reports | So |
| --- | --- | --- |
| assigned a string | `{ found: true, value: { kind: "text", value } }` | compared with `textCompare` or `memberOf` |
| assigned a number | `{ found: true, value: { kind: "number", value } }`, with no unit | compared with `compare` or `memberOf` |
| assigned a boolean | `{ found: true, value: { kind: "boolean", value } }` | compared with `memberOf` |
| assigned unset | `{ found: false }` | `exists` is false; anything else reading it is indeterminate `not-found` |
| not yet assigned | `{ found: false, notYetKnown: true }` | `exists` and anything else reading it is indeterminate `not-yet-known` |

`null`, the one other value a combinatrix dimension can hold, has no trilean counterpart: a choice or first-valid dimension that can take it is refused when the constraint is defined, and a computed dimension that produces it throws `UnmappableValueError` when it is read.

A definite true is `valid` and a definite false `invalid`. An indeterminate result is `unknown` while any dependency is unassigned. Once every dependency is assigned, combinatrix's contract forbids `unknown`, so an indeterminate result there throws `UndecidedConstraintError` (a `ConstraintContractError`) carrying trilean's reason. The usual cause is reading a dimension that is unset in some combination without guarding it: `compare(reference, ...)` is indeterminate `not-found` when the dimension is unset, while `and(exists(reference), compare(reference, ...))` is definitely false there, because a definite false absorbs. Comparing values of different kinds (a text dimension with `compare`, say) is indeterminate `wrong-type` and throws the same way.

### `coveringArray({ strength, limit })`

A combinatrix `Strategy` yielding a covering array of the solution set: valid combinations such that every t-way combination of dimension values that occurs in some valid combination occurs in at least one of them. `strength` is t, a positive integer: 1 covers each value, 2 is pairwise, 3 three-wise, and a strength at or above the dimension count yields the whole solution set. `limit` bounds the solution set it reads, throwing combinatrix's `LimitExceededError` past it, because the construction needs the whole solution set before it can choose a row. Either option out of range throws `RangeError` when the strategy is made.

Every dimension is covered:

- a free dimension's values, unset included when its domain lists `undefined`;
- a derived dimension's values (first-valid and computed), since a derived value is part of every combination and can decide behaviour as much as a free one. Coverage is measured on the solution set, so a derived value is only ever required where it really occurs;
- a dimension collapsed to unset by `activeWhen` is unset in those combinations, and unset counts as a value there. A combination does not record why a dimension is unset, so unset by choice and unset by inactivity are one value.

The construction is greedy and deterministic: it reads the solution set in enumeration order, then repeatedly yields the combination covering the most t-tuples not yet covered, ties going to the earliest, until every coverable tuple is covered. The same model always gives the same rows in the same order. Each row is yielded as it is chosen, so stopping early, or the `limit` on combinatrix's own `combinations`, ends the work there. An empty solution set yields nothing.

### `isCoveringArray(rows, model, { strength, limit })`

Whether `rows` are a covering array of the model's solution set at that strength: every row is a complete combination (derived dimensions included) that `explain` accepts, and every t-tuple occurring in the solution set occurs in some row. It is the brute-force definition, written independently of `coveringArray` so that it can test it, and it enumerates the whole solution set with `collect` under `limit`.

### Errors

`PredicateTreeError` (with `issues`), `EvaluationBudgetError` (with `budget`, `actual` and `limit`) and `UnmappableValueError` (with `dimension` and `value`) extend combinatrix's `CombinatrixError`; `UndecidedConstraintError` (with trilean's `reason`) extends its `ConstraintContractError`.

## Tests

The unit suite holds the adapter and the strategy to definitions rather than to examples alone. Kleene soundness is checked exhaustively on a small model: for every partial assignment, a verdict that is not `unknown` equals the verdict on every completion of it, for trees covering every connective, `exists`, `coalesce` and `conditional`, and the adapter agrees with trilean's own `evaluatePredicate` on every complete assignment. The evaluator's budgets are checked at their boundaries, a tree exactly at each limit evaluating and one beyond it being refused, which pins the definition-time count to what the evaluator spends.

The strategy is checked against `isCoveringArray` as an oracle over hundreds of seeded random models using every combinatrix feature (unset values, conditional activity, first-valid and computed dimensions, rules and guarded trilean constraints), at strengths 1, 2 and 3: every output is a covering array of valid, distinct combinations, deterministic, and no larger than the solution set. The oracle is itself shown to discriminate: it refuses the strategy's output with its last row removed, and a row outside the solution set.

## Licence

MIT, see [LICENSE](LICENSE).
