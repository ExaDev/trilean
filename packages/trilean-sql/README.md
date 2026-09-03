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

`options.dialect` is `"postgres"`. It is required rather than defaulted so that a second dialect is a new value here, not a change of behaviour for callers who never said which one they meant.

`options.columnFor(referenceKey)` maps a `reference` node's key onto `{ column, paramType? }`. Only string keys reach it — trilean permits any JSON value as a key, and a non-string one is refused before the call. Throwing from `columnFor` is how you reject a key you have no column for; the exception propagates out unchanged rather than being wrapped. It is memoised for the duration of one compilation, so it is called once per distinct key however many times that key appears.

`column` may be qualified with dots (`"members.age"`); each segment is emitted as its own double-quoted identifier. Quoting is unconditional, which is what makes an arbitrary column name safe — an embedded quote is doubled, so a name carrying `"; DROP TABLE ...` becomes one inert identifier that simply does not exist. It also means the name is taken literally rather than case-folded, so return the column's real, case-exact name.

`paramType` declares the column's value kind: `"text"`, `"number"`, `"boolean"`, or `"timestamp"` (trilean's `instant`). It is optional and worth supplying — it does not change the emitted SQL, but it is the only thing that lets the compiler detect the operand-kind mismatches described under [Refusal](#refusal). Without it, a comparison PostgreSQL would coerce into a definite answer where trilean returns `indeterminate` compiles silently.

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

| Node | PostgreSQL |
| --- | --- |
| `and`, `or`, `not` | `AND`, `OR`, `NOT` |
| `allOf`, `anyOf` | n-ary `AND`, `OR`; empty operands become each connective's identity, `TRUE` and `FALSE`, matching the evaluator's own fold |
| `compare` | `>`, `>=`, `<`, `<=`, `=`, `<>` |
| `textCompare` | `=`, `<>`, and `~` / `!~` for `matches` / `notMatches` |
| `memberOf` | `IN` / `NOT IN`, one parameter per candidate |
| `exists` | `IS NOT NULL` |
| `reference` | the mapped column, as a quoted identifier |
| `textLiteral`, `numberLiteral`, `booleanLiteral`, `instantLiteral` | a bind parameter, cast to `text`, `double precision`, `boolean`, `timestamptz` |

Every literal in the tree becomes a parameter. Nothing but structure, operators and quoted identifiers is ever written into the returned `sql`, so a literal's content cannot alter the statement.

Placeholders are always cast. That is not decoration: PostgreSQL rejects `$1 < $2` outright because it cannot determine either parameter's type, and casting each placeholder to the type its own literal kind implies is what makes a fragment's meaning independent of how a particular driver decided to infer an untyped parameter. `timestamptz` rather than `timestamp`, because trilean's `instant` is an ISO-8601 string that may carry an offset and parsing one as a naive timestamp would silently discard it.

An empty `memberOf` candidate list is worth a note, because `IN ()` is a syntax error and the two constants it is tempting to fold to are both wrong. An empty `in` is false and an empty `notIn` is true only once the operand itself is known, and both stay unknown while it is `NULL`. The compiled forms — `(x IS NULL AND NULL::boolean)` and `(x IS NOT NULL OR NULL::boolean)` — reproduce that exactly, which a bare `FALSE`/`TRUE` would not, most visibly under a surrounding `NOT`.

## Refusal

The compiler never degrades. There is no best-effort fragment, no silently dropped conjunct, no approximation that answers differently from the evaluator. Either the whole tree compiles to SQL that agrees with `evaluatePredicate` row for row, or `UnsupportedNodeError` is thrown and the caller evaluates in process instead.

The check is an allow-list walk rather than a deny-list, so a node kind added to trilean after this version was written is refused by default instead of falling through to whatever branch happened to be last.

**Kinds this version does not translate.** `some`, `every`, `fold`: these range over a collection the caller's resolvers supply, which is not the query's row set. `lookup`, `call`, `delegate`, `treeReference`: each is resolved by something the database has no access to — the caller's resolvers, its function registry, an external system. `conditional`: not implemented here. `accumulator`: only meaningful inside a `reduce` fold. `arithmetic` and `negate`: these carry and combine units, and pushing them down would drop that dimensional analysis without saying so. `durationLiteral`: trilean compares durations by normalising both operands to milliseconds, with no column-level equivalent to normalise against. `complexLiteral`: PostgreSQL has no complex type.

**Shapes refused despite a supported kind.** A `reference` whose key is not a string, since there is nothing to map. A `reference` or `numberLiteral` carrying a `unit`: a unit on a reference asserts that the resolved value carries the same one, and a column has no unit for that assertion to be checked against.

**Operand pairings the two engines would answer differently.** These are the reason to declare `paramType`, and they are only detectable where it is declared:

- A `compare` against text. trilean returns `wrong-type` and directs you to `textCompare`; PostgreSQL would order the operand by collation and answer definitely.
- An ordering `compare` (`gt`/`gte`/`lt`/`lte`) against a boolean. trilean has no order for booleans; PostgreSQL orders `false` before `true`.
- A `textCompare` against a non-text operand, which trilean treats as `wrong-type`.
- Any comparison whose operands are of different declared kinds — a number against an instant, say. trilean calls that `wrong-type`; PostgreSQL may coerce one to the other and answer definitely.

Left undeclared, these compile, and the divergence is real but invisible. That is the whole argument for supplying `paramType`.

## Regular expressions

`matches` and `notMatches` compile to PostgreSQL's `~` and `!~`, so the pattern is matched by the server. PostgreSQL's advanced regular expressions and ECMAScript's `RegExp` are close but not the same language: shorthand classes and lookahead exist in both, and much everyday pattern syntax is portable, but they are separate implementations with their own escapes, quantifier subtleties and matching rules. A pattern that relies on ECMAScript-specific behaviour may match differently once pushed down. Keep patterns to portable syntax, or evaluate them in process.

## Tests

The unit suite asserts compiled SQL text and parameter arrays per node kind. It cannot, on its own, establish anything about three-valued behaviour: `("age" > $1)` is only indeterminate-preserving because of what PostgreSQL's planner does with a `NULL` age, which is a fact about PostgreSQL rather than about the string.

So the integration suite (`pnpm test:integration`) starts a real PostgreSQL server in an ephemeral container, seeds a table whose rows carry real `NULL`s, and for every case executes the compiled fragment as a `WHERE` clause *and* evaluates the same tree through trilean's own `evaluatePredicate` once per row, asserting the two agree on which rows match and which do not. Agreement on absence matters as much as on presence: the case that distinguishes three-valued logic from two-valued is the row that appears in neither a predicate nor its negation.

It needs a working Docker daemon.

## Licence

MIT — see [LICENSE](LICENSE).
