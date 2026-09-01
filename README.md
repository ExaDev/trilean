# trilean

> /ˈtraɪ.li.ən/ (TRY-lee-ən) — rhymes with "boolean".

A serialisable (JSON) representation of two related tree structures — a **predicate tree** (truth-valued) and an **expression tree** (value-valued) — together with an evaluator for both. The package is deliberately domain-agnostic: the schema layer never assumes anything about where data actually comes from. Every point of contact with a consumer's real data is an injected, opaque resolver function supplied by whoever embeds the package.

Typical use: representing business rules, eligibility conditions, pricing formulae, or validation logic as data (JSON) that can be stored, transmitted, edited by non-developers via a UI, and evaluated identically wherever it lands — a browser, a server, a batch job — without recompiling anything.

## Getting started

```sh
npm install trilean
# or
pnpm add trilean
```

The package ships as dual ESM and CJS builds, is isomorphic (no assumptions about a Node, browser, or Workers runtime — see [Design principles](#design-principles)), and has zero runtime dependencies beyond [Zod](https://zod.dev).

```ts
import { evaluatePredicate, type PredicateNode, type Resolvers } from "trilean";

const node: PredicateNode = {
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "age" },
  right: { kind: "numberLiteral", value: 18 },
};

const resolvers: Resolvers = {
  async resolveValue(key, context) {
    const record = context as Record<string, unknown>;
    return key === "age" && "age" in record
      ? { found: true, value: { kind: "number", value: record.age as number } }
      : { found: false };
  },
  async resolveLookup() {
    return { found: false };
  },
  async resolveCollection() {
    return [];
  },
};

await evaluatePredicate(node, { age: 21 }, resolvers);
// => { status: "definite", value: true }
```

See [Evaluator entry points](#evaluator-entry-points) and [Resolvers](#resolvers) for the full contract, and the [Worked example](#worked-example) for a larger tree combining boolean logic, a formula, and an aggregation.

## Build, test, and lint

```sh
pnpm install
pnpm build          # tsdown -> dist/, then generates schemas/trilean.schema.json
pnpm test           # unit suite, against src/
pnpm test:integration # multi-kind composition, schema-pipeline, and function-registry/delegate tests, against src/
pnpm test:smoke     # builds first, then checks dist/ in both ESM and CJS plus the generated JSON Schema
pnpm test:workers   # runs the evaluator inside a real Cloudflare Workers isolate
pnpm lint
pnpm typecheck
```

## Provenance

This design was produced by a clean-room (Chinese-wall) process. An examiner role with prior exposure to existing, unrelated proprietary/confidential schema designs (not named here, out of respect for the confidentiality obligations attached to that exposure) wrote a code-free functional specification describing only observed behaviour and requirements — no source code, no copied identifiers, comment text, or structure, and no attributable specifics of any originating system, company, product, or industry. That specification was reviewed against a scrubbing checklist to confirm it contained function rather than expression, then handed, as the entire and only input, to a separately-instantiated implementer with no access to whatever the examiner had seen. Everything below this point — every type name, every worked example, every design decision not explicitly forced by the specification — is that implementer's independent work.

Every worked example in this document uses invented, generic field names for exactly this reason: nothing about the actual formulae, data model, or terminology of whatever the examiner had prior exposure to should be recoverable from it.

## Design principles

These hold across every part of the design below, and any implementation change must preserve them:

- **No assumptions about consumer data.** The only places this package touches real data are three named resolver contracts (see [Resolvers](#resolvers)). The schema stores *what to pass* to a resolver, never any resolver logic itself, and never interprets the meaning of an opaque key, table identifier, or collection reference.
- **Three outcomes, never two.** Every evaluation produces a definite result or an indeterminate result carrying a reason — never a bare `boolean`/`number`, and never a thrown exception for a data-quality problem. See [The evaluation model](#the-evaluation-model).
- **Derived constructs are compositions, not new logic.** Anything describable as "some other primitive, wired together" is implemented that way, so its correctness is inherited rather than requiring separate proof. See [Derived connectives](#derived-connectives) and [Derived aggregates](#derived-aggregates).
- **One schema, mechanically derived artefacts.** A single canonical type definition produces the runtime validator and the portable wire-format schema; they cannot drift apart because there is only one source. See [Schema strategy](#schema-strategy).
- **Generic examples only.** Every example in this document uses invented, placeholder field names (`temperature`, `orderTotal`, `isActive`, `x`, `y`, `amount`, `items`) with no resemblance to any particular company, product, or industry's real data model.

## The evaluation model

Every evaluation — of a predicate node or an expression node — produces exactly one of two outcomes:

```ts
type Evaluation<T> =
  | { status: "definite"; value: T }
  | { status: "indeterminate"; reason: IndeterminateReason };

interface IndeterminateReason {
  /** Which of the three reason categories applies. */
  code: "not-found" | "wrong-type" | "domain-error";
  /** A human-readable explanation, for logging and debugging. */
  message: string;
}
```

The three reason codes are:

| Code | Meaning |
|---|---|
| `not-found` | A value a node needed did not exist in the underlying data at all. |
| `wrong-type` | A value existed but was not of a kind the operation could use (e.g. non-numeric where a number was required). |
| `domain-error` | A mathematical operation was attempted outside its valid domain (division by zero, a function given an input outside its allowed range, an aggregation with nothing to aggregate). |

`domain-error` is not a separate error type, exception, or crash — it uses exactly the same `Evaluation`/`IndeterminateReason` mechanism as the other two. This three-outcome model applies uniformly to every node kind in both trees: arithmetic, comparison, and boolean logic alike. It never collapses to a plain boolean or number at any intermediate point inside the tree; only the code that consumes the final top-level `Evaluation` decides what to do with an indeterminate outcome (reject, default, surface to a user, etc.) — that decision is deliberately outside this package's scope.

**Infrastructure failures are a different concern.** If a resolver itself throws (a network error, a database outage), that propagates as an ordinary rejected promise from `evaluatePredicate`/`evaluateValue`, exactly like any other function call failure. The three-outcome model exists to describe *data-quality* states inside the domain being modelled — it does not, and should not, attempt to also model transport-level failure.

### Where an indeterminate outcome can carry more than one candidate reason

Some nodes combine several sub-evaluations that could each independently be indeterminate for a different reason (e.g. an `and` node whose both operands are indeterminate, one `not-found` and one `wrong-type`). This design resolves ties with a single, consistently-applied rule: **take the first indeterminate reason encountered in the node's own declared operand order** (left before right; list order for N-ary/collection operands). This is an implementation decision this document makes explicitly, once, so every node kind's evaluator can apply the same rule without re-deriving it.

## Three-valued propagation rules

Let **U** denote "indeterminate" for the purposes of these tables — the specific reason is preserved and reported per the tie-break rule above, but propagation logic itself only cares that an operand is not a definite value. **T** = true, **F** = false.

**Any arithmetic operation or relational comparison with at least one indeterminate operand always produces an indeterminate result.** There is no operand value that can rescue an arithmetic or single relational comparison once one side is indeterminate — arithmetic and single relational comparisons have no absorbing value and no short-circuit.

Logical AND, OR, and NOT behave differently: they have absorbing values, and this absorption must be preserved exactly as specified below. **A design in which any indeterminate operand automatically makes the whole boolean result indeterminate, with no absorption, is a specification defect** — it would silently discard cases where the answer was already determined regardless of the indeterminate side.

**AND** — `false` is absorbing/dominant:

| AND | T | F | U |
|---|---|---|---|
| **T** | T | F | U |
| **F** | F | F | F |
| **U** | U | F | U |

**OR** — `true` is absorbing/dominant (mirror image of AND):

| OR | T | F | U |
|---|---|---|---|
| **T** | T | T | T |
| **F** | T | F | U |
| **U** | T | U | U |

**NOT** — negates a definite result; leaves indeterminate as indeterminate, reason unchanged:

| NOT | result |
|---|---|
| T | F |
| F | T |
| U | U |

**Identity elements for the N-ary and collection forms.** AND is a fold over `true` (the identity for AND), OR is a fold over `false` (the identity for OR) — this is a structural property of the operation, not a separate design choice, so it applies consistently everywhere an AND/OR is taken across a list: an empty `allOf` is definitely `true`; an empty `anyOf` is definitely `false`; a "some" quantifier over an empty collection is definitely `false` (no item can satisfy it).

> **Deliberate, settled: `every` over an empty collection is definitely `true`.** This is vacuous truth — the standard convention for universal quantification over an empty set, and exactly the same identity-element reasoning already used for `allOf` above (an empty `allOf`'s `true` and an empty `every`'s `true` are the same fact, stated twice because `every` is a quantifier over resolved items rather than a literal list of sub-nodes). This is worth stating explicitly and prominently, rather than leaving it as something an implementer might reasonably second-guess, because at least one other real, existing tool in this space gets exactly this case wrong — its own "all" operator returns `false` for an empty collection, which is simply an incorrect implementation of universal quantification, not an equally valid alternative convention. Nothing about a genuinely empty collection can violate "every item satisfies X", so `true` is the only value consistent with what the quantifier claims to mean; this document's `every` must not be "fixed" to match that other tool's behaviour.

## Derived connectives

Exclusive-or, NAND, NOR, implication, and the biconditional are never implemented as independently-evaluated node kinds. Each is defined purely as a fixed composition of unary NOT and binary AND/OR, expressed as ordinary builder functions that construct a tree of primitive nodes:

```ts
const not    = (a: PredicateNode): PredicateNode => ({ kind: "not", operand: a });
const and    = (a: PredicateNode, b: PredicateNode): PredicateNode => ({ kind: "and", left: a, right: b });
const or     = (a: PredicateNode, b: PredicateNode): PredicateNode => ({ kind: "or", left: a, right: b });

const xor     = (a: PredicateNode, b: PredicateNode): PredicateNode => or(and(a, not(b)), and(not(a), b));
const nand    = (a: PredicateNode, b: PredicateNode): PredicateNode => not(and(a, b));
const nor     = (a: PredicateNode, b: PredicateNode): PredicateNode => not(or(a, b));
const implies = (a: PredicateNode, b: PredicateNode): PredicateNode => or(not(a), b);
const iff     = (a: PredicateNode, b: PredicateNode): PredicateNode => not(xor(a, b));

const none = (collection: JsonValue, item: PredicateNode, filter?: PredicateNode): PredicateNode =>
  not({ kind: "some", collection, item, filter });
```

None of `xor`/`nand`/`nor`/`implies`/`iff` ever appears as a `kind` discriminant on the wire — a serialised tree containing an XOR is indistinguishable from one written out by hand using `or`/`and`/`not`. Three-valued correctness for all five is therefore inherited automatically from the already-verified AND/OR/NOT tables above, never requiring a separate proof for each.

The same treatment applies to a third quantifier, `none` ("no item satisfies") — defined purely as `not(some(...))`, never as its own independently-evaluated node kind, and so never appearing as its own `kind` discriminant either. Its three-valued correctness is inherited automatically from NOT and from `some`'s own already-established correctness (including its absorbing behaviour and its `filter` handling) — no new truth table or worked proof is needed, exactly as for the five connectives above.

### Worked correctness check: exclusive-or

Applying the AND/OR/NOT tables above to `xor(A, B) = or(and(A, not(B)), and(not(A), B))` across all nine combinations of `{T, F, U}` for `A` and `B`:

| A | B | not B | A ∧ ¬B | not A | ¬A ∧ B | result (∨) | expected |
|---|---|---|---|---|---|---|---|
| T | T | F | F | F | F | F | F |
| T | F | T | T | F | F | T | T |
| T | U | U | U | F | F | U | U |
| F | T | F | F | T | T | T | T |
| F | F | T | F | T | F | F | F |
| F | U | U | F | T | U | U | U |
| U | T | F | F | U | U | U | U |
| U | F | T | U | U | F | U | U |
| U | U | U | U | U | U | U | U |

Every fully-known input pair produces the correct classical XOR, and every combination with at least one `U` produces `U`. This is the correct three-valued extension specifically for XOR — unlike AND/OR, exclusive-or has no operand value that determines the result on its own (there is no value of `B` for which `xor(anything, B)` is fixed regardless of the other side), so it has no absorbing value and "any unknown input yields an unknown output" is exactly right here — even though the identical blanket rule would be *wrong* for AND/OR, where it would ignore real absorption. NAND, NOR, implication, and the biconditional each inherit correct behaviour the same way, purely from being built out of NOT/AND/OR — check any of them the same way, by writing out all nine input combinations and confirming the result matches intuition. As one further spot check: `implies(F, U) = or(not(F), U) = or(T, U) = T` — a false antecedent makes an implication vacuously true regardless of whether the consequent is even knowable, which is the absorbing behaviour correctly carried through from OR.

## Schema strategy

The canonical definition lives in one place: a [Zod](https://zod.dev) schema per node kind. The TypeScript type is inferred from the schema (`z.infer<...>`), and a portable wire-format schema for documentation or cross-language interoperability is mechanically derived from the same Zod schema via `z.toJSONSchema()`. There is exactly one hand-authored artefact; the runtime validator and the JSON Schema document cannot drift apart because the second is generated from the first, not maintained alongside it.

```ts
import { z } from "zod";

// A JSON value with no further meaning imposed by this schema — used for every
// opaque payload (reference keys, table identifiers, collection references,
// delegation payloads). "Opaque" means "uninterpreted by this package", not
// "untyped" — every one of these must still be plain, serialisable JSON.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])
);
```

Node schemas are `z.discriminatedUnion("kind", [...])` over per-kind `z.object` shapes, following the concrete definitions below. A generated JSON Schema document (produced once, as a build step, via `z.toJSONSchema(PredicateNodeSchema)` / `z.toJSONSchema(ExpressionNodeSchema)`) is what a non-TypeScript consumer or an authoring UI would target.

The generated document carries a version-pinned `$id` — a jsDelivr URL naming the exact published version, e.g. `https://cdn.jsdelivr.net/npm/trilean@1.2.3/schemas/trilean.schema.json` — so a consumer's own rule file can point its `$schema` at a fixed target rather than a moving one. The file is also RFC 8785 (JSON Canonicalization Scheme) canonical: keys sorted recursively, no whitespace between tokens, deterministic byte-for-byte output for the same input. This makes the file hashable, which is useful for verifying a downloaded copy against this package's own SBOM and build-provenance attestations (see the release workflow).

### Performance

A consumer that parses and evaluates many trees at high throughput can opt into Zod 4.5's compiled-schema fast path by importing `zod/compile` once, at their own application's entry point:

```ts
import "zod/compile";
```

This package deliberately does **not** import it itself — `zod/compile` has global side effects on the Zod runtime, which would contradict this package's own `sideEffects: false` declaration and could surprise a consumer who never asked for it. Opting in (or not) is left entirely to whoever embeds the package.

## The predicate tree

A `PredicateNode` evaluates to `Evaluation<boolean>` — true, false, or indeterminate-with-reason.

```ts
type ComparisonOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
type TextComparisonOperator = "equals" | "notEquals" | "matches" | "notMatches";
type MembershipOperator = "in" | "notIn";

type PredicateNode =
  | { kind: "not"; operand: PredicateNode }
  | { kind: "and"; left: PredicateNode; right: PredicateNode }
  | { kind: "or"; left: PredicateNode; right: PredicateNode }
  | { kind: "allOf"; operands: PredicateNode[] }
  | { kind: "anyOf"; operands: PredicateNode[] }
  | { kind: "compare"; op: ComparisonOperator; left: ExpressionNode; right: ExpressionNode }
  | { kind: "textCompare"; op: TextComparisonOperator; left: ExpressionNode; right: ExpressionNode }
  | { kind: "memberOf"; op: MembershipOperator; operand: ExpressionNode; candidates: ExpressionNode[] }
  | { kind: "exists"; operand: ExpressionNode }
  | { kind: "some"; collection: JsonValue; item: PredicateNode; filter?: PredicateNode }
  | { kind: "every"; collection: JsonValue; item: PredicateNode; filter?: PredicateNode };
```

### `not`, `and`, `or`

The three primitives. `not` takes exactly one operand — it is never modelled as a two-operand node with an unused second slot. `and`/`or` each take exactly two named operands (`left`/`right`), evaluated per the truth tables above.

### `allOf`, `anyOf`

The N-ary forms of `and`/`or`: given an ordered list of operands (rather than exactly two), combine all of them with AND, or all of them with OR, respectively. Defined as repeated pairwise application of `and`/`or` — an implementation detail, not a new evaluation rule requiring separate verification. Because resolvers are asynchronous, a reference implementation is free to evaluate every operand concurrently and then apply the absorption rule when combining results, rather than evaluating strictly left-to-right; both strategies produce an identical final `Evaluation` because absorption is a property of the values, not of execution order. The empty-list identity values from [Three-valued propagation rules](#three-valued-propagation-rules) apply: `allOf([])` is definitely `true`; `anyOf([])` is definitely `false`.

### `compare`

A relational-comparison leaf: compares two computed values using `gt`/`gte`/`lt`/`lte`/`eq`/`neq`. **Both `left` and `right` are `ExpressionNode`** — either side may be a plain literal/reference or an arbitrary formula from the expression tree; the comparison is symmetric, and an implementation that only allows a formula on one side is incomplete. Valid operand kinds are `number` (matching units required — see [Units](#units)), `instant`, or `duration`; comparing across different computed-value kinds, or comparing two numbers with incompatible units, is `wrong-type`.

### `textCompare`

A text-matching leaf, symmetric in the same way as `compare`: both `left` and `right` are `ExpressionNode`, and either may be a literal or an arbitrary formula. `equals`/`notEquals` are exact string equality; `matches`/`notMatches` interpret `right` as a pattern (an ECMAScript-style regular expression) tested against `left`'s text. Both operands must resolve to the `text` computed-value kind; anything else is `wrong-type`. A "small fixed category" value (e.g. a status label) is simply a `text` computed value from this leaf's point of view — no separate category kind exists.

### `memberOf`

A membership-test leaf, parallel to `compare` and `textCompare` rather than folded into either one's operator set: `operand` is the `ExpressionNode` being tested; `candidates` is a list of `ExpressionNode`s to test it against, every element of which may independently be an arbitrary formula, not only a literal — the same symmetry principle already applied to `compare` and `textCompare`. `op: "in"` asks whether `operand` equals any candidate; `op: "notIn"` asks whether it equals none of them.

Membership is decided by value equality between computed values of the same kind, respecting units for numeric values exactly as `compare`'s own `eq` already does — a candidate of an incompatible kind, or a `number` candidate with an incompatible unit, can never be a match, and the comparison for that one element is `wrong-type`, not simply "not equal".

Evaluate `operand` first; if it is indeterminate, the whole leaf is indeterminate with that reason. Otherwise, scan `candidates` in order: a candidate that is a **definite match** immediately settles the result — `in` is definitely `true`, `notIn` is definitely `false` — regardless of any not-yet-scanned or indeterminate candidates, mirroring the same absorbing-value discipline already established for OR and `some` elsewhere in this document (a confirmed match cannot be undone by an unrelated element's data problem). If scanning completes with no definite match: the leaf is indeterminate (first indeterminate candidate's reason, per the tie-break rule in [The evaluation model](#the-evaluation-model)) if at least one candidate was itself indeterminate or of an incompatible kind/unit; otherwise every candidate was a definite, comparable non-match, and `in` is definitely `false`, `notIn` is definitely `true`. An empty `candidates` list is never scanned and never indeterminate: `in` is definitely `false` and `notIn` is definitely `true` — the same non-vacuous facts an empty `anyOf`/`allOf` already establishes for OR/AND.

### `exists`

Evaluates `true` if the given `ExpressionNode` can be resolved to some value at all, `false` if it definitely cannot be resolved (the data point is genuinely absent), independent of whether that value would itself be usable in further computation. Concretely: evaluate the operand; if the result is definite, `exists` is `true`; if the result is indeterminate with reason `not-found`, `exists` is `false`; if the result is indeterminate with reason `wrong-type` or `domain-error`, `exists` is still `true` — the underlying data point *did* resolve to something, it merely wasn't usable for whatever computation was attempted around it, which is exactly why section [The evaluation model](#the-evaluation-model) distinguishes "did not exist" from "existed but unusable" in the first place. `exists` itself is never indeterminate — it always produces a definite boolean.

### `some`, `every`

Quantifiers over a collection, sharing the exact collection-resolution mechanism described in [Collections](#collections). `some` is semantically an OR of `item` evaluated once per participating item; `every` is semantically an AND of `item` evaluated once per participating item — both inherit the absorbing-value propagation from the AND/OR tables applied across the whole collection (e.g. `some` can be definitely `true` from one known-true item even if every other participating item is unresolvable). An optional `filter` narrows which resolved items participate at all before either quantifier runs over them — see [Collections](#collections) for exactly how a `filter` result feeds into this same absorption. The item's own evaluation context (for both `filter` and `item`) is the item itself — see [Collections](#collections). A third quantifier, "no item satisfies", is derived from `some` — see [Derived connectives](#derived-connectives).

## The expression tree

An `ExpressionNode` evaluates to `Evaluation<ComputedValue>`.

```ts
type Unit = Record<string, number>; // dimension symbol -> exponent, e.g. { m: 1, s: -1 } for metres per second
type DurationUnit = "ms" | "s" | "min" | "h" | "d";

type ComputedValue =
  | { kind: "number"; value: number; unit?: Unit }
  | { kind: "text"; value: string }
  | { kind: "instant"; value: string }   // ISO-8601 timestamp
  | { kind: "duration"; value: number; unit: DurationUnit };

type ArithmeticOperator = "add" | "subtract" | "multiply" | "divide" | "power" | "modulo";

type FoldCombiner =
  | { mode: "max"; item: ExpressionNode }
  | { mode: "min"; item: ExpressionNode }
  | { mode: "reduce"; initial: ExpressionNode; combine: ExpressionNode };

type ExpressionNode =
  | { kind: "numberLiteral"; value: number; unit?: Unit }
  | { kind: "textLiteral"; value: string }
  | { kind: "instantLiteral"; value: string }
  | { kind: "durationLiteral"; value: number; unit: DurationUnit }
  | { kind: "reference"; key: JsonValue; unit?: Unit }
  | { kind: "arithmetic"; op: ArithmeticOperator; left: ExpressionNode; right: ExpressionNode }
  | { kind: "negate"; operand: ExpressionNode }
  | { kind: "call"; fn: string; args: ExpressionNode[] }
  | { kind: "lookup"; table: JsonValue; keys: ExpressionNode[] }
  | { kind: "conditional"; cases: { when: PredicateNode; then: ExpressionNode }[]; fallback: ExpressionNode }
  | { kind: "fold"; collection: JsonValue; filter?: PredicateNode; combiner: FoldCombiner }
  | { kind: "accumulator" }
  | { kind: "delegate"; system: string; payload: JsonValue };
```

A `textLiteral` kind is included even though it is not separately enumerated as its own top-level construct, because `textCompare`'s symmetry requirement (either side may be an arbitrary computed value, per the section above) is meaningless without a way to write a constant string or pattern — matching a field against the fixed text `"active"`, or against a fixed regular expression, needs a text constant on one side. This is a structural consequence of the symmetry already required for text matching, not an added feature.

### Literals

`numberLiteral`, `textLiteral`, `instantLiteral` (an ISO-8601 timestamp string), and `durationLiteral` (a magnitude plus a `DurationUnit`) are always definite by construction — a literal node never itself produces an indeterminate outcome.

### `reference`

A reference to a single external value, identified by an opaque `key` whose meaning is entirely up to the embedding consumer — the schema never interprets it (see [Resolvers](#resolvers), resolver 1). May optionally carry an expected `unit`, validated against whatever the resolver actually returns for a `number` result; a mismatch (or an expectation of a unit on a non-numeric result) is `wrong-type`. If the resolver reports absence, the result is `not-found`.

### `arithmetic`, `negate`

Binary arithmetic (`add`/`subtract`/`multiply`/`divide`/`power`/`modulo`) and unary negation, each over `number` computed values by default, with the temporal exceptions listed under [Temporal values](#temporal-values) below. `negate` is an explicit node — never sugar for "zero minus the value" — because it also applies to `duration` values (negating a duration reverses its direction) where "zero minus" has no natural literal-zero counterpart. Division by zero, or any operator given an operand outside its mathematical domain, is `domain-error`; a non-numeric, non-temporal operand where a number was required is `wrong-type`; any operand that is itself indeterminate makes the whole node indeterminate, with no rescuing value on the other side (see [Three-valued propagation rules](#three-valued-propagation-rules)).

### `call`

A named function applied to an ordered list of `ExpressionNode` arguments. The set of named functions is intentionally open-ended and resolved through a function registry supplied at evaluator construction time — `minimum`, `maximum`, `absoluteValue`, `round`, `squareRoot`, and `logarithm` are starting examples, not an exhaustive list; new functions are added to the registry as concrete need arises. Calling an unregistered function name is `wrong-type` ("no function registered under this name"); calling a registered function with an argument outside its domain (e.g. `squareRoot` given a negative number) is `domain-error`.

### Units

`numberLiteral` and `reference` may carry a `unit`, represented as a dimensional-exponent map (e.g. `{ m: 1, s: -1 }` for metres per second) rather than an opaque string, so that unit combination follows real dimensional analysis instead of string matching. A bare symbol like `"kg"` is shorthand for `{ kg: 1 }`.

- `add`/`subtract` between two unit-tagged numbers require **identical** dimensional-exponent maps. A mismatch is `wrong-type` ("incompatible units") — units are never silently coerced or dropped.
- `multiply`/`divide` combine the two operands' unit maps by dimensional analysis: multiplying adds exponents per dimension, dividing subtracts them. An operand with no `unit` is treated as dimensionless (an empty map) for this purpose.

### Temporal values

`instant` (a point in time) and `duration` are computed-value kinds distinct from `number`, even though a duration ultimately carries a numeric magnitude — an instant is never treated as "a number that happens to represent a date". The only well-defined cross-kind arithmetic is:

- `instant − instant → duration`
- `instant + duration → instant` (and `duration + instant → instant`)

Any other arithmetic combination touching an `instant` or `duration` (adding two instants, multiplying a duration by an instant, comparing an instant against a plain number, and so on) is `wrong-type`. A reference implementation normalises `duration` values to a single base unit (milliseconds) internally before combining two durations of different `DurationUnit`s, then reports the result in whichever unit the node's own context calls for.

### `lookup`

Resolves a single value from a named external table-like source, keyed by one or more `ExpressionNode` keys, via resolver 2 (see [Resolvers](#resolvers)). The schema never interprets what "table" or "key" mean to a given consumer; `table` and the resolved key values are passed through verbatim. If any key expression is itself indeterminate, the lookup is indeterminate with that reason (no key evaluation, no lookup attempt). If the resolver reports no match, the result is `not-found`.

### `conditional`

A piecewise/conditional-value node: an ordered, possibly-empty list of `{ when, then }` cases plus a required `fallback`. Evaluates to the `then` of the first case whose `when` predicate is definitely `true`; if no case matches, evaluates to `fallback`. If evaluating a `when` predicate produces an indeterminate outcome **before any earlier case has matched**, the whole `conditional` node's own result is that same indeterminate outcome (reason preserved) — evaluation does not skip past an unknown guard to try the next one, because doing so could silently pick a later branch that only looks correct because an earlier one couldn't actually be checked.

### `fold`

An aggregation over a collection (see [Collections](#collections)): `collection` is the opaque collection reference; an optional `filter` narrows which resolved items participate (see [Collections](#collections)); `combiner` decides how the participating items' values become one result. There is exactly one general mechanism, `reduce`, and exactly two named forms, `max`/`min`, that cannot be expressed as an instance of it — see [Derived aggregates](#derived-aggregates) for why `sum`, `count`, and `average` need no combiner mode of their own at all.

**`reduce`** is "fold with an accumulator": `initial` is evaluated once, in the fold node's own (outer) context, to seed the running result; then, for each participating item in turn, `combine` is evaluated with that item as its evaluation context to produce the new running result from the old one. `combine` reaches the running result through the dedicated [`accumulator`](#accumulator) leaf; the item's own fields are reached the ordinary way, through `reference`/`lookup` nodes resolved against the item context. Over an empty (post-filter) collection, a `reduce` fold evaluates to `initial` without ever touching `combine`.

**`max`/`min`** each carry an `item`, evaluated once per participating item using that item as its evaluation context, and keep the largest/smallest projected value seen. These two are the only combining behaviours that stay as their own directly-specified forms, for a precise mathematical reason rather than an arbitrary exception: `reduce` needs a seed value that is also the identity for `combine` (as `0` is for addition), and there is no largest or smallest real number to seed a running maximum or minimum with — the JSON number model has no literal for an unbounded sentinel. `max`/`min` are still the same underlying mechanism, just its standard *unseeded* variant (sometimes called "reduce1" elsewhere): the running result starts as the first participating item's own projected value, and `combine` (the ordinary "keep the larger"/"keep the smaller" comparison) is applied to each item after that — not an independently-invented special case, only the one variant of the mechanism that a literal `initial` genuinely cannot express. Over an empty (post-filter) collection, both are `domain-error` (undefined over an empty set, the same category as division by zero, per [The evaluation model](#the-evaluation-model)'s explicit allowance for "any comparable domain violation for any function added later") — there is no first item to seed from.

**Indeterminacy, both forms.** If any participating item's `filter` evaluation is indeterminate, the whole `fold` is indeterminate with that reason — `fold` has no absorbing value (see [Three-valued propagation rules](#three-valued-propagation-rules)), so unlike a quantifier's OR/AND there is no other item's outcome that can override this (see [Pre-filtering which items participate](#pre-filtering-which-items-participate)). The same is true of any participating item's `item`/`combine` evaluation, and of a `reduce`'s `initial`: if any is indeterminate, the whole `fold` is indeterminate with that reason (first such candidate, in resolved-list order, `initial` counting as evaluated before any item).

### `accumulator`

A zero-field leaf, meaningful only inside the `combine` expression of an enclosing `fold`'s `reduce` form (see [`fold`](#fold) above), where it evaluates to that step's running accumulated result. A nested `fold`'s own `combine` expression introduces its own, separate accumulator scope — `accumulator` always refers to the innermost enclosing reduce fold. Using `accumulator` anywhere else (a `max`/`min` fold's `item`, a `filter` predicate, a quantifier's `item`, or outside any fold at all) is `wrong-type` — there is no running accumulator in scope.

### Derived aggregates

`sum`, `count`, and `average` are never their own `FoldCombiner` mode — each is a builder function that assembles an ordinary `fold` (and, for `average`, one `arithmetic` division of two ordinary folds), exactly the same treatment [Derived connectives](#derived-connectives) already gives `xor`/`nand`/`nor`/`implies`/`iff`/`none`: correctness is inherited from the mechanism they're built from, rather than needing its own independent implementation that could silently drift from it.

```ts
const sum = (collection: JsonValue, item: ExpressionNode, filter?: PredicateNode): ExpressionNode => ({
  kind: "fold",
  collection,
  filter,
  combiner: {
    mode: "reduce",
    initial: { kind: "numberLiteral", value: 0 },
    combine: { kind: "arithmetic", op: "add", left: { kind: "accumulator" }, right: item },
  },
});

const presenceOf = (probe: ExpressionNode): ExpressionNode => ({
  kind: "conditional",
  cases: [
    {
      when: { kind: "memberOf", op: "in", operand: probe, candidates: [probe] },
      then: { kind: "numberLiteral", value: 1 },
    },
  ],
  fallback: { kind: "numberLiteral", value: 0 }, // unreachable: a definite probe is always a member of the single-element list containing only itself
});

const count = (collection: JsonValue, filter?: PredicateNode, probe?: ExpressionNode): ExpressionNode => ({
  kind: "fold",
  collection,
  filter,
  combiner: {
    mode: "reduce",
    initial: { kind: "numberLiteral", value: 0 },
    combine: {
      kind: "arithmetic",
      op: "add",
      left: { kind: "accumulator" },
      right: probe ? presenceOf(probe) : { kind: "numberLiteral", value: 1 },
    },
  },
});

const average = (collection: JsonValue, item: ExpressionNode, filter?: PredicateNode): ExpressionNode => ({
  kind: "arithmetic",
  op: "divide",
  left: sum(collection, item, filter),
  right: count(collection, filter),
});
```

`sum` needs no per-item probe beyond `item` itself: it is a literal `reduce` seeded at `0`, adding each participating item's projected value to the running total, and it already goes indeterminate if `item` fails to resolve for any participating item — no separate mechanism needed, since `item`'s value is exactly what gets added.

`count` takes an optional third argument, `probe`, and this is where it matters that `filter` and a probe are not the same thing. `filter` *excludes* an item from participating — a filtered-out item's absence is invisible in the final result, exactly as if it had never been in the collection at all. A `probe` does the opposite: it doesn't decide whether an item participates, it makes the *whole count* indeterminate if it fails to resolve for *any* participating item, surfacing "I cannot give you a trustworthy count" rather than silently reporting a smaller, technically-successful count for the same underlying data-quality problem — precisely the distinction the rest of this document's indeterminate-outcome model exists to preserve (see [The evaluation model](#the-evaluation-model)). `count(collection, filter)` with no `probe` is a plain `reduce` seeded at `0` that adds `1` per participating item, with no indeterminacy of its own beyond `filter`'s. `count(collection, filter, probe)` instead adds `presenceOf(probe)` per participating item — a small helper built entirely from already-established primitives, with no restriction on `probe`'s kind: it tests `probe` for membership in the single-element list `[probe]`, so a `memberOf` "in" test against itself is trivially true whenever `probe` resolves to a definite value of *any* kind (`memberOf`'s equality is already kind-agnostic across `number`/`text`/`instant`/`duration` — see [`memberOf`](#memberof)), and exactly `probe`'s own indeterminate outcome otherwise, per `memberOf`'s own "evaluate `operand` first" rule. A `conditional` then turns that boolean into the number `1`; its `fallback` is never reached, since a definite `probe` always equals itself. (A real implementation may memoise `probe`'s single evaluation rather than running the resolver twice for `operand` and its one `candidates` entry — resolvers are pure functions of their inputs throughout this design, so this is a performance choice, not a correctness one.)

`average` is `sum` divided by `count` over the same `collection`/`filter`, with no `probe` — `sum`'s own `item` already forces every participating item's projected value to resolve, so `average`'s numerator is already indeterminate under exactly the condition a `count` probe exists to detect, with nothing left to duplicate. Nothing new to verify for the empty-collection case either: division's own already-established rule (zero divisor is `domain-error`) is *why* `average` over an empty collection is `domain-error`, since `count` over an empty collection is `0` and `sum(...)/0` already means exactly that.

### `delegate`

An explicitly-named external system plus an arbitrary, unevaluated JSON payload, standing in for the whole node without this package attempting to evaluate it itself — see [Out of scope](#out-of-scope). Evaluating a `delegate` node is not part of this package's own evaluation semantics. The reference evaluator accepts an optional delegate handler per external system name; if none is registered for the named `system`, evaluating the node is indeterminate (`wrong-type`, "no delegate handler registered for external system '<name>'"). Consumers who want a `delegate` node to actually resolve are expected either to register a handler, or to pre-process the tree — walk it, find delegation nodes, invoke the named external system out of band, and substitute the result as a literal — before the tree ever reaches this package's evaluator.

## Collections

Both `fold` and the two quantifier leaves (`some`/`every`, and transitively `none`) need "a collection of items" resolved from something the schema itself treats as opaque data. The schema's job is only to carry an opaque reference to what collection is meant, plus a sub-node (an `ExpressionNode` for `fold`, a `PredicateNode` for the quantifiers) to be evaluated once per resolved item, using that single item as its evaluation context, plus an optional per-item pre-filter — see [Pre-filtering which items participate](#pre-filtering-which-items-participate).

How an opaque collection reference actually becomes a concrete list of items is entirely the resolver's responsibility, and is expected to vary enormously between consumers — one consumer's "collection" might be an array already sitting inside a single in-hand record (zero further lookups needed); a completely different consumer's "collection" might require actively traversing some larger connected structure outward from a starting point to discover which items even belong to it, with nothing available up front. The schema and evaluator support both extremes, and anything in between, equally well, purely by keeping the reference opaque and leaving all resolution logic behind the injected collection resolver — there is no assumption anywhere about how many steps are involved in turning a reference into a list.

### Evaluation context

```ts
type EvaluationContext = unknown;
```

Every evaluation call is threaded through an `EvaluationContext` — an opaque, purely in-process value supplied by the caller, never itself part of the serialised tree and never required to be JSON-serialisable (unlike every payload described above, which *does* travel inside the tree and must be plain JSON). `reference` and `lookup` resolution both receive the current context. Descending into a `fold` or a quantifier replaces the context for the sub-node's evaluation with the single resolved item — literally the item itself, not a wrapper around it — so that a `reference` inside `item`/case sub-trees resolves against that item rather than against whatever the outer context was.

### Pre-filtering which items participate

`fold`, `some`, and `every` each accept an optional `filter: PredicateNode`, evaluated once per candidate item using that item as its own evaluation context — exactly the same mechanism `fold`'s own per-item expression and the quantifiers' own `item` sub-node already use. An item for which `filter` is definitely `true` participates; one for which it is definitely `false` is excluded, exactly as if it had never been in the collection at all. Time-window narrowing (only include items whose own timestamp falls within given bounds) is simply one example use of this general mechanism — a `filter` predicate comparing the item's own timestamp field against bounds via `compare` — not a separate concept, and there is no dedicated time-scoping field alongside it. A resolver that already knows how to push a narrowing hint down into its own data access remains free to do so using whatever it can infer from the opaque `collection` reference and `context` it already receives — `filter` narrows the schema's own view of the result, it doesn't preclude a resolver-side optimisation underneath.

An item whose `filter` is itself indeterminate is never silently included or excluded — silently picking either would hide a real data-quality problem behind an arbitrary default. What happens next depends on whether the surrounding node has an absorbing value: `fold` has none (see [Three-valued propagation rules](#three-valued-propagation-rules)), so an indeterminate `filter` on any candidate item unconditionally makes the whole `fold` indeterminate, exactly as an indeterminate `item`/`combine` evaluation already does. The quantifiers do have one: an indeterminate `filter` makes that one item's own contribution to the surrounding OR (`some`)/AND (`every`) indeterminate, and the quantifier's already-established absorption rule then decides the final result exactly as it already does for an indeterminate `item` evaluation — a `some` with one item whose `filter` can't be resolved still comes back definitely `true` if a different, cleanly-filtered item is a definite match. Treating an indeterminate filter as an automatic override of an already-decided quantifier result would reintroduce, for filtering specifically, exactly the "any indeterminate operand poisons everything, no absorption" defect this document already identifies as wrong for AND/OR in general.

## Resolvers

Three independent points of extension, each supplied separately by the embedding consumer, each treated by the schema as pure data to hand over — never as resolver logic living inside the schema itself:

```ts
type Resolution =
  | { found: true; value: ComputedValue }
  | { found: false };

interface Resolvers {
  /** Resolver 1 — a single opaque key to a single value (IV.reference). */
  resolveValue(key: JsonValue, context: EvaluationContext): Promise<Resolution>;

  /** Resolver 2 — an opaque table identifier plus computed keys to a single value (IV.lookup). */
  resolveLookup(table: JsonValue, keys: ComputedValue[], context: EvaluationContext): Promise<Resolution>;

  /** Resolver 3 — an opaque collection reference to a concrete list of items (fold/some/every). */
  resolveCollection(collection: JsonValue, context: EvaluationContext): Promise<unknown[]>;

  /** Optional, separate from the three core contracts — see the `delegate` node kind. */
  resolveDelegate?(system: string, payload: JsonValue, context: EvaluationContext): Promise<Resolution>;
}
```

`resolveCollection` takes no narrowing parameter of its own: it always returns the full candidate list for the given reference, and narrowing which of those candidates actually take part is handled uniformly, after resolution, by the `filter` mechanism described under [Pre-filtering which items participate](#pre-filtering-which-items-participate) — no resolver needs a bespoke narrowing argument for this. It also returns a plain array rather than a `Resolution` envelope: a collection's "nothing here" state is unambiguously an empty array, unlike a single value's absence, which needs an explicit flag to distinguish "there is genuinely nothing here" from any value the resolver might otherwise legitimately return. Each resolver may itself be asynchronous, independently of the others. None of the three needs to know anything about the other two; a consumer implementing all three (and, optionally, the delegate handler) is free to have them share underlying data-access logic, but the schema and evaluator never require or assume that they do.

## Evaluator entry points

```ts
function evaluatePredicate(
  node: PredicateNode,
  context: EvaluationContext,
  resolvers: Resolvers,
): Promise<Evaluation<boolean>>;

function evaluateValue(
  node: ExpressionNode,
  context: EvaluationContext,
  resolvers: Resolvers,
): Promise<Evaluation<ComputedValue>>;
```

Both are exported directly, bound to an empty function registry — under them, any [`call`](#call) node is `wrong-type`. The registry a `call` resolves against is fixed at evaluator construction time rather than passed per evaluation (unlike `resolvers`, which are supplied fresh on every call), so supplying one means building a bound pair:

```ts
type FunctionRegistry = Record<
  string,
  (args: readonly ComputedValue[]) => ComputedValue | { domainError: string }
>;

function createEvaluator(options: { functions?: FunctionRegistry }): {
  evaluatePredicate: (node: PredicateNode, context: EvaluationContext, resolvers: Resolvers) => Promise<Evaluation<boolean>>;
  evaluateValue: (node: ExpressionNode, context: EvaluationContext, resolvers: Resolvers) => Promise<Evaluation<ComputedValue>>;
};
```

A registered function signals an argument outside its domain by *returning* `{ domainError: message }` rather than throwing, which is what keeps `call` inside the same three-outcome model as every other node kind (see [The evaluation model](#the-evaluation-model)); only the registry's own keys count as registered names, so a tree naming an inherited `Object.prototype` member is `wrong-type` like any other unregistered name.

```ts
const { evaluateValue } = createEvaluator({
  functions: {
    squareRoot: (args) => {
      const [arg] = args;
      if (arg?.kind !== "number") return { domainError: "squareRoot requires one number argument" };
      if (arg.value < 0) return { domainError: "squareRoot of a negative number is not a real number" };
      return { kind: "number", value: Math.sqrt(arg.value) };
    },
  },
});
```

## Indeterminacy reference

How each reason category can arise, per node kind. "Propagates" means: an indeterminate operand/sub-result, with no other rule overriding it, makes the whole node indeterminate with that same reason (subject to the tie-break rule in [The evaluation model](#the-evaluation-model) when more than one candidate reason is present, and to the absorbing-value exceptions called out explicitly below).

| Node kind | `not-found` | `wrong-type` | `domain-error` |
|---|---|---|---|
| `not` | propagates from operand | propagates from operand | propagates from operand |
| `and` | propagates, **unless** the other operand is definitely `false` (absorbs) | as `not-found` | as `not-found` |
| `or` | propagates, **unless** the other operand is definitely `true` (absorbs) | as `not-found` | as `not-found` |
| `allOf` / `anyOf` | as `and`/`or`, extended pairwise across the list | as `and`/`or` | as `and`/`or` |
| `compare` | either operand not found | operand kinds differ, or units incompatible, or kind is not `number`/`instant`/`duration` | never directly (comparison itself has no domain restriction) |
| `textCompare` | either operand not found | either operand is not `text` | never directly |
| `memberOf` | `operand` not found, or (with no definite match found) a scanned candidate not found | `operand`/a candidate resolves to an incompatible kind or unit, with no definite match found among the rest | never directly |
| `exists` | never — converts operand `not-found` to definite `false` | never — converts operand `wrong-type`/`domain-error` to definite `true` | never — see `wrong-type` column |
| `some` / `every` | an item's `filter` or `item` sub-node reports not-found, and it is not absorbed by an already-decided item | as `not-found` | as `not-found` |
| literals (`numberLiteral`, `textLiteral`, `instantLiteral`, `durationLiteral`) | never | never | never |
| `reference` | resolver reports absence | resolver's value doesn't match an expected `unit`, or is used where an incompatible kind is required upstream | never directly |
| `arithmetic` | either operand not found | operand not numeric (or temporal-kind mismatch — see [Temporal values](#temporal-values)), or unit mismatch on add/subtract | zero divisor, or any other documented domain violation for the operator |
| `negate` | operand not found | operand not `number`/`duration` | never directly |
| `call` | any argument not found | unregistered function name, or an argument of the wrong kind for that function | argument outside the function's valid domain (e.g. negative input to `squareRoot`) |
| `lookup` | any key not found, or resolver reports no match | a key expression resolves to the wrong kind for that table | never directly |
| `conditional` | an unmatched guard's own evaluation is `not-found`, before any earlier guard matched | as `not-found`; also the chosen branch's own result if it is `wrong-type` | as `not-found`; also the chosen branch's own result if it is `domain-error` |
| `fold` | any participating item's `filter`, `item`, or `combine` evaluation is `not-found`; or a `reduce`'s `initial` is `not-found` | any participating item's `filter`, `item`, or `combine` evaluation is `wrong-type`; or a `reduce`'s `initial` is `wrong-type` | empty (post-filter) collection with `max`/`min` (no first item to seed from); or any participating item's `item`/`combine` evaluation is `domain-error`; or a `reduce`'s `initial` is `domain-error` |
| `accumulator` | never | used outside a reduce fold's `combine` expression | never |
| `delegate` | never (no resolution attempted without a handler) | no handler registered for the named `system` | never |

## Worked example

A single condition combining a boolean tree, a comparison leaf whose value side is itself a formula, a fold/aggregation node, and all three resolver contracts in use — every name below is a generic placeholder.

**Rule:** "`isActive` is true, and the sum of `amount` across the `items` collection is greater than `x + y`." `isActive` is modelled as the number `1` for true — the computed-value model has no native boolean kind, so a boolean data point is represented however best suits the consumer, here as a numeric flag compared for equality. The `fold` below is exactly what the [`sum`](#derived-aggregates) builder produces — shown here as the literal tree it assembles, to keep the resolver trace below concrete.

```json
{
  "kind": "and",
  "left": {
    "kind": "compare",
    "op": "eq",
    "left": { "kind": "reference", "key": "isActive" },
    "right": { "kind": "numberLiteral", "value": 1 }
  },
  "right": {
    "kind": "compare",
    "op": "gt",
    "left": {
      "kind": "fold",
      "collection": "items",
      "combiner": {
        "mode": "reduce",
        "initial": { "kind": "numberLiteral", "value": 0 },
        "combine": {
          "kind": "arithmetic",
          "op": "add",
          "left": { "kind": "accumulator" },
          "right": { "kind": "reference", "key": "amount" }
        }
      }
    },
    "right": {
      "kind": "arithmetic",
      "op": "add",
      "left": { "kind": "reference", "key": "x" },
      "right": { "kind": "reference", "key": "y" }
    }
  }
}
```

A minimal set of resolvers backing this against a plain in-memory record:

```ts
const data = {
  isActive: 1,
  x: 10,
  y: 5,
  items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
};

const resolvers: Resolvers = {
  async resolveValue(key, context) {
    const record = context as Record<string, unknown>;
    if (typeof key !== "string" || !(key in record)) return { found: false };
    return { found: true, value: { kind: "number", value: record[key] as number } };
  },
  async resolveLookup() {
    return { found: false }; // unused by this example
  },
  async resolveCollection(collection, context) {
    const record = context as Record<string, unknown>;
    return collection === "items" ? (record.items as unknown[]) : [];
  },
};
```

Tracing the evaluation against `data` as the root `EvaluationContext`:

1. `compare eq` (left branch): `resolveValue("isActive", data)` → `{ found: true, value: { kind: "number", value: 1 } }`; compared against `numberLiteral 1` → definite `true`.
2. `fold` (`reduce`, seeded at `0`): `resolveCollection("items", data)` → three items. The accumulator starts at `0`; for each item in turn, `combine` evaluates `accumulator + reference("amount")` with that single item as context — `resolveValue("amount", item)` → `8`, `12`, `1`, all definite — stepping the accumulator `0 → 8 → 20 → 21`. Final accumulator → `21`.
3. `arithmetic add`: `resolveValue("x", data)` → `10`; `resolveValue("y", data)` → `5`. Sum → `15`.
4. `compare gt` (right branch): `21 > 15` → definite `true`.
5. `and(true, true)` → definite `true`.

Final result: `{ status: "definite", value: true }`.

Two variations show the propagation rules in action without changing the tree at all. If `items` resolved to `[]`, step 2 would be `0` (the `sum`-over-empty identity), step 4 would be `0 > 15 → false`, and step 5 would be `and(true, false) → false` — still fully definite, because `false` absorbs regardless of how step 1 turned out. If instead `x` were missing from `data`, `resolveValue("x", data)` would report `{ found: false }`, making the `arithmetic add` indeterminate (`not-found`), the `compare gt` indeterminate for the same reason, and `and(true, indeterminate)` indeterminate too — `true` is not an absorbing value for AND, so the missing data surfaces all the way to the top-level result rather than being silently swallowed.

## Out of scope

This package is a representation-plus-evaluator for conditions and formulae over already-available (or resolver-obtained) data. It deliberately does not include:

- **Symbolic algebra.** It cannot solve an expression for an unknown quantity, symbolically simplify an expression, or perform symbolic differentiation or integration. A consumer needing any of that is expected to translate the pure-arithmetic portion of an expression tree into the input format of existing, general-purpose symbolic-mathematics software — several mature, freely available options already exist — and let that external system do the symbolic work. This package's job stops at representing and numerically evaluating a tree, not manipulating it symbolically.
- **Complex-number or phasor arithmetic.** Every numeric value in this design is real-valued. Some domains occasionally need calculations naturally expressed with complex numbers; rather than extending the core numeric model to support that — a far larger and more invasive change than adding one more named function — the recommended approach is the same delegation escape hatch described under [`delegate`](#delegate): hand the relevant subtree, unevaluated, to an external system built for that kind of mathematics, several of which already exist as mature, freely available tooling.
- **Batch unresolvable-reference reporting.** This design deliberately has no node kind for asking "which of these references, across a whole batch, are unresolvable" as a single evaluation — only the [`exists`](#exists) leaf's one-at-a-time true/false/false-on-absence check. A tool that wants to report a *list* of every missing reference (for an authoring UI validating a tree before it's saved, say) is expected to build that on top of `exists` — walk the references of interest and evaluate an `exists` leaf over each — at the authoring/tooling layer, rather than this package growing a bespoke aggregate-diagnostic node kind for it. This is a deliberate boundary, not an oversight: it keeps the evaluation tree itself limited to producing one `Evaluation` per node, and leaves "collect many such results and report on them together" to whatever sits above the evaluator, exactly like symbolic algebra and complex-number arithmetic above are left to whatever sits beside it.

This package does not name or depend on any specific external tool for either of the two delegation cases above — it only defines the shape of the hand-off (an opaque payload plus a named destination system).
