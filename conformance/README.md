# Conformance corpus

Language-neutral cases that pin the behaviour of the trilean packages. Every implementation of a package (the TypeScript source, the native Rust crates and the wasm builds) runs the same cases, so a port is correct when it passes what the original passes.

## Layout

```
conformance/
  README.md                  this file
  case.schema.json           JSON Schema of a corpus file
  manifest.json              what the corpus holds
  manifest.schema.json       JSON Schema of the manifest
  <package>/<area>/<name>.json
  fixtures/                  data the runners test themselves with
```

The files are UTF-8 (a loader refuses a file that is not, rather than reading replacement characters) and canonical JSON, which the repository's lint requires: keys sorted, two-space indent, one element per line. Running `pnpm lint` rewrites a file into that form, so the examples below show the fields in reading order and the files do not.

### Which files are corpus files

Every loader applies this one rule, and each runs it over `fixtures/loader-selection` (a tree and the files it must select and the entries it must refuse) so the loaders cannot disagree:

- A name that starts with a dot is ignored, at any depth.
- A directory called `fixtures`, `schema` or `runner` is skipped, at any depth, directly under the root included. It holds data cases refer to or the runners themselves, never cases.
- A name is lower-case ASCII letters, digits, dots, hyphens and underscores, and starts with a letter or digit, so every loader orders names the same way. The root's own files are the exception. A name that is not is a failure.
- A corpus file is a `.json` file at `<package>/<area>/<name>.json`. The area names the case kind it holds (or, for the regex cases in another dialect, the dialect), and a file takes its name from the test file it was extracted from (`parse/parser.json` from `parser.unit.test.ts`).
- The root holds only `README.md`, `case.schema.json`, `manifest.json` and `manifest.schema.json` as files.
- Files and problems are listed in UTF-16 code unit order, directory by directory.
- Anything else, a stray file, a file of another type, a file or directory at another depth, is a failure in every loader, never ignored by one.

### The manifest

`manifest.json` records, for every corpus file, its case count and the ids of the cases carrying `skip`, in ascending order. Every runner checks the corpus against it and fails on any difference. A runner also counts, for its own implementation, the cases it executes and the cases it skips, and asserts that the sum is the manifest's total and that every case it skips because it is marked is marked in the manifest. A case that skips the other implementation is one it executes. A TypeScript runner belongs to one package and executes that package's directory (`trilean/` or `trilean-regex/`), so it counts against the manifest's entries for that directory; the checks of the corpus as a whole (schema, ids, manifest) cover every file. The TypeScript runner counts the cases it registers when it collects them, so the check holds whatever the run does with the registered tests (a name filter, a bail, a retry, a shuffled order). The Rust loader executes no case yet: it skips the cases marked `skip: rust` because they are marked, every other case because no native executor exists, and makes the same assertions; execution moves cases from the second kind of skip to executed and cannot lose one.

## Cases

Every case has:

- `id`: unique across the whole corpus, in lower-case ASCII letters, digits, dots, hyphens and underscores.
- `from`: either `<test file>.test.ts: <describe> > <test>`, the original test title the case came from, so a failure points back to the behaviour it pinned, or `recorded: <package> <source file> (<what>)` for a recorded case. The schema and every loader refuse a `from` in neither form. Where the original asserted less than the case records, `from` says so.
- `kind`: selects the shape below.
- `skip`, optional, with a `reason` that says why: the implementation that does not run the case, `ts` for a case the TypeScript implementation skips and `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust engine is `rust` wherever it runs (native, Node, a browser or Workers). A case one implementation cannot run in any build carries it; nothing else does. A number JSON cannot write, an infinity or a NaN, is no reason to skip: it is written as `{ "$number": "Infinity" }` (below) and runs in every implementation. A `reason` without `skip` is refused.
- `tolerance`, optional: `{ "ulps": n }`, units in the last place, or `{ "absolute": x }`, a distance, never both. Numbers compare exactly (`-0` included) unless a case gives one. A case that gives one carries the tolerance its original test used: the same digits of `toBeCloseTo`, the same bound on a difference, with the number the original compared against (computed independently of the implementation, or a literal) as the expectation. The implementation's own exact digits appear only in the generated files.

A case comes from an existing test, with the same inputs and the same expectation, and an expectation is never weaker than the original's. The exception is a recorded case: one written for the corpus because no test covered the behaviour, whose expectation is what the TypeScript implementation does today. Its `from` starts `recorded:` and names the source file the behaviour comes from (`recorded: trilean-regex src/parser.ts (...)`), so a reader can tell a pinned original from a recorded behaviour, and a loader checks the form. A recorded behaviour that is a defect is fixed and its case changed together, never left pinned.

### Text

Every pattern, input and message fragment is a sequence of UTF-16 code units, and every `index` counts UTF-16 code units, which is what the TypeScript implementation and the patterns' AST (`codeUnit`) are in. A string field takes either form:

- a JSON string, which must be well-formed Unicode (no unpaired surrogate escape), so every loader can read it; or
- `{ "codeUnits": [<0..65535>, ...] }`, for content a JSON string cannot carry, an unpaired surrogate.

A loader reads both into the same code unit sequence; `fixtures/text-forms/pairs.json` lists texts with their code units, and every loader checks they agree. A loader that cannot decode a string into code units, or that reads one in scalar values or bytes, is wrong: `😀` is two literals, and `index` after it counts two.

`case.schema.json` is the format, including the kinds later packages use. A loader accepts no document the schema rejects, and accepts every document the schema accepts for the kinds it validates in full, except one that breaks a rule the Text and Rules sections add beside the schema (an unpaired surrogate in a JSON string, invalid UTF-8); it refuses any other kind rather than passing it unchecked. A corpus file holds at least one case.

### Rules the schema cannot express

Each loader enforces these beside the schema:

- A character class range's `from` is not above its `to`.
- A `repeat`'s `min` is not above its `max`.
- A case id is not used twice, within a file or across files.
- A manifest's `skip` lists are in ascending order, without repeats.
- The corpus matches the manifest.

Integers are at most 2^53-1, the largest the JavaScript runners hold exactly, and an integer written `97.0` is the integer 97, as in JSON Schema.

Every rule above has a negative fixture, and every negative fixture has a repaired twin of the same name that differs by that one defect and is valid, so a fixture cannot stay rejected for another reason: each loader asserts both. A rule about one file has a file in `fixtures/invalid-cases` (twin in `fixtures/repaired-cases`); a rule about the manifest has a file in `fixtures/manifests/invalid` (twin in `fixtures/manifests/repaired`); a rule across files, or between the corpus and its manifest, has a whole corpus root in `fixtures/corpora/invalid` (twin in `fixtures/corpora/repaired`), loaded the way the real corpus is. `fixtures/valid-cases` and `fixtures/manifests/valid` hold files every loader must accept, the bounds of every number among them. A file a loader cannot parse counts as rejected, which is how a loader meets an unpaired surrogate escape. Every real corpus file must be accepted by all of them. A rule added to the format gets a fixture and its twin in the same commit.

### trilean-regex

`regex-parse`:

```json
{ "id": "...", "from": "...", "kind": "regex-parse", "pattern": "a{2,}", "expect": { "ast": { "kind": "repeat", "operand": { "kind": "literal", "codeUnit": 97 }, "min": 2 } } }
```

`expect` is one of:

- `{ "ast": <node> }`: the parsed tree equals the node. Field names are those of the package's AST. An unbounded `repeat` omits `max`, since JSON has no `undefined`.
- `{ "astSubset": <partial node> }`: for a test that asserted only some fields of the tree. It names at least one key. An object matches when every key it gives matches; an array matches element by element and has the same length; any other value must be equal.
- `{ "error": { "index"?, "message"? } }` (at least one of the two): the pattern is refused with a parse error. `index` is an offset in UTF-16 code units into the pattern. `message` is a list of texts (fragments) that must all occur in the reason text, in order, each after the end of the one before. The reason text is the part of the error that says why the pattern was refused, in the error's own wording: not the index, not the echoed pattern and not the position marker, so an implementation exposes its reason separately from the rest of its message. Each field is given only where the original test asserted it, and an original assertion written as a regular expression is recorded as the literal fragments it requires, in order (`/anchor.*cannot be quantified/` is `["anchor", "cannot be quantified"]`). A test that asserted only that the pattern is refused is recorded with the index the current implementation reports, and its `from` says so.

`regex-match`:

```json
{ "id": "...", "from": "...", "kind": "regex-match", "pattern": "^a$", "inputs": [ { "input": "a", "matches": true } ] }
```

Each input is tested against the pattern, through every entry point the implementation offers for testing a pattern (compiled once and reused, and compiled per call), and all of them must give `matches`.

The corpus pins answers, never time. A test that bounds how long a pattern takes stays in the implementation's own tests, next to the case that pins its answer, and a port keeps its own time-bound test.

### trilean

Where a case compares a result with an expectation, numbers are equal when they are the same double (`-0` is not `0`) or, when the case gives a `tolerance`, within it; an object member whose value the implementation leaves undefined is absent; every other value must be equal structurally.

`validate`:

```json
{ "id": "...", "from": "...", "kind": "validate", "schema": "NotNodeSchema", "input": { "kind": "not" }, "expect": { "ok": false, "issues": [] } }
```

`schema` is the export name of a schema of the package (`NotNodeSchema`, `PredicateNodeSchema`, `ComputedValueSchema`), so an implementation with no object of that name still names the same type. `expect` is `{ "ok": true }` with an optional `value`, the parsed value, which must be equal to it, or `{ "ok": false, "issues": [...] }`. Every listed issue must be among those reported, each with the same `path` (strings and integers) and, where it gives a `message`, a reported message that contains it. An empty list asserts only the refusal, which is what a test that asserted only `success === false` is recorded as.

`call`:

```json
{ "id": "...", "from": "...", "kind": "call", "function": "round", "args": [ { "kind": "number", "value": 2.5 } ], "expect": { "kind": "number", "value": 3 } }
```

`function` is the name of a built-in function and `args` its arguments, as computed values. `expect` is the computed value the function returns, `{ "domainError": true }` for a result that reports an argument outside the function's domain, or `{ "wrongType": true }` for one that reports an argument it cannot accept; either failure may give `messageIncludes`, fragments the failure's message contains in order. A computed value is compared by the rules above, so `-0` is not `0`. A number the canonical form cannot hold is written `{ "$number": "-0" }`, `"Infinity"`, `"-Infinity"` or `"NaN"` wherever a case has a number or a value (arguments, trees, contexts, resolver answers and expectations): a negative zero because the canonical form writes it as `0`, and the others because JSON has no such number. Every implementation reads the four forms as the numbers they name, so a case that has one runs in all of them and carries no `skip`.

`build`:

```json
{ "id": "...", "from": "...", "kind": "build", "builder": "xor", "args": [ { ... }, { ... } ], "expect": { ... } }
```

`builder` is the name of a function of the package that builds a tree (`not`, `and`, `or`, `xor`, `nand`, `nor`, `implies`, `iff`, `none`, `sum`, `average`, `count`, `presenceOf`, `coalesce`, `prefixPattern`, `wildcardPattern`, `hierarchicalGlobPattern`), `args` its arguments in order (trees, a collection reference, a string; `null` for an argument left out) and `expect` the tree it returns, compared by the rules above. A case that only pins the tree a test went on to evaluate is recorded, and says so in `from`.

`inputs`:

```json
{ "id": "...", "from": "...", "kind": "inputs", "raw": { "a": 1 }, "expect": { "ok": true, "inputs": { "a": { "kind": "number", "value": 1 } }, "collections": {} } }
```

`raw` is parsed as the inputs of a document. `expect` is `{ "ok": true, "inputs": ..., "collections": ... }`, the named values and the lists of items (each item an object of named values) as JSON objects, whose order of members is not compared, or `{ "ok": false, "issues": [...] }`, the issue texts in order.

`document`:

```json
{ "id": "...", "from": "...", "kind": "document", "tree": { ... }, "inputs": { ... }, "as": "predicate", "maxNodes": 100, "expect": { "outcome": "evaluated", "treeKind": "expression", "evaluation": { ... } } }
```

The document is evaluated with the package's built-in functions. `expect` is the whole outcome, compared by the rules above. `expectSubset` is given instead where the original asserted only some of it: it names at least one key, and an object matches when every key it gives matches, an array matches element by element at the same length, and any other value must be equal (numbers by the case's `tolerance`).

`cli`:

```json
{ "id": "...", "from": "...", "kind": "cli", "args": ["evaluate", "tree.json"], "files": { "tree.json": "{...}" }, "stdin": "...", "expect": { "exit": 0, "stdoutJson": { ... } } }
```

The command is run with `args` against an in-memory set of files, `files` (name to text, which a parser reads as written, so `1e999` is an infinite number) and `stdin`, which the path `-` reads; a path that is in neither cannot be read. `expect` gives the exit status and, where the original asserted it, `stdout` or `stderr` as exact text, `stdoutJson`, the JSON the command printed, compared by the rules above, `stdoutJsonSubset`, the same for an original that asserted only some fields (it names at least one key; an object matches when every key it gives matches, an array matches element by element at the same length, any other value must be equal), `stdoutExcludes`, fragments standard output does not contain, `stderrIncludes`, fragments standard error contains in order, `stderrStartsWith` and `stdoutStartsWith`.

`evaluate`:

```json
{ "id": "...", "from": "...", "kind": "evaluate", "as": "predicate", "tree": { ... }, "context": { ... }, "resolvers": { ... }, "expect": { "status": "definite", "value": true } }
```

`tree` is a predicate or an expression (`as` says which) and is evaluated against `context` (a JSON value). A case without `context` gives the evaluator no context at all, which is not the same as a context of `null`: a resolver entry whose `context` is `null` matches only a call made under a `null` context, and an entry without `context` matches any, a missing one included. `expect` is `{ "status": "definite", "value": ... }` (a boolean for a predicate, a computed value for an expression; `value` is left out where the original asserted only that the result is definite), `{ "status": "indeterminate", "code": ... }` (`code` is left out where the original asserted only that it is indeterminate), optionally with `message`, which must equal the reason's message, or `messageIncludes`, a list of fragments that must occur in the reason's message in order (with `ignoreCase: true`, in any letter case, for an original that matched case-insensitively), or `{ "throws": { "from": ..., "message"? } }` for an evaluation that throws, where `from` names what threw (`resolver`, `function`, or `type-error` for a `TypeError`) and `message` must occur in the exception's message. Each assertion is given only where the original test made it, and a case that asserts only the resolver calls its original counted (`expectCalls`) gives no `expect`.

The resolvers are data. In `resolvers`, `values`, `lookups`, `collections`, `delegates` and `trees` list the answers; the first entry whose key (`key`, `table` with `keys`, `collection`, `system` with `payload`) equals the call (a delegate entry too may give a `context`, which defaults to any), and whose `context` equals the context of the call (an omitted `context`, or `"*"`, matches any), gives the answer. A call that no entry matches gets `default`, `{ "found": false }` when absent, and an unmatched collection is empty. `delegates` or `trees` absent means that resolver is not supplied. `fromContext: true` reads a string key from the context object instead of `values`, taking a boolean, a number or a string as a value without a unit. A resolution is `{ "found": true, "value": <computed value> }`, `{ "found": false }`, `{ "found": false, "notYetKnown": true }` or `{ "throws": "message" }`, and in the asynchronous evaluator any of them takes `settlesAfter` microtask turns to settle. `expectCalls` lists the resolver calls the evaluation makes, in order, each with the key, table, collection or system it names where it gives one.

`evaluator` sets what the evaluator is built with: `functions` (`builtin` for the package's built-in functions, and `table`, per function name the argument lists it answers and the result, a computed value or a failure `{ "domainError": ... }` or `{ "wrongType": ... }`), `maxNodes` and `maxNestingDepth`. `modes` lists the evaluators the case runs under: `async`, `sync` and, for a predicate, `compiled`; omitted, it is every one that applies, so a result that differs between them is a defect of the implementation. A case whose resolvers settle later (`settlesAfter`) lists `async` only.

#### The evaluation budget

A call may visit at most 10000 nodes and may nest at most 500 levels deep unless `evaluator.maxNodes` or `evaluator.maxNestingDepth` says otherwise. The count is of visits, not of the size of the tree: every node costs one visit each time it is evaluated, so a reduce fold costs one visit for itself, one for its initial expression and, for each item of its collection, one for each node of its combine expression. A tree that visits exactly the limit evaluates; one visit more is indeterminate with the code `domain-error` and the message `evaluation exceeded the maximum of N nodes visited in a single call (resource exhausted)`. The depth of a node is the number of nodes on the path from the root to it, a referenced tree continuing the path of the `treeReference` that named it, and a path of exactly the limit evaluates while one node longer is indeterminate with `evaluation nesting depth exceeds the maximum of N (resource exhausted)`. A chain of `treeReference` nodes is limited separately, to 100 trees. The cases under `trilean/evaluate/evaluator.integration.json` pin each of these at the boundary, with the defaults and with explicit limits, and `trilean/cli/cli-run.json` pins the same for the command, where `--max-nodes` is given as `--max-nodes N` and as `--max-nodes=N`.

`serialise`:

```json
{ "id": "...", "from": "...", "kind": "serialise", "schema": "PredicateNodeSchema", "input": "{\"operand\":{...},\"kind\":\"not\"}", "expect": "{\"kind\":\"not\",\"operand\":{...}}" }
```

`input` is JSON text, parsed with the named schema, and `expect` is the exact text the parsed value serialises to with no insertion of white space: the case pins the order of the fields (`kind` first, then as the type declares them) and the order of the members of a unit and of an opaque payload, which a JSON object in a corpus file cannot, because the canonical form sorts its keys. Both are strings for that reason.

`number-format`:

```json
{ "id": "...", "from": "...", "kind": "number-format", "value": 1e21, "expect": "1e+21" }
```

`expect` is the text `Number.prototype.toString` gives `value`, the formatter the native crate makes public, at the boundaries between its notations. A negative zero is `{ "$number": "-0" }` and formats as `0`.

`regex-match` takes an optional `dialect`: `trilean`, the default, or `ecmascript`, for a pattern in the file `trilean-regex/ecmascript/derived-patterns.json`, which the derived pattern builders of the trilean package produce and an unflagged ECMAScript `RegExp` reads. Each `matches` there is recorded from `new RegExp(pattern).test(input)`, and a generator the trilean package commits writes the file and its tests regenerate it and compare.

## Tests that stay outside the corpus

A test stays in an implementation's own suite when a case cannot state it. Each is listed here with the reason, since these tests disappear with the TypeScript they test and a port has to cover each behaviour itself. `trilean/src/conformance.unit.test.ts` fails when a test is added to, or removed from, these files without a row here, by comparing the titles of the tests with this section (a title that is a template matches up to its first placeholder). The `trilean-sql` tests are listed when its cases are extracted.

| Code | Why a case cannot state it | A port must |
| --- | --- | --- |
| T1 | a mechanism of the TypeScript language or runtime with no counterpart elsewhere (a frozen object, a thenable, a copy of an array, the prototype chain, an exception as a value) | write its own test of whatever the port has in place of it, if anything |
| T2 | it relates two evaluations of one tree to each other, or enumerates trees, so it has no single expectation to write down | run the same comparison between its own evaluation paths (asynchronous, synchronous, compiled, native and wasm) over the same trees |
| T3 | it tests a module that is not part of the package's public API (an internal numeric routine or helper), whose results the corpus pins only through the public operations built on it | test the routine it has in its place at the inputs the titles describe, since the corpus reaches these inputs only through `divide`, `power` and the duration comparisons |
| T4 | it checks the built package (its entry points, declarations, command file and JSON Schema file), which is a build artefact and not a behaviour of the language-neutral contract | check its own build output: the entry points it publishes, its declared types, its command and the schema it emits |
| T5 | it runs the package inside a Cloudflare Workers isolate, which is a host, not a behaviour; the behaviours it runs are the ones the corpus holds | run the corpus under workerd, as the wasm runner will |
| T6 | it replaces an internal module with a stub to reach a path the real implementation cannot (a result the evaluator would already have refused) | test that path through its own seam: a result that is not a finite number must be refused by the output check |
| T7 | it tests the shape of the TypeScript API an embedder composes (resolver objects and the item type), which is host code, not data | test its own embedding API: that an item is scoped to itself however the list was built, that nothing in the inputs reads as an inherited member, and that a returned list is a copy |
| T9 | it checks a value the command is given by its host and not by its arguments or files (the version), which a case has nowhere to state | test its own command's version output |
| T8 | it checks that something runs in bounded time or work, which a case, giving an answer, cannot | keep its own time or work bound test next to the cases that pin the answer; the matcher also bounds its work by counting state visits |

| Test file | Test | Code |
| --- | --- | --- |
| builtin-functions.unit.test.ts | is frozen, so changing the export cannot change what evaluation resolves | T1 |
| complex-division.unit.test.ts | does not collapse a representable quotient to zero when |divisor| is near the top of the range | T3 |
| complex-division.unit.test.ts | divides a value by itself to exactly one | T3 |
| complex-division.unit.test.ts | returns a quotient as large as the dividend when the divisor is about one | T3 |
| complex-division.unit.test.ts | returns the reciprocal of a divisor near the top of the range | T3 |
| complex-division.unit.test.ts | keeps the bits of subnormal operands | T3 |
| complex-division.unit.test.ts | divides a subnormal by itself to exactly one | T3 |
| complex-division.unit.test.ts | divides by a subnormal divisor to a large quotient | T3 |
| complex-division.unit.test.ts | does not round a quotient of several spacings to zero when the dividend is far smaller than the divisor | T3 |
| complex-division.unit.test.ts | rounds a quotient of three quarters of a spacing up to one spacing, not to zero | T3 |
| complex-division.unit.test.ts | returns zero for a zero dividend however large the divisor | T3 |
| complex-division.unit.test.ts | gives zero for a dividend of negative zeros without preserving their signs | T3 |
| complex-division.unit.test.ts | returns zero when the quotient is below the smallest subnormal | T3 |
| complex-division.unit.test.ts | overflows to infinity when the quotient is too large for a double | T3 |
| complex-division.unit.test.ts | keeps the dividend's own scale when the divisor is much larger | T3 |
| complex-division.unit.test.ts | matches the textbook quotient | T3 |
| complex-division.unit.test.ts | divides by a purely imaginary value | T3 |
| complex.unit.test.ts | places a zero-phase value entirely on the real axis | T3 |
| complex.unit.test.ts | carries the unit through unchanged | T3 |
| complex.unit.test.ts | reads the magnitude back as a real number carrying the value's own unit | T3 |
| complex.unit.test.ts | reads the phase back as a dimensionless angle in radians, whatever unit the value carries | T3 |
| complex.unit.test.ts | reads a negative real number as +pi whatever the sign of its zero imaginary part, and zero as 0 | T3 |
| complex.unit.test.ts | round-trips a magnitude and phase through the rectangular form | T3 |
| complex.unit.test.ts | builds a complexLiteral the expression tree accepts, evaluating to the value complexFromPolar would have produced directly | T3 |
| duration-order.unit.test.ts | is exact for every pair of near-equal durations in different units, subnormals included | T3 |
| duration-order.unit.test.ts | leaves a NaN unordered against anything, $leftUnit against $rightUnit | T3 |
| duration-order.unit.test.ts | finds equal infinities equal and orders them against finite values, $leftUnit against $rightUnit | T3 |
| duration-order.unit.test.ts | orders %j and %j as %i | T3 |
| integer-power.unit.test.ts | returns the identity for exponent zero without multiplying | T3 |
| integer-power.unit.test.ts | handles an exponent past the safe integers, whose low bits are all zero | T3 |
| integer-power.unit.test.ts | matches repeated multiplication for exponent $exponent | T3 |
| integer-power.unit.test.ts | multiplies a number of times logarithmic in the exponent $exponent | T3 |
| evaluate-document.non-finite.unit.test.ts | passes a representable result through | T6 |
| evaluate-document.non-finite.unit.test.ts | rejects a definite result from %s that JSON would print as null | T6 |
| evaluate-document.unit.test.ts | lets a collection error propagate for a tree that folds over a list the inputs do not hold | T1 |
| evaluation.unit.test.ts | takes the first indeterminate reason in operand order | T3 |
| evaluation.unit.test.ts | lets not-yet-known outrank every other reason wherever it appears | T3 |
| evaluation.unit.test.ts | is undefined when no entry is indeterminate | T3 |
| evaluator-compiled.unit.test.ts | returns the interpreter's Evaluation and asks the resolvers the same questions, for random trees | T2 |
| evaluator-compiled.unit.test.ts | exercises definite results, every indeterminate reason and the resource limits | T2 |
| evaluator-compiled.unit.test.ts | reports not-yet-known ahead of an earlier not-found, and the first of equal reasons | T2 |
| evaluator-compiled.unit.test.ts | takes the left operand's reason of two indeterminate operands | T2 |
| evaluator-compiled.unit.test.ts | gives each call its own answers when the same compiled predicate is called with different resolvers | T2 |
| evaluator-compiled.unit.test.ts | builds a literal handed to a registered function afresh on every call | T2 |
| evaluator-compiled.unit.test.ts | meets a node limit at the same node as the interpreter, with the resolvers asked the same questions | T2 |
| evaluator-compiled.unit.test.ts | hands a tree deeper than the nesting limit to the interpreter without compiling past the limit | T2 |
| evaluator-compiled.unit.test.ts | throws, as the interpreter does, when a resolver returns a promise | T2 |
| evaluator-compiled.unit.test.ts | reports a delegate node as wrong-type when the resolvers register no handler | T2 |
| evaluator-compiled.unit.test.ts | passes the context to the resolvers untouched | T2 |
| evaluator.complex-arithmetic.unit.test.ts | a negative exponent is exactly the reciprocal of the positive power when that is representable, for $base to the power -$exponent | T2 |
| evaluator.monotonicity.unit.test.ts | for every enumerated predicate | T2 |
| evaluator.monotonicity.unit.test.ts | for every enumerated expression: ${name} | T2 |
| evaluator.sync.unit.test.ts | gives definite and indeterminate results across the cases above, so the comparison is not vacuous | T2 |
| evaluator.sync.unit.test.ts | evaluates a value expression to the same result as the asynchronous evaluator | T2 |
| evaluator.sync.unit.test.ts | throws, rather than returning a pending result, when a resolver hands back a thenable | T2 |
| evaluator.sync.unit.test.ts | applies the node budget | T2 |
| evaluator.sync.unit.test.ts | propagates an exception thrown by a resolver | T2 |
| evaluator.sync.unit.test.ts | evaluates %s exactly as the asynchronous evaluator does | T2 |
| input-resolvers.unit.test.ts | resolves a string key naming an input | T7 |
| input-resolvers.unit.test.ts | finds nothing for an unknown name, an inherited member or a non-string key | T7 |
| input-resolvers.unit.test.ts | finds nothing for a lookup | T7 |
| input-resolvers.unit.test.ts | throws rather than return an empty collection for a list the inputs do not hold | T7 |
| input-resolvers.unit.test.ts | keeps the lists in the order they were written, apart from the named values | T7 |
| input-resolvers.unit.test.ts | returns the items of a list, each as the context its references resolve against | T7 |
| input-resolvers.unit.test.ts | resolves a name inside an item against that item alone, never the top-level inputs | T7 |
| input-resolvers.unit.test.ts | hands back a copy, so a caller cannot change the list the inputs hold | T7 |
| input-resolvers.unit.test.ts | resolves a reference inside an item against that item, whatever built the list | T7 |
| input-resolvers.unit.test.ts | never reads the top-level inputs for a reference inside an item | T7 |
| input-resolvers.unit.test.ts | gives the items the same scope as a parsed list | T7 |
| input-resolvers.unit.test.ts | does not treat a map handed in as a context as an item | T7 |
| input-resolvers.unit.test.ts | exports the item type that createInputResolvers and parseInputs take and return | T7 |
| cli.e2e.test.ts | is the file package.json's bin names, with a node shebang | T4 |
| cli.e2e.test.ts | evaluates a tree read from standard input and exits 0 | T4 |
| cli.e2e.test.ts | exits 1 for an indeterminate result | T4 |
| cli.e2e.test.ts | exits 2 with the problem on standard error for an invalid tree | T4 |
| cli.e2e.test.ts | reports the package version | T4 |
| cli.e2e.test.ts | keeps quiet and keeps its exit status when the reader of standard output has gone | T4 |
| declaration-shape.e2e.test.ts | exports both node-tree schemas in place | T4 |
| declaration-shape.e2e.test.ts | declares nothing bare and re-exports nothing through a trailing list | T4 |
| declaration-shape.e2e.test.ts | declaration shape of %s | T4 |
| cli-run.integration.test.ts | prints the version for --version | T9 |
| cli-unrepresentable.integration.test.ts | prints nothing on standard output, names the problem on standard error and exits 2 | T6 |
| json-schema-consistency.integration.test.ts | the predicate tree's generated 'kind' consts are exactly PredicateNodeSchema's own discriminated-union options | T4 |
| json-schema-consistency.integration.test.ts | the expression tree's generated 'kind' consts are exactly ExpressionNodeSchema's own discriminated-union options | T4 |
| json-schema-consistency.integration.test.ts | treeReference is present in both the predicate and expression discriminant sets | T4 |
| json-schema-consistency.integration.test.ts | hoists the repeated sub-schemas into $defs rather than inlining them | T4 |
| json-schema-consistency.integration.test.ts | emits at least one reference, so the assertion below cannot pass vacuously | T4 |
| json-schema-consistency.integration.test.ts | emits every reference in a form that resolves inside the converted document | T4 |
| json-schema-consistency.integration.test.ts | %s's mutual recursion converts to resolvable references | T4 |
| schema-pipeline.integration.test.ts | survives JSON.parse as a real own key -- the control confirming the fixture is genuinely hazardous before validation | T1 |
| schema-pipeline.integration.test.ts | cannot hijack a downstream copy's prototype once validated, where the unvalidated parse still can | T1 |
| schema-pipeline.integration.test.ts | never leaks onto the shared Object.prototype, the global half of the attack | T1 |
| smoke.e2e.test.ts | dist/index.cjs loads as CommonJS and exposes every expected export | T4 |
| smoke.e2e.test.ts | dist/tree.cjs loads as CommonJS and exposes both node-tree schemas | T4 |
| smoke.e2e.test.ts | a pre-approved, discount-authorised winning bid is definitely eligible | T4 |
| smoke.e2e.test.ts | an empty bid list -- fold's max has no first item to seed from -- is indeterminate domain-error, not a crash or a silent default | T4 |
| smoke.e2e.test.ts | is valid, parseable JSON with both node trees defined | T4 |
| smoke.e2e.test.ts | is self-contained: every $ref resolves to a definition inside the document | T4 |
| smoke.e2e.test.ts | carries a version-pinned $id identifying this exact published version on jsDelivr | T4 |
| smoke.e2e.test.ts | is RFC 8785 (JCS) canonical: re-canonicalizing its parsed content reproduces the file on disk byte for byte | T4 |
| smoke.e2e.test.ts | satisfies RFC 8785's structural rules read straight off the raw bytes, independently of the canonicalize package | T4 |
| smoke.e2e.test.ts | built package entry point -- %s | T4 |
| smoke.e2e.test.ts | exports %s as a %s | T4 |
| smoke.e2e.test.ts | built deep-import subpath -- %s | T4 |
| smoke.e2e.test.ts | exports %s as an object | T4 |
| smoke.e2e.test.ts | composed rule (fold max + memberOf + implies) against the built package -- %s | T4 |
| smoke.e2e.test.ts | %s's generated 'kind' consts are exactly the built package's own %s options | T4 |
| trilean.e2e.test.ts | base case: isActive eq true AND sum(items.amount) via reduce fold > x + y -> definite true | T5 |
| trilean.e2e.test.ts | items: [] variation -> definite false (the fold-over-empty identity feeds through to and's own absorbing false) | T5 |
| trilean.e2e.test.ts | x missing from data variation -> indeterminate not-found (and does NOT absorb here) | T5 |
| trilean.e2e.test.ts | a gold-tier member meeting every condition is definitely eligible | T5 |
| trilean.e2e.test.ts | a member with every other condition satisfied but a missing score is indeterminate, not silently eligible or ineligible | T5 |
| trilean.e2e.test.ts | mass (kg) divided by volume (m^3) combines to kg/m^3, comparable against a matching compound-unit literal | T5 |
| trilean.e2e.test.ts | a gold-tier customer's rate resolves through the referenced 'unique'-hit-policy rule | T5 |
| trilean.e2e.test.ts | two matching cases under 'unique' absorb to a domain-error, even reached via treeReference | T5 |
| trilean.e2e.test.ts | coalesce falls through a not-found preferred discount code to a guaranteed fallback value | T5 |
| trilean.e2e.test.ts | prefixPattern enforces a word boundary rather than a bare startsWith | T5 |
| trilean.e2e.test.ts | wildcardPattern keeps an escaped asterisk literal while an unescaped one still wildcards | T5 |
| trilean.e2e.test.ts | hierarchicalGlobPattern distinguishes one segment from every segment | T5 |
| trilean.e2e.test.ts | portableMatches matches via trilean-regex's own compiled NFA | T5 |
| trilean.e2e.test.ts | portableNotMatches is the negation, still inside the isolate | T5 |
| trilean.e2e.test.ts | an invalid trilean-regex pattern resolves wrong-type rather than throwing out of the isolate | T5 |
| ast.unit.test.ts | includes both endpoints and everything between them | T3 |
| ast.unit.test.ts | excludes values outside the range | T3 |
| ast.unit.test.ts | matches membership in the positive form | T3 |
| ast.unit.test.ts | inverts membership when negated | T3 |
| ast.unit.test.ts | unions multiple ranges | T3 |
| shorthand-classes.unit.test.ts | \d expands to the ASCII digit range | T3 |
| shorthand-classes.unit.test.ts | \D negates \d rather than owning its own range table | T3 |
| shorthand-classes.unit.test.ts | \w matches letters, digits, and underscore only | T3 |
| shorthand-classes.unit.test.ts | \s matches the ASCII whitespace set | T3 |
| matcher.unit.test.ts | resolves a classically pathological nested-quantifier pattern instantly | T9 | it checks a value the command is given by its host and not by its arguments or files (the version), which a case has nowhere to state | test its own command's version output |
| T8 |

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner, `cargo test` in `rust/` loads and checks every file). When a behaviour changes on purpose, change the case in the same commit as the code.
