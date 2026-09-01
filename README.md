# trilean

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/trilean) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/trilean) [![Release](https://img.shields.io/github/v/release/ExaDev/trilean)](https://github.com/ExaDev/trilean/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/trilean/ci.yml?branch=main)](https://github.com/ExaDev/trilean/actions)

> /ˈtraɪ.li.ən/ (TRY-lee-ən) — rhymes with "boolean".
>
> "Tri-" for [three-valued logic](https://en.wikipedia.org/wiki/Three-valued_logic) — the three possible outcomes of an evaluation (definitely true, definitely false, or indeterminate — see [The evaluation model](#the-evaluation-model)) — "-lean" echoing "boolean" itself, George Boole's own two-valued logic.

A serialisable (JSON) representation of two related tree structures — a **predicate tree** (truth-valued) and an **expression tree** (value-valued) — together with an evaluator for both. The package is deliberately domain-agnostic: the schema layer never assumes anything about where data actually comes from. Every point of contact with a consumer's real data is an injected, opaque resolver function supplied by whoever embeds the package.

Typical use: representing business rules, eligibility conditions, formulas, or validation logic as data (JSON) that can be stored, transmitted, edited by non-developers via a UI, and evaluated identically wherever it lands — a browser, a server, a batch job — without recompiling anything.

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

### A nested filter for a REST API search endpoint

A search endpoint's filter criteria are exactly the kind of thing this package is for: nested boolean logic, stored as JSON, that a client can construct, a non-developer can edit via a UI, and a server evaluates per record without ever hardcoding the filter or redeploying when it changes. There is no query-string DSL to parse and no ORM query-builder to translate into — the request body already is the tree:

```http
POST /orders/search HTTP/1.1
Content-Type: application/json

{
  "filter": {
    "kind": "and",
    "left": {
      "kind": "textCompare",
      "op": "equals",
      "left": { "kind": "reference", "key": "status" },
      "right": { "kind": "textLiteral", "value": "active" }
    },
    "right": {
      "kind": "or",
      "left": {
        "kind": "compare",
        "op": "gt",
        "left": { "kind": "reference", "key": "orderTotal" },
        "right": { "kind": "numberLiteral", "value": 100 }
      },
      "right": {
        "kind": "memberOf",
        "op": "in",
        "operand": { "kind": "reference", "key": "category" },
        "candidates": [
          { "kind": "textLiteral", "value": "electronics" },
          { "kind": "textLiteral", "value": "books" }
        ]
      }
    }
  }
}
```

`status equals "active" AND (orderTotal > 100 OR category is a preferred one)` — two levels of nesting: an `or` inside the right branch of an `and`. The server parses that body's `filter` field as a `PredicateNode` and evaluates it, unmodified, against each candidate order:

```ts
import { evaluatePredicate, type PredicateNode, type Resolvers } from "trilean";

interface Order {
  status: string;
  orderTotal: number;
  category: string;
}

// The parsed `filter` field from the request body above.
const filter: PredicateNode = {
  kind: "and",
  left: {
    kind: "textCompare",
    op: "equals",
    left: { kind: "reference", key: "status" },
    right: { kind: "textLiteral", value: "active" },
  },
  right: {
    kind: "or",
    left: {
      kind: "compare",
      op: "gt",
      left: { kind: "reference", key: "orderTotal" },
      right: { kind: "numberLiteral", value: 100 },
    },
    right: {
      kind: "memberOf",
      op: "in",
      operand: { kind: "reference", key: "category" },
      candidates: [
        { kind: "textLiteral", value: "electronics" },
        { kind: "textLiteral", value: "books" },
      ],
    },
  },
};

const orderResolvers: Resolvers = {
  async resolveValue(key, context) {
    const order = context as Order;
    switch (key) {
      case "status":
        return { found: true, value: { kind: "text", value: order.status } };
      case "orderTotal":
        return { found: true, value: { kind: "number", value: order.orderTotal } };
      case "category":
        return { found: true, value: { kind: "text", value: order.category } };
      default:
        return { found: false };
    }
  },
  async resolveLookup() {
    return { found: false };
  },
  async resolveCollection() {
    return [];
  },
};

const orders: Order[] = [
  { status: "active", orderTotal: 42, category: "electronics" },
  { status: "active", orderTotal: 150, category: "garden" },
  { status: "cancelled", orderTotal: 200, category: "electronics" },
];

const results = await Promise.all(
  orders.map((order) => evaluatePredicate(filter, order, orderResolvers)),
);
const matching = orders.filter((_, i) => results[i]?.status === "definite" && results[i]?.value === true);
// => the first two orders match; the cancelled one doesn't reach the "or" at all, since "and" absorbs on its left operand's definite false
```

See [`and`/`or`](#not-and-or), [`compare`](#compare), [`textCompare`](#textcompare), and [`memberOf`](#memberof) for the full node-kind reference.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the git hooks, the release process, and the constraints an implementation change must preserve.

## Design principles

These hold across every part of the design below, and any implementation change must preserve them:

- **No assumptions about consumer data.** The only places this package touches real data are three named resolver contracts (see [Resolvers](#resolvers)). The schema stores *what to pass* to a resolver, never any resolver logic itself, and never interprets the meaning of an opaque key, table identifier, or collection reference.
- **Three outcomes, never two.** Every evaluation produces a definite result or an indeterminate result carrying a reason — never a bare `boolean`/`number`, and never a thrown exception for a data-quality problem. See [The evaluation model](#the-evaluation-model).
- **Derived constructs are compositions, not new logic.** Anything describable as "some other primitive, wired together" is implemented that way, so its correctness is inherited rather than requiring separate proof. See [Derived connectives](#derived-connectives), [Derived aggregates](#derived-aggregates), [Derived values](#derived-values), and [Defining your own named presets](#defining-your-own-named-presets).
- **One schema, mechanically derived artefacts.** A single canonical type definition produces the runtime validator and the portable wire-format schema; they cannot drift apart because there is only one source. See [Schema strategy](#schema-strategy).
- **A numeric extension that stays closed-form is in scope; a different kind of computation is not.** When something the current numeric model does not cover comes up, the test is whether evaluating it is still closed-form numeric evaluation — no solving, no simplification, no code execution. If it is, it belongs here, however unlike the existing kinds it looks: [Complex values](#complex-values) were once listed under [Out of scope](#out-of-scope) on a sizing judgement that turned out to be wrong, since complex arithmetic is exactly the closed-form evaluation this evaluator already does for every other kind. What stays behind [`delegate`](#delegate) is a genuinely different *kind* of computation — symbolic algebra, arbitrary external computation — not merely a kind of number the model has not reached yet.
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

The generated document carries a version-pinned `$id` — a jsDelivr URL naming the exact published version, e.g. `https://cdn.jsdelivr.net/npm/trilean@1.2.3/schemas/trilean.schema.json` — so a consumer's own rule file can point its `$schema` at a fixed target rather than a moving one. The file's bytes are exactly its RFC 8785 (JSON Canonicalization Scheme) canonical form — keys sorted recursively, no whitespace between tokens, no trailing newline — so `canonicalize(JSON.parse(file)) === file` holds under any JCS implementation, and the same input always produces the same bytes. That makes the file's own SHA-256 re-derivable from its parsed content alone, which is what lets a downloaded copy be checked against this package's SBOM and build-provenance attestations (see the release workflow).

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
  | { kind: "every"; collection: JsonValue; item: PredicateNode; filter?: PredicateNode }
  | { kind: "treeReference"; key: JsonValue };
```

### `not`, `and`, `or`

The three primitives. `not` takes exactly one operand — it is never modelled as a two-operand node with an unused second slot. `and`/`or` each take exactly two named operands (`left`/`right`), evaluated per the truth tables above.

### `allOf`, `anyOf`

The N-ary forms of `and`/`or`: given an ordered list of operands (rather than exactly two), combine all of them with AND, or all of them with OR, respectively. Defined as repeated pairwise application of `and`/`or` — an implementation detail, not a new evaluation rule requiring separate verification. Because resolvers are asynchronous, a reference implementation is free to evaluate every operand concurrently and then apply the absorption rule when combining results, rather than evaluating strictly left-to-right; both strategies produce an identical final `Evaluation` because absorption is a property of the values, not of execution order. The empty-list identity values from [Three-valued propagation rules](#three-valued-propagation-rules) apply: `allOf([])` is definitely `true`; `anyOf([])` is definitely `false`.

### `compare`

A relational-comparison leaf: compares two computed values using `gt`/`gte`/`lt`/`lte`/`eq`/`neq`. **Both `left` and `right` are `ExpressionNode`** — either side may be a plain literal/reference or an arbitrary formula from the expression tree; the comparison is symmetric, and an implementation that only allows a formula on one side is incomplete. Valid operand kinds are `number` (matching units required — see [Units](#units)), `instant`, `duration`, or `boolean`, plus `complex` for `eq`/`neq` only (see [Complex values](#complex-values)); comparing across different computed-value kinds, or comparing two numbers with incompatible units, is `wrong-type`. `boolean` only supports `eq`/`neq` — there is no natural ordering for a truth value, so `gt`/`gte`/`lt`/`lte` are `wrong-type` for a `boolean` operand.

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
  | { kind: "boolean"; value: boolean }
  | { kind: "instant"; value: string }   // ISO-8601 timestamp
  | { kind: "duration"; value: number; unit: DurationUnit }
  | { kind: "complex"; re: number; im: number; unit?: Unit };

type ArithmeticOperator = "add" | "subtract" | "multiply" | "divide" | "power" | "modulo";

type FoldCombiner =
  | { mode: "max"; item: ExpressionNode }
  | { mode: "min"; item: ExpressionNode }
  | { mode: "reduce"; initial: ExpressionNode; combine: ExpressionNode };

type HitPolicy = "first" | "unique";

type ExpressionNode =
  | { kind: "numberLiteral"; value: number; unit?: Unit }
  | { kind: "textLiteral"; value: string }
  | { kind: "booleanLiteral"; value: boolean }
  | { kind: "instantLiteral"; value: string }
  | { kind: "durationLiteral"; value: number; unit: DurationUnit }
  | { kind: "complexLiteral"; re: number; im: number; unit?: Unit }
  | { kind: "reference"; key: JsonValue; unit?: Unit }
  | { kind: "arithmetic"; op: ArithmeticOperator; left: ExpressionNode; right: ExpressionNode }
  | { kind: "negate"; operand: ExpressionNode }
  | { kind: "call"; fn: string; args: ExpressionNode[] }
  | { kind: "lookup"; table: JsonValue; keys: ExpressionNode[] }
  | { kind: "conditional"; hitPolicy?: HitPolicy; cases: { when: PredicateNode; then: ExpressionNode }[]; fallback: ExpressionNode }
  | { kind: "fold"; collection: JsonValue; filter?: PredicateNode; combiner: FoldCombiner }
  | { kind: "accumulator" }
  | { kind: "delegate"; system: string; payload: JsonValue }
  | { kind: "treeReference"; key: JsonValue };
```

A `textLiteral` kind is included even though it is not separately enumerated as its own top-level construct, because `textCompare`'s symmetry requirement (either side may be an arbitrary computed value, per the section above) is meaningless without a way to write a constant string or pattern — matching a field against the fixed text `"active"`, or against a fixed regular expression, needs a text constant on one side. This is a structural consequence of the symmetry already required for text matching, not an added feature.

### Literals

`numberLiteral`, `textLiteral`, `booleanLiteral`, `instantLiteral` (an ISO-8601 timestamp string), `durationLiteral` (a magnitude plus a `DurationUnit`), and `complexLiteral` (a real and an imaginary component, plus an optional `Unit`) are always definite by construction — a literal node never itself produces an indeterminate outcome.

### `reference`

A reference to a single external value, identified by an opaque `key` whose meaning is entirely up to the embedding consumer — the schema never interprets it (see [Resolvers](#resolvers), resolver 1). May optionally carry an expected `unit`, validated against whatever the resolver actually returns for a `number` result; a mismatch (or an expectation of a unit on a non-numeric result) is `wrong-type`. If the resolver reports absence, the result is `not-found`.

### `arithmetic`, `negate`

Binary arithmetic (`add`/`subtract`/`multiply`/`divide`/`power`/`modulo`) and unary negation, each over `number` computed values by default, with the temporal exceptions listed under [Temporal values](#temporal-values) and the complex ones under [Complex values](#complex-values) below. `negate` is an explicit node — never sugar for "zero minus the value" — because it also applies to `duration` values (negating a duration reverses its direction) where "zero minus" has no natural literal-zero counterpart; over a `complex` value it flips both components. Division by zero, or any operator given an operand outside its mathematical domain, is `domain-error`; a non-numeric, non-temporal operand where a number was required is `wrong-type`; any operand that is itself indeterminate makes the whole node indeterminate, with no rescuing value on the other side (see [Three-valued propagation rules](#three-valued-propagation-rules)).

### `call`

A named function applied to an ordered list of `ExpressionNode` arguments. The set of named functions is intentionally open-ended and resolved through a function registry supplied at evaluator construction time — `minimum`, `maximum`, `absoluteValue`, `round`, `squareRoot`, and `logarithm` are starting examples, not an exhaustive list; new functions are added to the registry as concrete need arises. Calling an unregistered function name is `wrong-type` ("no function registered under this name"); calling a registered function with an argument outside its domain (e.g. `squareRoot` given a negative number) is `domain-error`.

### Units

`numberLiteral`, `complexLiteral`, and `reference` may carry a `unit`, represented as a dimensional-exponent map (e.g. `{ m: 1, s: -1 }` for metres per second) rather than an opaque string, so that unit combination follows real dimensional analysis instead of string matching. A bare symbol like `"kg"` is shorthand for `{ kg: 1 }`.

- `add`/`subtract` between two unit-tagged numbers require **identical** dimensional-exponent maps. A mismatch is `wrong-type` ("incompatible units") — units are never silently coerced or dropped.
- `multiply`/`divide` combine the two operands' unit maps by dimensional analysis: multiplying adds exponents per dimension, dividing subtracts them. An operand with no `unit` is treated as dimensionless (an empty map) for this purpose.

### Temporal values

`instant` (a point in time) and `duration` are computed-value kinds distinct from `number`, even though a duration ultimately carries a numeric magnitude — an instant is never treated as "a number that happens to represent a date". The only well-defined cross-kind arithmetic is:

- `instant − instant → duration`
- `instant + duration → instant` (and `duration + instant → instant`)

Any other arithmetic combination touching an `instant` or `duration` (adding two instants, multiplying a duration by an instant, comparing an instant against a plain number, and so on) is `wrong-type`. A reference implementation normalises `duration` values to a single base unit (milliseconds) internally before combining two durations of different `DurationUnit`s, then reports the result in whichever unit the node's own context calls for.

### Complex values

`complex` is a computed-value kind alongside `number`, for the domains — signal processing, control theory, anything phasor-shaped — where a formula naturally mixes real and complex terms in one expression. It stays inside this evaluator rather than behind [`delegate`](#delegate) because it is closed-form numeric evaluation, exactly what every other kind here already does; see [Design principles](#design-principles) for that scope test in general.

**One canonical representation, rectangular.** A `complex` value is stored as `{ re, im }` and never as a magnitude and a phase, and there is deliberately no `form` discriminant offering both. Three reasons, in order of weight:

1. **A second form would make equality ambiguous.** Polar coordinates do not encode a value uniquely — phase is only defined modulo a full turn, and a zero-magnitude value has no meaningful phase at all — so the same complex number would have unboundedly many polar encodings. `eq` and `memberOf` are exact equality throughout this design (see [`compare`](#compare)); making them work across two forms would mean either normalising on every comparison or introducing an approximate equality for this one kind, and neither belongs in a design where every other kind compares exactly.
2. **A discriminant would double the branching in every operator** — quadruple it for a binary one — for a choice that changes no value. Every operator would still convert to rectangular internally, because that is where the closed forms live, so the discriminant would buy nothing at evaluation time and cost at every boundary.
3. **Rectangular is what the operators actually need.** `add`/`subtract` are component-wise in it; `multiply`, `divide`, `negate`, and integer `power` all have standard closed forms in it. Polar's advantage — multiplication and division as one product of magnitudes and one sum of angles — does not extend to addition at all, which would have to convert back and forth.

The magnitude-and-phase view stays reachable through four exported conversion helpers rather than a second encoding: `complexFromPolar(magnitude, phase, unit?)` and `complexLiteralFromPolar(magnitude, phase, unit?)` build a value or a literal node from polar terms, and `complexMagnitude(value)` and `complexPhase(value)` read them back out — the magnitude as a real number in the value's own unit, the phase as a dimensionless real number of radians. Conversions at the edges, one representation in the middle.

**Arithmetic.**

- `add`/`subtract` are component-wise, requiring **identical** dimensional-exponent maps exactly as real numbers do (see [Units](#units)).
- `multiply`/`divide` are real complex multiplication and division — `(a + bi)(c + di) = (ac − bd) + (ad + bc)i`, and the corresponding quotient — never component-wise. Units combine by the same dimensional analysis real numbers use. A zero divisor means both components zero; a divisor with only a zero real part divides perfectly well.
- `power` is defined for a **real integer exponent** and evaluated as the repeated multiplication that integer exponentiation is, with a negative exponent the reciprocal of the positive one. Like a real `power`, it requires dimensionless operands. An arbitrary complex exponent is a genuinely bigger question — it needs the complex logarithm, which is multivalued, so it needs a branch-cut convention this design has not chosen — and is deliberately out of scope for now: it is `wrong-type`, as is a non-integer real exponent, on the same reading of that code used throughout ("an answer exists, but this operator does not accept this operand" — compare `power`'s existing dimensionless-operands requirement, also `wrong-type`).
- `modulo` is `domain-error`, not `wrong-type`: a remainder needs a canonical notion of how many whole divisors fit, and the complex plane has no ordering to supply one. There is no answer to accept, which is the same category as division by zero.

**A real operand is promoted, never rejected.** Mixing a `number` with a `complex` in one `arithmetic` node works: every real number *is* a complex number with a zero imaginary part, so the promotion is exact, total, and canonical — unlike the temporal cross-kind combinations above, which had to be enumerated one by one precisely because no such embedding exists between an `instant` and a `duration`. Scaling a complex value by a real one, or offsetting it by a real constant, is the common case, and forcing every real literal in such a formula to be rewritten as a complex one would defeat the point. The result is `complex` whenever either operand is, even when the imaginary part comes out zero: a node's result kind follows its operand kinds, never the values that happen to flow through it.

**Comparison is kind-strict, deliberately unlike arithmetic.** `gt`/`gte`/`lt`/`lte` are `wrong-type` for a `complex` operand — the complex plane carries no total order — exactly as they already are for `text`. `eq`/`neq` work normally, as exact equality across both components under the same unit-compatibility rule numbers already have, and `memberOf` matches the same way. But a `complex` compared against a `number` is `wrong-type`, with no promotion: arithmetic *produces* a value, so promoting a real operand loses nothing, whereas a comparison *consumes* two, and this design already treats a kind difference between them as a modelling error worth surfacing — the same reason an `instant` is never compared against a plain `number` despite being a count of milliseconds underneath.

Ordering a complex quantity therefore goes through whichever real projection the formula actually means — most often its magnitude. This package ships no built-in function set (see [`call`](#call)), so that bridge is an ordinary registry entry, one line over the exported helper:

```ts
const functions: FunctionRegistry = {
  magnitude: (args) =>
    args[0]?.kind === "complex"
      ? complexMagnitude(args[0])
      : { domainError: "expected a complex argument" },
};
```

which a tree then calls like any other function, putting a real number back on the left of an ordinary `compare`:

```json
{
  "kind": "compare",
  "op": "gt",
  "left": { "kind": "call", "fn": "magnitude", "args": [{ "kind": "reference", "key": "x" }] },
  "right": { "kind": "numberLiteral", "value": 13 }
}
```

### `lookup`

Resolves a single value from a named external table-like source, keyed by one or more `ExpressionNode` keys, via resolver 2 (see [Resolvers](#resolvers)). The schema never interprets what "table" or "key" mean to a given consumer; `table` and the resolved key values are passed through verbatim. If any key expression is itself indeterminate, the lookup is indeterminate with that reason (no key evaluation, no lookup attempt). If the resolver reports no match, the result is `not-found`.

### `conditional`

A piecewise/conditional-value node: an ordered, possibly-empty list of `{ when, then }` cases plus a required `fallback`. An optional `hitPolicy` field (`"first"` or `"unique"`) decides how cases are read; absent is treated as `"first"` — the exact, unchanged behaviour of every tree serialised before this field existed, not a masked-bug fallback.

**`hitPolicy: "first"`** (the default). Evaluates to the `then` of the first case whose `when` predicate is definitely `true`; if no case matches, evaluates to `fallback`. If evaluating a `when` predicate produces an indeterminate outcome **before any earlier case has matched**, the whole `conditional` node's own result is that same indeterminate outcome (reason preserved) — evaluation does not skip past an unknown guard to try the next one, because doing so could silently pick a later branch that only looks correct because an earlier one couldn't actually be checked.

**`hitPolicy: "unique"`** asserts that at most one case is expected to match, and treats two or more matches as a data error rather than silently taking the first. Every case's `when` is evaluated concurrently (there is no "earlier case" to short-circuit on), then resolved in this order:

1. **Two or more cases are definitely `true`** — `domain-error` ("more than one case matched under the 'unique' hit policy"), regardless of any other case's own indeterminacy. This mirrors `memberOf`/`some`/`every`'s existing absorption: a confirmed outcome (here, "there is a genuine ambiguity") cannot be undone by an unrelated case's data problem.
2. Otherwise, **any case's `when` is indeterminate** — the whole node is indeterminate with that reason (first such candidate, in declared case order, per [The evaluation model](#the-evaluation-model)'s tie-break rule). This is deliberately **not** absorbed by a single already-confirmed match, unlike step 1 above and unlike `memberOf`/`some`/`every`'s own absorption: an unresolved case might still turn out to be a second match, so "exactly one match so far" cannot be trusted as final until every other case is known to not also match.
3. Otherwise, **exactly one case is definitely `true`** — evaluate and return that case's `then`. No other case's `then` is ever evaluated.
4. Otherwise (zero matches, and nothing indeterminate) — evaluate and return `fallback`, exactly as `"first"` already does.

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

`count` takes an optional third argument, `probe`, and this is where it matters that `filter` and a probe are not the same thing. `filter` *excludes* an item from participating — a filtered-out item's absence is invisible in the final result, exactly as if it had never been in the collection at all. A `probe` does the opposite: it doesn't decide whether an item participates, it makes the *whole count* indeterminate if it fails to resolve for *any* participating item, surfacing "I cannot give you a trustworthy count" rather than silently reporting a smaller, technically-successful count for the same underlying data-quality problem — precisely the distinction the rest of this document's indeterminate-outcome model exists to preserve (see [The evaluation model](#the-evaluation-model)). `count(collection, filter)` with no `probe` is a plain `reduce` seeded at `0` that adds `1` per participating item, with no indeterminacy of its own beyond `filter`'s. `count(collection, filter, probe)` instead adds `presenceOf(probe)` per participating item — a small helper built entirely from already-established primitives, with no restriction on `probe`'s kind: it tests `probe` for membership in the single-element list `[probe]`, so a `memberOf` "in" test against itself is trivially true whenever `probe` resolves to a definite value of *any* kind (`memberOf`'s equality is already kind-agnostic across `number`/`text`/`boolean`/`instant`/`duration` — see [`memberOf`](#memberof)), and exactly `probe`'s own indeterminate outcome otherwise, per `memberOf`'s own "evaluate `operand` first" rule. A `conditional` then turns that boolean into the number `1`; its `fallback` is never reached, since a definite `probe` always equals itself. (A real implementation may memoise `probe`'s single evaluation rather than running the resolver twice for `operand` and its one `candidates` entry — resolvers are pure functions of their inputs throughout this design, so this is a performance choice, not a correctness one.)

`average` is `sum` divided by `count` over the same `collection`/`filter`, with no `probe` — `sum`'s own `item` already forces every participating item's projected value to resolve, so `average`'s numerator is already indeterminate under exactly the condition a `count` probe exists to detect, with nothing left to duplicate. Nothing new to verify for the empty-collection case either: division's own already-established rule (zero divisor is `domain-error`) is *why* `average` over an empty collection is `domain-error`, since `count` over an empty collection is `0` and `sum(...)/0` already means exactly that.

### Derived values

`coalesce` is never its own evaluated node kind — it is a builder function that assembles an ordinary `conditional`, the same treatment [Derived connectives](#derived-connectives) and [Derived aggregates](#derived-aggregates) already give `xor`/`nand`/`nor`/`implies`/`iff`/`none`/`sum`/`count`/`average`: correctness is inherited from the mechanism it's built from, rather than needing its own independent implementation that could silently drift from it.

```ts
const coalesce = (
  first: ExpressionNode,
  second: ExpressionNode,
  ...rest: ExpressionNode[]
): ExpressionNode =>
  [first, second, ...rest].reduceRight(
    (fallback, candidate): ExpressionNode => ({
      kind: "conditional",
      cases: [{ when: { kind: "exists", operand: candidate }, then: candidate }],
      fallback,
    }),
  );
```

Built right-to-left over the full candidate list via `reduceRight`, needing no seed value: `first`/`second` are required arguments (rather than accepting a single `ExpressionNode[]`), which guarantees the list always has at least two elements, so the no-initial-value overload of `reduceRight` never hits an empty array.

**Worked correctness check.** `coalesce`'s only interesting behaviour — whether a given candidate is skipped past or propagated — reduces entirely to what its single `exists` probe reports, per [`exists`](#exists)'s and [`conditional`](#conditional)'s own already-established rules:

| A candidate's own evaluation | `exists(candidate)` | The `conditional` case | `coalesce` evaluates to |
|---|---|---|---|
| A definite value | definite `true` | matches | The candidate's value (re-evaluated as `then`, same result) |
| Indeterminate, `not-found` | definite `false` | does not match | The next candidate (the enclosing `fallback`), evaluated fresh |
| Indeterminate, `wrong-type` | definite `true` | matches | The candidate's own `wrong-type` result (re-evaluated as `then`) |
| Indeterminate, `domain-error` | definite `true` | matches | The candidate's own `domain-error` result (re-evaluated as `then`) |

Falling through to the next candidate therefore happens only on `exists`'s own `false` — a genuinely absent value (`not-found`) — never on a candidate that resolved to something merely unusable (`wrong-type`/`domain-error`): `exists` already draws exactly that line, and `coalesce` inherits it unmodified rather than re-deciding it. This is the one behaviour a naive reimplementation is likely to get backwards (treating *any* indeterminate candidate as "try the next one"), so it is worth stating explicitly rather than leaving it to be inferred from the composition alone.

A real implementation may memoise a candidate's single evaluation rather than running its resolver twice — once for the `exists` probe, once again for `then` — exactly the same performance caveat [Derived aggregates](#derived-aggregates)'s `presenceOf` already documents for its own `memberOf` probe; resolvers are pure functions of their inputs throughout this design, so this is a performance choice, not a correctness one.

### Defining your own named presets

This is exactly the same composition-not-new-logic treatment already given to `xor`/`sum`/`coalesce` above — nothing stops application code from defining its own named builder functions the same way, for whatever domain-specific composed queries come up repeatedly in a given consumer's own rules.

```ts
/** isRecentlyActive(30) reads as "the item's lastActiveAt instant is within the last 30 days" — a small, named composition over compare/arithmetic, exactly the same "assembles ordinary nodes" treatment sum/coalesce already get above. Built as `now + (-days)` rather than `now - days`: per "Temporal values" above, `instant - duration` is not a defined cross-kind combination, only `instant + duration` is, so negating the duration first is how this reaches the same "days ago" instant using only defined operators. */
const isRecentlyActive = (days: number): PredicateNode => ({
  kind: "compare",
  op: "gt",
  left: { kind: "reference", key: "lastActiveAt" },
  right: {
    kind: "arithmetic",
    op: "add",
    left: { kind: "reference", key: "now" },
    right: { kind: "negate", operand: { kind: "durationLiteral", value: days, unit: "d" } },
  },
});
```

A UI surfacing these to an end user treats each one as a named preset in a node-picker — a label ("Recently active") plus whatever parameters the builder function takes (`days`) — and splices the expanded tree in at the point the user picked it, exactly as if they'd hand-built that subtree themselves; nothing about the resulting PredicateNode/ExpressionNode distinguishes a preset-sourced subtree from a manually-authored one.

This is the "bake in at authoring time" half of the picture: a preset's own definition lives in application code, expanded once, at the moment a user picks it, into an ordinary static subtree. [`treeReference`](#treereference) is the complementary half — a *live*, centrally-editable reference, resolved fresh on every evaluation rather than expanded once at authoring time. Choosing between them is exactly the choice between "this composition is fixed application logic" (a named preset, this section) and "this composition is itself data someone should be able to edit without a deploy" (a treeReference).

### `delegate`

An explicitly-named external system plus an arbitrary, unevaluated JSON payload, standing in for the whole node without this package attempting to evaluate it itself — see [Out of scope](#out-of-scope). Evaluating a `delegate` node is not part of this package's own evaluation semantics. The reference evaluator accepts an optional delegate handler per external system name; if none is registered for the named `system`, evaluating the node is indeterminate (`wrong-type`, "no delegate handler registered for external system '<name>'"). Consumers who want a `delegate` node to actually resolve are expected either to register a handler, or to pre-process the tree — walk it, find delegation nodes, invoke the named external system out of band, and substitute the result as a literal — before the tree ever reaches this package's evaluator.

### `treeReference`

A reference to a whole other tree, identified by an opaque `key` (see [Resolvers](#resolvers)) — the only node kind valid from *both* a `PredicateNode` and an `ExpressionNode` position: the exact same schema is appended as the last member of each of the two discriminated unions above, not two separately-declared copies that happen to look alike. Unlike [`delegate`](#delegate), which hands the whole node off to an *external* system this package never evaluates, `treeReference` resolves to *another tree of this same schema* and evaluates it with this same evaluator — a sub-rule reference, not an escape hatch.

`resolveTree` is optional on `Resolvers`, for the same reason `resolveDelegate` is: a well-defined indeterminate result on absence, not a masked bug, and an additive, non-breaking interface change for every consumer implemented before this node kind existed. If no `resolveTree` is registered, evaluating a `treeReference` node is `wrong-type` ("no tree resolver registered for treeReference nodes"). If the resolver reports no match, the result is `not-found`.

A resolved tree is never merely trusted — it is re-validated with a fresh `PredicateNodeSchema`/`ExpressionNodeSchema` parse (`PredicateNodeSchema` from a predicate-position reference, `ExpressionNodeSchema` from an expression-position one) before evaluation proceeds, exactly the same discipline the top-level tree itself is subject to when it first arrives at this package. A resolver fetching "a named rule from storage" is very often surfacing the same non-developer-authored JSON the top-level tree already is, with no static guarantee it still matches the schema; a failed parse is `wrong-type`.

`context` and the enclosing fold's `accumulator` both pass through a `treeReference` unchanged — the referenced tree shares the caller's evaluation scope, like a subroutine call, not a nested evaluation with its own fresh context. There is deliberately no mechanism to override the context at a `treeReference` boundary; a consumer wanting that already has [`delegate`](#delegate).

**Cycle and depth protection.** A tree that references itself, directly or through a longer chain, is guarded by two independent, layered checks rather than one: a cycle detector tracks every `key` (by its `JSON.stringify`'d form) already on the current reference chain, and reports `domain-error` ("circular treeReference detected") the moment a repeat is seen; a fixed depth cap separately reports `domain-error` ("...exceeds the maximum depth") on a long *acyclic* chain the cycle detector alone would never catch. Neither check is a substitute for the other.

**A known, accepted design consequence.** `resolveTree` has no built-in way to know whether a given `key` is being resolved from a predicate-position or an expression-position reference — the same is already true of `reference.key` and `lookup.table`, neither of which carries a type discriminator either. A consumer needing to disambiguate structures their own key accordingly (e.g. `{ kind: "predicate", id: "..." }` as the `JsonValue` itself) rather than this schema growing a bespoke field for it.

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

Three core, required points of extension, plus two further independent optional ones, each supplied separately by the embedding consumer, each treated by the schema as pure data to hand over — never as resolver logic living inside the schema itself:

```ts
type Resolution =
  | { found: true; value: ComputedValue }
  | { found: false };

type TreeResolution =
  | { found: true; node: JsonValue }
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

  /** Optional, separate from the three core contracts — see the `treeReference` node kind. */
  resolveTree?(key: JsonValue, context: EvaluationContext): Promise<TreeResolution>;
}
```

`resolveCollection` takes no narrowing parameter of its own: it always returns the full candidate list for the given reference, and narrowing which of those candidates actually take part is handled uniformly, after resolution, by the `filter` mechanism described under [Pre-filtering which items participate](#pre-filtering-which-items-participate) — no resolver needs a bespoke narrowing argument for this. It also returns a plain array rather than a `Resolution` envelope: a collection's "nothing here" state is unambiguously an empty array, unlike a single value's absence, which needs an explicit flag to distinguish "there is genuinely nothing here" from any value the resolver might otherwise legitimately return. Each resolver may itself be asynchronous, independently of the others. None of the three core resolvers needs to know anything about the other two, or about either optional one; a consumer implementing all five is free to have them share underlying data-access logic, but the schema and evaluator never require or assume that they do.

`resolveTree` returns a `TreeResolution`, deliberately shaped like `Resolution` but distinct from it: `node` carries opaque JSON — the referenced tree, re-validated by the evaluator rather than trusted (see [`treeReference`](#treereference)) — where `Resolution`'s `value` carries an already-typed `ComputedValue`. It is otherwise the same "found" envelope for the same reason: a `treeReference`'s absence needs to be distinguishable from any tree the resolver might otherwise legitimately return, exactly as a `reference`'s absence needs to be distinguishable from any value. `resolveDelegate` and `resolveTree` solve different problems and are never a substitute for one another: `resolveDelegate` hands a payload to an *external* system this package never evaluates; `resolveTree` hands back *more of this same schema*, for this same evaluator to keep evaluating.

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
| `compare` | either operand not found | operand kinds differ, or units incompatible, or kind is not `number`/`instant`/`duration`/`complex`, or an ordering operator was given a `complex` operand (see [Complex values](#complex-values)) | never directly (comparison itself has no domain restriction) |
| `textCompare` | either operand not found | either operand is not `text` | never directly |
| `memberOf` | `operand` not found, or (with no definite match found) a scanned candidate not found | `operand`/a candidate resolves to an incompatible kind or unit, with no definite match found among the rest | never directly |
| `exists` | never — converts operand `not-found` to definite `false` | never — converts operand `wrong-type`/`domain-error` to definite `true` | never — see `wrong-type` column |
| `some` / `every` | an item's `filter` or `item` sub-node reports not-found, and it is not absorbed by an already-decided item | as `not-found` | as `not-found` |
| literals (`numberLiteral`, `textLiteral`, `instantLiteral`, `durationLiteral`, `complexLiteral`) | never | never | never |
| `reference` | resolver reports absence | resolver's value doesn't match an expected `unit`, or is used where an incompatible kind is required upstream | never directly |
| `arithmetic` | either operand not found | operand not numeric (or temporal-kind mismatch — see [Temporal values](#temporal-values)), or unit mismatch on add/subtract, or a `power` exponent that is not a real integer over a `complex` operand (see [Complex values](#complex-values)) | zero divisor, `modulo` over a `complex` operand, or any other documented domain violation for the operator |
| `negate` | operand not found | operand not `number`/`duration`/`complex` | never directly |
| `call` | any argument not found | unregistered function name, or an argument of the wrong kind for that function | argument outside the function's valid domain (e.g. negative input to `squareRoot`) |
| `lookup` | any key not found, or resolver reports no match | a key expression resolves to the wrong kind for that table | never directly |
| `conditional` | `"first"`: an unmatched guard's own evaluation is `not-found`, before any earlier guard matched.<br>`"unique"`: any case's `when` is `not-found`, unless 2+ cases already definitely matched (see `domain-error`, which then takes priority).<br>Both: also the chosen branch's (`then`/`fallback`) own result if it is `not-found`. | Same pattern as `not-found`, substituting `wrong-type` throughout (guard evaluation and chosen branch alike). | `"unique"` only: 2+ cases are definitely `true` — see [`conditional`](#conditional)'s absorption order.<br>Both: same pattern as `not-found`, substituting `domain-error` (guard evaluation and chosen branch alike). |
| `fold` | any participating item's `filter`, `item`, or `combine` evaluation is `not-found`; or a `reduce`'s `initial` is `not-found` | any participating item's `filter`, `item`, or `combine` evaluation is `wrong-type`; or a `reduce`'s `initial` is `wrong-type` | empty (post-filter) collection with `max`/`min` (no first item to seed from); or any participating item's `item`/`combine` evaluation is `domain-error`; or a `reduce`'s `initial` is `domain-error` |
| `accumulator` | never | used outside a reduce fold's `combine` expression | never |
| `delegate` | never (no resolution attempted without a handler) | no handler registered for the named `system` | never |
| `treeReference` | resolver reports no match | no `resolveTree` registered; or the resolved node fails schema validation | a circular reference is detected; or the reference chain exceeds the maximum depth |

## Worked example

A single condition combining a boolean tree, a comparison leaf whose value side is itself a formula, a fold/aggregation node, and all three resolver contracts in use — every name below is a generic placeholder.

**Rule:** "`isActive` is true, and the sum of `amount` across the `items` collection is greater than `x + y`." `isActive` is a `boolean` computed value, compared for equality against the literal `true`. The `fold` below is exactly what the [`sum`](#derived-aggregates) builder produces — shown here as the literal tree it assembles, to keep the resolver trace below concrete.

```json
{
  "kind": "and",
  "left": {
    "kind": "compare",
    "op": "eq",
    "left": { "kind": "reference", "key": "isActive" },
    "right": { "kind": "booleanLiteral", "value": true }
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
  isActive: true,
  x: 10,
  y: 5,
  items: [{ amount: 8 }, { amount: 12 }, { amount: 1 }],
};

const resolvers: Resolvers = {
  async resolveValue(key, context) {
    const record = context as Record<string, unknown>;
    if (typeof key !== "string" || !(key in record)) return { found: false };
    const value = record[key];
    if (typeof value === "boolean") return { found: true, value: { kind: "boolean", value } };
    return { found: true, value: { kind: "number", value: value as number } };
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

1. `compare eq` (left branch): `resolveValue("isActive", data)` → `{ found: true, value: { kind: "boolean", value: true } }`; compared against `booleanLiteral true` → definite `true`.
2. `fold` (`reduce`, seeded at `0`): `resolveCollection("items", data)` → three items. The accumulator starts at `0`; for each item in turn, `combine` evaluates `accumulator + reference("amount")` with that single item as context — `resolveValue("amount", item)` → `8`, `12`, `1`, all definite — stepping the accumulator `0 → 8 → 20 → 21`. Final accumulator → `21`.
3. `arithmetic add`: `resolveValue("x", data)` → `10`; `resolveValue("y", data)` → `5`. Sum → `15`.
4. `compare gt` (right branch): `21 > 15` → definite `true`.
5. `and(true, true)` → definite `true`.

Final result: `{ status: "definite", value: true }`.

Two variations show the propagation rules in action without changing the tree at all. If `items` resolved to `[]`, step 2 would be `0` (the `sum`-over-empty identity), step 4 would be `0 > 15 → false`, and step 5 would be `and(true, false) → false` — still fully definite, because `false` absorbs regardless of how step 1 turned out. If instead `x` were missing from `data`, `resolveValue("x", data)` would report `{ found: false }`, making the `arithmetic add` indeterminate (`not-found`), the `compare gt` indeterminate for the same reason, and `and(true, indeterminate)` indeterminate too — `true` is not an absorbing value for AND, so the missing data surfaces all the way to the top-level result rather than being silently swallowed.

## Out of scope

This package is a representation-plus-evaluator for conditions and formulas over already-available (or resolver-obtained) data. It deliberately does not include:

- **Symbolic algebra.** It cannot solve an expression for an unknown quantity, symbolically simplify an expression, or perform symbolic differentiation or integration. A consumer needing any of that is expected to translate the pure-arithmetic portion of an expression tree into the input format of existing, general-purpose symbolic-mathematics software — several mature, freely available options already exist — and let that external system do the symbolic work. This package's job stops at representing and numerically evaluating a tree, not manipulating it symbolically.
- **Batch unresolvable-reference reporting.** This design deliberately has no node kind for asking "which of these references, across a whole batch, are unresolvable" as a single evaluation — only the [`exists`](#exists) leaf's one-at-a-time true/false/false-on-absence check. A tool that wants to report a *list* of every missing reference (for an authoring UI validating a tree before it's saved, say) is expected to build that on top of `exists` — walk the references of interest and evaluate an `exists` leaf over each — at the authoring/tooling layer, rather than this package growing a bespoke aggregate-diagnostic node kind for it. This is a deliberate boundary, not an oversight: it keeps the evaluation tree itself limited to producing one `Evaluation` per node, and leaves "collect many such results and report on them together" to whatever sits above the evaluator, exactly like symbolic algebra above is left to whatever sits beside it.

This package does not name or depend on any specific external tool for the delegation case above — it only defines the shape of the hand-off (an opaque payload plus a named destination system).

Complex-number and phasor arithmetic used to be listed here too, delegated out on the reasoning that supporting them would be a far larger and more invasive change than adding one more named function. That sizing was wrong: unlike symbolic algebra, which is a genuinely different kind of system, complex arithmetic is closed-form numeric evaluation, exactly what this evaluator already does for every other computed-value kind. It is now part of the core numeric model — see [Complex values](#complex-values), and [Design principles](#design-principles) for the scope test that judgement is now written down as.

## Prior art

Twenty-three existing tools — JSON rule engines, expression languages, query-filter conventions, and three-valued-logic precedents — researched against seven properties trilean combines: a genuinely portable representation, injected async data access, a real three-outcome logic, vendor-agnostic scope, mixing logic and arithmetic in one tree, no code-execution surface for an untrusted author, and a formally published schema. None of the twenty-three combine all seven. Each verdict below was checked against the tool's own documentation, specification, or a security advisory, not assumed from category.

The closest structural relative is [GoRules' Zen Engine](https://gorules.io) (`@gorules/zen-engine`), whose JDM format is a genuinely portable JSON decision graph with a real injected extension point — but its outcome model is value-level nulls, not a propagating three-valued logic, and its "Function" node type runs real JavaScript rather than staying within a bounded grammar. The closest semantic relative is [DMN](https://www.omg.org/spec/DMN)'s FEEL expression language, which implements the identical absorbing-AND/OR three-valued truth tables trilean does — but FEEL's canonical form is XML, not JSON.

Worth knowing: a Rust crate on crates.io is also named [`trilean`](https://crates.io/crates/trilean) and also implements Kleene's three-valued logic — a genuine name collision, different ecosystem, no npm conflict, unrelated project.

The security research here surfaced findings worth knowing independent of the comparison: [JSONata](https://jsonata.org) has had multiple prototype-pollution CVEs reaching `Function`/`child_process`; [jexl](https://github.com/TomFrost/Jexl) has a documented, unfixed path to `Function.prototype` via `__proto__`; [expr-eval](https://github.com/silentmatt/expr-eval) has a prototype-pollution CVE (CVE-2026-12866); and MongoDB's `$where`/`$function` and JsonLogic's `method` operator are documented, acknowledged arbitrary-code escape hatches. [CEL](https://cel.dev), [filtrex](https://github.com/cshaa/filtrex), and [Rego](https://www.openpolicyagent.org/docs/policy-language) are the standouts, each explicitly designed and marketed as safe for untrusted input.

| Tool | Category | Portable data | Async access | Missing ≠ false | Vendor-agnostic | Mixes logic & math | No code-exec risk | Published schema |
|---|---|---|---|---|---|---|---|---|
| [trilean](https://www.npmjs.com/package/trilean) | — | 🟢<br>JSON, Zod-validated, RFC 8785 canonical | 🟢<br>three typed resolver contracts | 🟢<br>definite/indeterminate, typed reason | 🟢<br>no assumptions about consumer data | 🟢<br>compare/textCompare/memberOf take formulas | 🟢<br>call's fn is a registry key, never code | 🟢<br>one Zod schema generates both |
| [JsonLogic](https://www.npmjs.com/package/json-logic-js) | Rule engine | 🟢 | 🔴<br>direct path lookup | 🔴<br>counts as false | 🟢 | 🟢<br>any operand can be another rule | 🟡<br>`method` op is an acknowledged escape hatch | 🔴<br>a JSON Schema request was never resolved |
| [json-rules-engine](https://www.npmjs.com/package/json-rules-engine) | Rule engine | 🟢 | 🟢<br>async fact handlers | 🔴<br>undocumented | 🟢 | 🔴<br>docs call inline formulas "a design smell" | 🟢<br>operators are name-based registry lookups | 🔴<br>a proposed schema was never merged |
| [json-rules-engine-simplified](https://www.npmjs.com/package/json-rules-engine-simplified) | Rule engine | 🟢 | 🔴<br>direct path lookup | 🔴<br>falls through to false | 🟢 | 🔴<br>no arithmetic/formula node exists | 🟢<br>no `eval()`, by the project's own claim | 🔴<br>README prose only |
| [Zen Engine](https://www.npmjs.com/package/@gorules/zen-engine) / [JDM](https://docs.gorules.io/developers/jdm/standard) | Rule engine | 🟢 | 🟢<br>injected custom-node callback | 🟡<br>null-coalescing only | 🟢 | 🟢<br>ZEN expressions nest arithmetic in comparisons | 🟡<br>Function nodes run real JS, sandboxed | 🟡<br>docs claim one, none found published |
| [nools](https://www.npmjs.com/package/nools) | Rule engine | 🔴<br>JS/DSL | 🔴 | 🔴 | 🟢 | 🟢<br>DSL nests arithmetic in comparisons | 🔴<br>the `then` block is literal JS | 🔴<br>DSL documented only in prose |
| [rools](https://www.npmjs.com/package/rools) | Rule engine | 🔴<br>rules are JS | 🔴 | 🔴 | 🟢 | 🟢<br>but only because it's unrestricted JS | 🔴<br>"rules are specified in pure JavaScript" | 🔴<br>plain JS, prose docs only |
| [node-rules](https://www.npmjs.com/package/node-rules) | Rule engine | 🔴<br>conditions are JS | 🔴 | 🔴 | 🟢 | 🟢<br>but only because it's unrestricted JS | 🔴<br>a condition is explicitly "a function" | 🔴<br>prose docs only |
| [JSONata](https://www.npmjs.com/package/jsonata) | Expression lang. | 🟡<br>undocumented shape | 🟢 | — | 🟢 | 🟢<br>arithmetic on both sides of any comparison | 🔴<br>multiple prototype-pollution CVEs to RCE | 🔴<br>hand-written parser, a grammar request was declined |
| [CEL](https://cel.dev) | Expression lang. | 🟢<br>as Protobuf, not JSON | 🔴<br>sync by design | — | 🟢 | 🟢<br>arithmetic feeds directly into comparison | 🟢<br>explicitly designed safe for untrusted code | 🟢<br>versioned .proto files, wire-compatible forever |
| [jexl](https://www.npmjs.com/package/jexl) | Expression lang. | 🔴<br>private, unexposed | 🟢<br>closest match | — | 🟢 | 🟢<br>arithmetic and logical ops nest freely | 🔴<br>documented unfixed `__proto__` access issue | 🔴<br>grammar lives in a JS source file |
| [filtrex](https://www.npmjs.com/package/filtrex) | Expression lang. | 🔴<br>AST retained | 🔴<br>sandboxed sync closure | — | 🟢 | 🟢<br>documented example nests a product in a condition | 🟢<br>markets itself explicitly as safe for end-users | 🔴<br>a real grammar file exists but ships unpublished |
| [expr-eval](https://www.npmjs.com/package/expr-eval) | Expression lang. | 🔴<br>(jsep-based siblings do) | 🔴 | — | 🟢 | 🟢<br>and/or plus comparisons alongside arithmetic | 🔴<br>CVE-2026-12866, prototype pollution to RCE | 🔴<br>prose README only |
| [mathjs](https://www.npmjs.com/package/mathjs) | Expression lang. | 🔴<br>round-trip unreliable | 🔴<br>sync `evaluate()` | — | 🟢 | 🟢<br>arithmetic binds tighter than and/or, by design | 🟡<br>`eval` removed, but real sandbox-escape CVEs existed | 🔴<br>documented only in prose |
| [MongoDB query operators](https://www.mongodb.com/docs/manual/reference/operator/query/) | Query/filter DSL | 🟢 | — | — | 🔴<br>MQL only | 🟡<br>only behind the `$expr` escape hatch | 🟡<br>`$where`/`$function` run arbitrary server-side JS | 🟡<br>an official grammar exists but is archived since 2021 |
| [Prisma `where`](https://www.prisma.io/docs/orm/prisma-client/queries/filtering-and-sorting) | Query/filter DSL | 🔴<br>never transmitted | — | — | 🔴<br>per-schema generated | 🔴<br>computed fields aren't usable for filtering at all | 🟢<br>a fixed, enumerated operator set only | 🔴<br>generated internal TypeScript types only |
| [OData `$filter`](https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part2-url-conventions.html) | Query/filter DSL | 🟢<br>as a query string | — | — | 🟢<br>OASIS standard | 🟢<br>arithmetic operators combine directly with comparisons | 🟢<br>fixed operator set, no code-reference mechanism | 🟢<br>a normative, versioned ABNF grammar document |
| [JSON:API `filter`](https://jsonapi.org/format/#fetching-filtering) | Query/filter DSL | 🔴<br>reservation only | — | — | 🟡<br>no grammar defined | — | — | — |
| [GraphQL (Hasura-style)](https://hasura.io/docs/2.0/queries/postgres/filters/boolean-operators/) | Query/filter DSL | 🟢 | — | — | 🟡<br>de facto convention | 🟡<br>operand can be a column, never a computed formula | 🟢<br>fixed comparison-operator vocabulary | 🟡<br>real schema, but generated per deployment |
| [SQL `NULL` / `UNKNOWN`](https://www.postgresql.org/docs/current/functions-comparison.html) | 3VL precedent | 🔴<br>language semantic | — | 🟢<br>same absorbing tables | 🟢 | 🟢<br>WHERE-clause operands are arbitrary expressions | — | — |
| [DMN's FEEL](https://www.omg.org/spec/DMN) | 3VL precedent | 🟢<br>as XML, not JSON | — | 🟢<br>absorbing | 🟢<br>OMG standard | 🟢<br>full FEEL mixes arithmetic and and/or freely | 🟡<br>a boxed function can invoke external Java/PMML by name | 🟡<br>DMN XML has an XSD, FEEL itself is prose BNF |
| [OPA / Rego](https://www.openpolicyagent.org/docs/policy-language) | 3VL precedent | 🟢<br>, as source text | — | 🟡<br>absence, not a value | 🟢 | 🟢<br>comparisons take arithmetic sub-expressions | 🟢<br>explicitly not Turing-complete, by design | 🔴<br>grammar is prose EBNF, no standalone file |
| [AWS IAM policy language](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_grammar.html) | 3VL precedent | 🟢 | — | 🟡<br>default, not propagating | 🔴<br>AWS-specific | 🔴<br>every condition value is a literal string | 🟢<br>bounded grammar, fixed operator set | 🔴<br>only a prose BNF-like description |
| [`trinary`](https://pypi.org/project/trinary/), [`tvl`](https://github.com/archanpatkar/tvl), [`3vl`](https://www.npmjs.com/package/3vl), Go [`ternary`](https://github.com/mithrandie/ternary) | 3VL precedent | 🔴<br>in-memory only | — | 🟢<br>Kleene K3 | 🟢 | — | — | — |
