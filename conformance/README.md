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
- `skip`, optional, with a `reason` that says why: the implementation that does not run the case, `ts` for a case the TypeScript implementation skips and `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust engine is `rust` wherever it runs (native, Node, a browser or Workers). A case one implementation cannot run carries it; nothing else does. A `reason` without `skip` is refused.
- `tolerance`, optional: `{ "ulps": n }`. Numbers compare exactly (`-0` included) unless a case gives one.

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

Where a case compares a result with an expectation, numbers are equal when they are the same double (`-0` is not `0`) or, when the case gives a `tolerance`, within that many units in the last place; an object member whose value the implementation leaves undefined is absent; every other value must be equal structurally.

`validate`:

```json
{ "id": "...", "from": "...", "kind": "validate", "schema": "NotNodeSchema", "input": { "kind": "not" }, "expect": { "ok": false, "issues": [] } }
```

`schema` is the export name of a schema of the package (`NotNodeSchema`, `PredicateNodeSchema`, `ComputedValueSchema`), so an implementation with no object of that name still names the same type. `expect` is `{ "ok": true }` with an optional `value`, the parsed value, which must be equal to it, or `{ "ok": false, "issues": [...] }`. Every listed issue must be among those reported, each with the same `path` (strings and integers) and, where it gives a `message`, a reported message that contains it. An empty list asserts only the refusal, which is what a test that asserted only `success === false` is recorded as.

`call`:

```json
{ "id": "...", "from": "...", "kind": "call", "function": "round", "args": [ { "kind": "number", "value": 2.5 } ], "expect": { "kind": "number", "value": 3 } }
```

`function` is the name of a built-in function and `args` its arguments, as computed values. `expect` is the computed value the function returns, `{ "domainError": true }` for a result that reports an argument outside the function's domain, or `{ "wrongType": true }` for one that reports an argument it cannot accept; either failure may give `messageIncludes`, fragments the failure's message contains in order. A computed value is compared by the rules above, so `-0` is not `0`. A number the canonical form cannot hold is written `{ "$number": "-0" }`, `"Infinity"`, `"-Infinity"` or `"NaN"` wherever a case has a number or a value (arguments, trees, contexts, resolver answers and expectations): a negative zero because the canonical form writes it as `0`, and the others because JSON has no such number. A native implementation, which takes its values from JSON, can be given a negative zero but not the others, so a case that has an infinity or a NaN carries `skip: "rust"`.

`evaluate`:

```json
{ "id": "...", "from": "...", "kind": "evaluate", "as": "predicate", "tree": { ... }, "context": { ... }, "resolvers": { ... }, "expect": { "status": "definite", "value": true } }
```

`tree` is a predicate or an expression (`as` says which) and is evaluated against `context` (a JSON value, absent when the test passed none). `expect` is `{ "status": "definite", "value": ... }` (a boolean for a predicate, a computed value for an expression), `{ "status": "indeterminate", "code": ... }`, optionally with `message`, which must equal the reason's message, or `messageIncludes`, a list of fragments that must occur in the reason's message in order, or `{ "throws": { "from": ..., "message"? } }` for an evaluation that throws, where `from` names what threw (`resolver`, `function`, or `type-error` for a `TypeError`) and `message` must occur in the exception's message. Each assertion is given only where the original test made it.

The resolvers are data. In `resolvers`, `values`, `lookups`, `collections`, `delegates` and `trees` list the answers; the first entry whose key (`key`, `table` with `keys`, `collection`, `system` with `payload`) equals the call, and whose `context` equals the context of the call (an omitted `context`, or `"*"`, matches any), gives the answer. A call that no entry matches gets `default`, `{ "found": false }` when absent, and an unmatched collection is empty. `delegates` or `trees` absent means that resolver is not supplied. `fromContext: true` reads a string key from the context object instead of `values`, taking a boolean, a number or a string as a value without a unit. A resolution is `{ "found": true, "value": <computed value> }`, `{ "found": false }`, `{ "found": false, "notYetKnown": true }` or `{ "throws": "message" }`, and in the asynchronous evaluator any of them takes `settlesAfter` microtask turns to settle. `expectCalls` lists the resolver calls the evaluation makes, in order, each with the key, table, collection or system it names where it gives one.

`evaluator` sets what the evaluator is built with: `functions` (`builtin` for the package's built-in functions, and `table`, per function name the argument lists it answers and the result, a computed value or a failure `{ "domainError": ... }` or `{ "wrongType": ... }`), `maxNodes` and `maxNestingDepth`. `modes` lists the evaluators the case runs under: `async`, `sync` and, for a predicate, `compiled`; omitted, it is every one that applies, so a result that differs between them is a defect of the implementation. A case whose resolvers settle later (`settlesAfter`) lists `async` only.

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

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner, `cargo test` in `rust/` loads and checks every file). When a behaviour changes on purpose, change the case in the same commit as the code.
