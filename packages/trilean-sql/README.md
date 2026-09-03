# trilean-sql

Compiles a [trilean](https://www.npmjs.com/package/trilean) predicate tree into a parameterised SQL `WHERE` fragment, so a rule stored as data can be evaluated by the database over a whole table instead of in process, one subject at a time.

```sh
pnpm add trilean-sql
```

`trilean` is a peer concern rather than an implementation detail: this package takes its `PredicateNode` type as input and declares it as a dependency, so the tree you compile is the same tree you evaluate.

## The idea

trilean evaluates a predicate to `definite(true)`, `definite(false)`, or `indeterminate` — the third value meaning the tree could not be judged, usually because a reference resolved to nothing. Given a table of subjects and a rule to apply to all of them, the obvious approach is to fetch every row and evaluate the tree once per row. That reads the whole table to discard most of it.

The alternative is to let the database apply the rule. It already has a three-valued logic: `TRUE`, `FALSE`, and `NULL` meaning unknown, with `AND`, `OR` and `NOT` following Kleene's strong tables — the same tables trilean's own connectives implement — and a comparison against `NULL` yielding `NULL` rather than a verdict. A `WHERE` clause keeps only the rows whose condition came out `TRUE`, so a row whose condition was unknown is dropped exactly as a subject the evaluator declines to judge is not accepted.

So the third value is not reimplemented on top of SQL. It is the same third value, and the compiler's job is to translate the tree faithfully enough that it stays that way.

```ts
import { compilePredicateNode } from "trilean-sql";
import type { PredicateNode } from "trilean";

const rule: PredicateNode = {
  kind: "allOf",
  operands: [
    {
      kind: "compare",
      op: "gte",
      left: { kind: "reference", key: "age" },
      right: { kind: "numberLiteral", value: 18 },
    },
    {
      kind: "textCompare",
      op: "matches",
      left: { kind: "reference", key: "email" },
      right: { kind: "textLiteral", value: "@example[.]com$" },
    },
  ],
};

const columns = {
  age: { column: "age", paramType: "number" },
  email: { column: "email", paramType: "text" },
} as const;

const { sql, params } = compilePredicateNode(rule, {
  dialect: "postgres",
  columnFor: (key) => {
    const binding = columns[key as keyof typeof columns];
    if (binding === undefined) throw new Error(`no column for ${key}`);
    return binding;
  },
});

// sql:    (("age" >= $1::double precision) AND ("email" ~ $2::text))
// params: [18, "@example[.]com$"]
await client.query(`SELECT id FROM members WHERE ${sql}`, params);
```

The fragment is a self-contained boolean expression with no `WHERE` keyword of its own, so it also drops into a `HAVING`, a `CHECK`, or a partial index predicate.

## API

### `compilePredicateNode(node, options)`

Returns `{ sql, params }`. Throws rather than approximating; see [Refusal](#refusal).

`options.dialect` is `"postgres"` or `"sqlite"`. It is required rather than defaulted so that a caller states the engine it is compiling for, instead of inheriting whichever one this package happened to implement first. See [Dialects](#dialects) for what differs between them; the tree, the refusals, and the three-valued guarantee do not.

`options.columnFor(referenceKey)` maps a `reference` node's key onto `{ column, paramType? }`. Only string keys reach it — trilean permits any JSON value as a key, and a non-string one is refused before the call. Throwing from `columnFor` is how you reject a key you have no column for; the exception propagates out unchanged rather than being wrapped. It is memoised for the duration of one compilation, so it is called once per distinct key however many times that key appears.

`column` may be qualified with dots (`"members.age"`); each segment is emitted as its own double-quoted identifier. Quoting is unconditional, which is what makes an arbitrary column name safe — an embedded quote is doubled, so a name carrying `"; DROP TABLE ...` becomes one inert identifier that simply does not exist. It also means the name is taken literally rather than case-folded, so return the column's real, case-exact name.

`paramType` declares the column's value kind: `"text"`, `"number"`, `"boolean"`, or `"timestamp"` (trilean's `instant`). It is optional and worth supplying — it does not change the emitted SQL, but it is the only thing that lets the compiler detect the operand-kind mismatches described under [Refusal](#refusal). Without it, a comparison the database would coerce into a definite answer where trilean returns `indeterminate` compiles silently.

### `findUnpushableNodeKind(node, options?)`

Returns `{ kind, path, reason }` for the first node the compiler will not translate, or `undefined` if the whole tree is pushable. `compilePredicateNode` runs it first and throws on any result, so call it yourself only to *choose* between pushdown and in-process evaluation without provoking an exception:

```ts
const blocker = findUnpushableNodeKind(rule, options);
const rows = blocker
  ? await evaluateEveryRowInProcess(rule)
  : await queryWith(compilePredicateNode(rule, options));
```

Passing `options` widens the check: without them the walk is purely structural; with them it also applies the operand-kind rules that depend on each column's declared `paramType`.

### Errors

`UnsupportedNodeError` (carrying `nodeKind`, `path`, `reason`) and `InvalidColumnError` (carrying `referenceKey`, `column`), both extending `TrileanSqlError`.

## What compiles

| Node | PostgreSQL | SQLite |
| --- | --- | --- |
| `and`, `or`, `not` | `AND`, `OR`, `NOT` | same |
| `allOf`, `anyOf` | n-ary `AND`, `OR`; empty operands become each connective's identity, `TRUE` and `FALSE`, matching the evaluator's own fold | same |
| `compare` | `>`, `>=`, `<`, `<=`, `=`, `<>` | same |
| `textCompare` | `=`, `<>`, and `~` / `!~` for `matches` / `notMatches` | `=`, `<>`, and `REGEXP` / `NOT REGEXP` |
| `memberOf` | `IN` / `NOT IN`, one parameter per candidate | same |
| `exists` | `IS NOT NULL` | same |
| `reference` | the mapped column, as a quoted identifier | same |
| `textLiteral`, `numberLiteral`, `booleanLiteral`, `instantLiteral` | a bind parameter, cast to `text`, `double precision`, `boolean`, `timestamptz` | a bare `?`, uncast |

Every literal in the tree becomes a parameter. Nothing but structure, operators and quoted identifiers is ever written into the returned `sql`, so a literal's content cannot alter the statement. Identifier quoting is the same in both: each dot-separated segment double-quoted with any embedded quote doubled, which is ANSI-standard and not a per-dialect rule.

PostgreSQL placeholders are always cast. That is not decoration: PostgreSQL rejects `$1 < $2` outright because it cannot determine either parameter's type, and casting each placeholder to the type its own literal kind implies is what makes a fragment's meaning independent of how a particular driver decided to infer an untyped parameter. `timestamptz` rather than `timestamp`, because trilean's `instant` is an ISO-8601 string that may carry an offset and parsing one as a naive timestamp would silently discard it. SQLite placeholders carry neither a number nor a cast, because there is nothing to write: parameters bind by the order they appear, and there is no type to annotate. It answers a comparison between two bare `?` from the bound values themselves.

An empty `memberOf` candidate list is worth a note, because `IN ()` is a syntax error and the two constants it is tempting to fold to are both wrong. An empty `in` is false and an empty `notIn` is true only once the operand itself is known, and both stay unknown while it is `NULL`. The compiled forms — `(x IS NULL AND NULL::boolean)` and `(x IS NOT NULL OR NULL::boolean)`, and the same two without the cast under SQLite, which has no boolean type to annotate — reproduce that exactly, which a bare `FALSE`/`TRUE` would not, most visibly under a surrounding `NOT`.

## Dialects

The dialects differ in three places, and nowhere else. `matches`/`notMatches` compile to each engine's own regular-expression operator; placeholders are `$N::type` under PostgreSQL and a bare `?` under SQLite; and the bare `NULL` in an empty `memberOf` carries a `::boolean` annotation only where there is a boolean type to annotate. Everything else the compiler emits — the connectives, the six comparison operators, `=`/`<>`, `IN`/`NOT IN`, `IS NOT NULL`, quoted identifiers — is ANSI-standard and identical.

```ts
const { sql, params } = compilePredicateNode(rule, { dialect: "sqlite", columnFor });
// sql:    (("age" >= ?) AND ("email" REGEXP ?))
// params: [18, "@example[.]com$"]
```

What compiles, what is refused, and the row-for-row agreement with `evaluatePredicate` are the same in both. The refusals in particular are not PostgreSQL caution carried over untested: SQLite's type affinity produces the same silent definite answers where trilean returns `wrong-type`, and `test/integration/sqlite.test.ts` measures each one against a real connection. A `TEXT`-affinity column compared to the number `5` is compared *as text*, so `'9' > 5` is true there while `'10' > 5` is not; a boolean is an integer, so `gt` on one answers by integer ordering; and `'abc' > 5`, with no column involved at all, answers `true` rather than erroring.

Two things a SQLite caller has to supply that a PostgreSQL caller does not, both of which fail loudly rather than silently:

- **A `REGEXP` function**, if the tree uses `matches` or `notMatches`. See [Regular expressions](#regular-expressions).
- **Booleans bound as `0`/`1`.** SQLite has no boolean type, and drivers do not agree on whether a JS boolean is bindable at all — better-sqlite3 rejects one outright (*"SQLite3 can only bind numbers, strings, bigints, buffers, and null"*). `params` carries the tree's own literals unchanged in every dialect, so converting them is the binding caller's job: `params.map((v) => (typeof v === "boolean" ? Number(v) : v))`.

A dialect this version does not implement is refused by name, from `compilePredicateNode` and `findUnpushableNodeKind` alike, with `UnknownDialectError`. `SqlDialect` is a closed union so TypeScript source cannot reach that, but a dialect read from configuration and asserted into the union at the boundary can, and reporting such a tree as pushable would promise a compilation that cannot happen.

Instants are the one place to be deliberate rather than merely careful. SQLite has no timestamp type either, so an `instantLiteral` is compared as text against whatever text the column holds. Offset-bearing ISO-8601 in a single common offset (`2020-01-01T00:00:00Z`) sorts chronologically as a string and compares correctly; mixed offsets, or a format that is not ISO-8601, do not. This is the SQLite counterpart of the PostgreSQL session-time-zone caveat under [Refusal](#refusal), and the same advice resolves both.

## Refusal

The compiler never degrades. There is no best-effort fragment, no silently dropped conjunct, no approximation that answers differently from the evaluator. Either the whole tree compiles to SQL that agrees with `evaluatePredicate` row for row, or `UnsupportedNodeError` is thrown and the caller evaluates in process instead.

The check is an allow-list walk rather than a deny-list, so a node kind added to trilean after this version was written is refused by default instead of falling through to whatever branch happened to be last.

That guarantee is about the tree's structure, and it has two limits, both about the *content* of a string operand rather than any node's kind, and neither reachable by a walk over kinds. A `matches`/`notMatches` pattern is matched by the server in PostgreSQL's own regular-expression language, not ECMAScript's — see [Regular expressions](#regular-expressions), which is where the row-for-row claim actually stops. An `instantLiteral` is parsed by PostgreSQL rather than by `Date`, so one carrying no UTC offset is read in the *database session's* time zone where trilean reads it in the Node process's, and one PostgreSQL cannot parse at all raises a query error at execution time rather than this exception (trilean answers `indeterminate` for the same string). Pass instants as offset-bearing ISO-8601, which both read identically.

Every refusal below applies to both dialects. What changes with the dialect is the `reason` text, which names the mechanism that actually applies to the engine you are compiling for — a `findUnpushableNodeKind` call given no `options` has no dialect to read and describes PostgreSQL, the one these refusals were first derived against.

**Kinds this version does not translate.** `some`, `every`, `fold`: these range over a collection the caller's resolvers supply, which is not the query's row set. `lookup`, `call`, `delegate`, `treeReference`: each is resolved by something the database has no access to — the caller's resolvers, its function registry, an external system. `conditional`: not implemented here. `accumulator`: only meaningful inside a `reduce` fold. `arithmetic` and `negate`: these carry and combine units, and pushing them down would drop that dimensional analysis without saying so. `durationLiteral`: trilean compares durations by normalising both operands to milliseconds, with no column-level equivalent to normalise against. `complexLiteral`: neither engine has a complex type.

**Shapes refused despite a supported kind.** A `reference` whose key is not a string, since there is nothing to map. A `reference` or `numberLiteral` carrying a `unit`: a unit on a reference asserts that the resolved value carries the same one, and a column has no unit for that assertion to be checked against. A `numberLiteral` of `NaN`, which trilean compares with `===` — under which NaN equals nothing including itself — and neither engine reproduces, for opposite reasons. PostgreSQL defines NaN as equal to itself and greater than every other double, so `NaN = NaN` selects every row there and none here. SQLite has no NaN at all and a driver binding one substitutes SQL `NULL`, so the same comparison is *indeterminate* there and matches nothing — which looks like agreement until you negate it, at which point trilean's definite `true` matches every row and SQLite's `NULL` still matches none. Infinities are not refused alongside it; every engine here orders them identically.

**Operand pairings the engines would answer differently.** These are the reason to declare `paramType`, and they are only detectable where it is declared:

- A `compare` against text. trilean returns `wrong-type` and directs you to `textCompare`. PostgreSQL orders the operand by collation and answers definitely; SQLite applies the text operand's own affinity to the other side and compares lexicographically, which is worse rather than better — `'9' > 5` is true and `'10' > 5` is not.
- An ordering `compare` (`gt`/`gte`/`lt`/`lte`) against a boolean. trilean has no order for booleans; PostgreSQL orders `false` before `true`, and SQLite orders the integers 0 and 1 it stores them as.
- A `textCompare` against a non-text operand, which trilean treats as `wrong-type`.
- Any comparison whose operands are of different declared kinds — a number against an instant, say. trilean calls that `wrong-type`; both engines may coerce one to the other and answer definitely.

Left undeclared, these compile, and the divergence is real but invisible. That is the whole argument for supplying `paramType`.

## Regular expressions

Under PostgreSQL, `matches` and `notMatches` compile to `~` and `!~`, so the pattern is matched by the server. PostgreSQL's advanced regular expressions and ECMAScript's `RegExp` are close but not the same language: shorthand classes and lookahead exist in both, and much everyday pattern syntax is portable, but they are separate implementations with their own escapes, quantifier subtleties and matching rules. A pattern that relies on ECMAScript-specific behaviour may match differently once pushed down. Keep patterns to portable syntax, or evaluate them in process.

Under SQLite there is no built-in regular-expression support at all. `REGEXP` is reserved syntax for a `regexp(pattern, value)` function the connection has to register itself — `X REGEXP Y` is exactly `regexp(Y, X)`, pattern first — and the dialect emits `REGEXP` / `NOT REGEXP` for the same two operators. An unregistered one is a query error, `no such function: REGEXP`, rather than a fragment that quietly matches nothing, so this is a documented environment requirement in the same class as the caveats above and not a hole in the compile-time guarantee. The upside is that the pattern is then matched by your own `RegExp`, so the ECMAScript-versus-server-dialect divergence above does not arise.

With better-sqlite3:

```ts
db.function("regexp", (pattern, text) =>
  typeof pattern !== "string" || typeof text !== "string"
    ? null
    : new RegExp(pattern).test(text)
      ? 1
      : 0,
);
```

Both details are load-bearing rather than stylistic. Returning `null` for a NULL argument is what keeps the third value intact: SQLite does not propagate NULL through a user function on its own, so one answering `0` for a NULL value would make `NOT REGEXP` answer `TRUE` for a row whose value is unknown — the two-valued collapse this package exists to avoid. Returning `1`/`0` rather than a JS boolean is what better-sqlite3 accepts; a boolean is rejected from a user function (*"returned an invalid value"*) for the same reason it is rejected as a bound parameter.

## Tests

The unit suite asserts compiled SQL text and parameter arrays per node kind. It cannot, on its own, establish anything about three-valued behaviour: `("age" > $1)` is only indeterminate-preserving because of what PostgreSQL's planner does with a `NULL` age, which is a fact about PostgreSQL rather than about the string.

So the integration suite (`pnpm test:integration`) runs the same fixture against a real engine, once per implementation: PostgreSQL in an ephemeral container, PGlite in process, and SQLite in memory through better-sqlite3. Each seeds a table whose rows carry real `NULL`s, and for every case executes the compiled fragment as a `WHERE` clause *and* evaluates the same tree through trilean's own `evaluatePredicate` once per row, asserting the two agree on which rows match and which do not. Agreement on absence matters as much as on presence: the case that distinguishes three-valued logic from two-valued is the row that appears in neither a predicate nor its negation.

`postgres.test.ts` uses a real PostgreSQL server started as an ephemeral container, and needs a working Docker daemon. `pglite.test.ts` uses [PGlite](https://pglite.dev), which is PostgreSQL itself compiled to WebAssembly and run in process rather than a reimplementation of it, and needs nothing beyond Node — so the parity claim above is measurable on any machine, Docker or not, and PGlite is a verified target of the `postgres` dialect rather than an assumed one. `sqlite.test.ts` likewise needs nothing beyond Node, and also measures the divergences the guard's refusals exist to prevent — the NaN-to-NULL binding substitution, the lexicographic text comparison, the integer boolean ordering — rather than only asserting that each refusal fires, since inheriting PostgreSQL's refusal set would be worth nothing if SQLite happened to agree with trilean where PostgreSQL does not.

## Licence

MIT — see [LICENSE](LICENSE).
