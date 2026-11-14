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

The files are UTF-8 (a loader refuses a file that is not, rather than reading replacement characters) and canonical JSON, which the repository's lint requires: keys sorted, two-space indent, one element per line. Every loader also checks the keys as it reads a file, on the text of the file, since a parsed object has lost the order of its keys (JavaScript lists integer-like keys first, in numeric order): in every object the keys are in strictly ascending UTF-16 code-unit order, without a repeat, and an integer-like key sorts as the string it is (`"10"` before `"2"`). A key is compared as the text it stands for, so `"\n"` and `"\t"` are compared as the two control characters and not as their escapes, and a character outside the Basic Multilingual Plane sorts by its two code units (before U+E000 to U+FFFF) and not by its code point. A key that holds an unpaired surrogate (an escape such as `\ud800` that is not completed by the escape of its other half) is refused, as it is in a string. Two more rules make the loaders give one verdict where their JSON parsers differ: a file that begins with a byte order mark is refused (the TypeScript decoder is told to keep the mark, so the parse refuses it as the Rust parser does), and no array or object is nested deeper than 64 levels, a document that is one array inside another and so on being at most 64 levels deep. `fixtures/canonical-keys/differential.json` holds documents written by a seeded generator (the generator's test regenerates it) with the number of problems the rule finds in each, and every loader must find that number in every one, so the scanners of the two TypeScript packages and of the Rust loader are held equal on a wide set of inputs and not only on the hand-written fixtures. Running `pnpm lint` rewrites a file into that form, so the examples below show the fields in reading order and the files do not.

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

`manifest.json` records, for every corpus file, its case count and, per implementation, the ids of the cases marked to be skipped by it: `skip` is `{ "ts": [...], "rust": [...] }`, each list in ascending order and without repeats, and an id is in the list of the implementation its case names. Every runner checks the corpus against it and fails on any difference, in either list. A runner also asserts the completeness of its own run against its own list, from what it records while it runs and not from what it parsed: the id of every case at the moment the runner registers it, which of them it registers as skipped, and every case whose body starts. The registered cases are the manifest's total for the runner's files, none is registered twice, the cases it registers as skipped are exactly the manifest's list for its implementation, and every other registered case started once. A runner that skips every case, a registration loop that drops or filters cases and a body that never runs each fail it, and so does a Rust runner that skips a case marked `skip: ts` (its own list says otherwise). A run that selects tests by name leaves the completeness test out, since a case it did not run has not started. A case that skips the other implementation is one it executes. A TypeScript runner belongs to one package and executes that package's directory (`trilean/` or `trilean-regex/`), so it counts against the manifest's entries for that directory; the checks of the corpus as a whole (schema, ids, manifest) cover every file. The TypeScript runner counts the cases it registers when it collects them, so the check holds whatever the run does with the registered tests (a name filter, a bail, a retry, a shuffled order).

A manifest entry may carry `generated: true`, which marks a file the generator writes (see "Generated files"); the generator's test fails for a marked file it does not write and for a file it writes that is not marked.

The Rust loader executes no case. It reads every case of every kind through the Rust types in `rust/tests/trilean-conformance`, which carry the shape of every kind the schema defines and enforce what the schema states (the id rule, a well formed `from`, `skip` and `reason` together, a well formed `tolerance`, and every form and constraint of the kind), so it validates every case in full, and enforces the rules below that a schema cannot express. It counts every case in one of two categories: a case marked `skip: rust` is skipped because it is marked, and any other is skipped for want of a native executor. The two categories and the executed cases add up to the manifest's total. It asserts that the cases it skips as marked `rust` are exactly the manifest's `skip.rust` list for the file. A case is registered when its id is read from the raw document and checked when it passes validation through the types, two observations made by different code, and it asserts per file that the registered cases are the manifest's count and that the checked cases are the registered ones, in the file's order, so a validation that skips a case or checks one twice fails.

## Cases

Every case has:

- `id`: unique across the whole corpus, in lower-case ASCII letters, digits, dots, hyphens and underscores.
- `from`: either `<test file>.test.ts: <describe> > <test>`, the original test title the case came from, so a failure points back to the behaviour it pinned, or `recorded: <package> <source file> (<what>)` for a recorded case. The schema and every loader refuse a `from` in neither form. Where the original asserted less than the case records, `from` says so.
- `kind`: selects the shape below.
- `skip`, optional, with a `reason` that says why: the implementation that does not run the case, `ts` for a case the TypeScript implementation skips and `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust engine is `rust` wherever it runs (native, Node, a browser or Workers). A case one implementation cannot run in any build carries it; nothing else does. A number JSON cannot write, an infinity or a NaN, is no reason to skip: it is written as `{ "$number": "Infinity" }` (below) and runs in every implementation. A `reason` without `skip` is refused.
- `tolerance`, optional: `{ "ulps": n }` or `{ "absolute": x }`, never both, with the meaning given under "How a result is compared". A case that gives one carries the tolerance its original test used, with the number the original compared against as the expectation.

A case comes from an existing test, with the same inputs and the same expectation, and an expectation is never weaker than the original's. The exception is a recorded case: one written for the corpus because no test covered the behaviour, whose expectation is what the TypeScript implementation does. Its `from` starts `recorded:` and names the source file the behaviour comes from (`recorded: trilean-regex src/parser.ts (...)`), so a reader can tell a pinned original from a recorded behaviour, and a loader checks the form. A recorded behaviour that is a defect is fixed and its case changed together, never left pinned.

### Text

Every pattern, input and message fragment is a sequence of UTF-16 code units, and every `index` counts UTF-16 code units, which is what the TypeScript implementation and the patterns' AST (`codeUnit`) are in. A string field takes either form:

- a JSON string, which must be well-formed Unicode (no unpaired surrogate escape), so every loader can read it; or
- `{ "codeUnits": [<0..65535>, ...] }`, for content a JSON string cannot carry, an unpaired surrogate.

A loader reads both into the same code unit sequence; `fixtures/text-forms/pairs.json` lists texts with their code units, and every loader checks they agree. A loader that cannot decode a string into code units, or that reads one in scalar values or bytes, is wrong: `😀` is two literals, and `index` after it counts two.

`case.schema.json` is the format, including the kinds of every package of the repository. A loader accepts no document the schema rejects, and accepts every document the schema accepts, except one that breaks a rule the Text and Rules sections add beside the schema (an unpaired surrogate in a JSON string, invalid UTF-8). The Rust types the Rust loader reads cases through emit a schema that a Rust test compares with `case.schema.json` by meaning (references followed; key order, the names of definitions and the descriptions ignored; `required`, `enum`, `oneOf` and `anyOf` as sets; a `type` that a `const` or an enum of strings decides dropped) and names every difference, and the root test `shape-agreement.integration.test.ts` gives every corpus file and every fixture to Ajv under both schemas and fails on a different verdict, so a change to the format is made in the types and the schema together. A corpus file holds at least one case.

### Rules the schema cannot express

Each loader enforces these beside the schema:

- A character class range's `from` is not above its `to`.
- A `repeat`'s `min` is not above its `max`.
- A case id is not used twice, within a file or across files.
- A manifest's `skip.ts` and `skip.rust` lists are each in ascending order, without repeats, and share no id.
- In every object of every file the keys are in the order of the key rule stated with the canonical form above (UTF-16 code-unit order, integer-like keys as strings, no repeat, no unpaired surrogate).
- The corpus matches the manifest.

A field the schema types as an integer is at most 2^53-1, the largest the JavaScript runners hold exactly, and an integer written `97.0` is the integer 97, as in JSON Schema; a number elsewhere in a case (a value, an argument, an expectation) is any double.

Every rule above has a negative fixture, and every negative fixture has a repaired twin of the same name that differs by that one defect and is valid, so a fixture cannot stay rejected for another reason. The fixtures are in directories, and which loader asserts which pair is part of the contract:

| Directory under `fixtures/` | Holds | Asserted by |
| --- | --- | --- |
| `invalid-cases`, `repaired-cases`, `valid-cases` | a rule about one file whose cases are of a regex kind, or a file that every loader must reject or accept | every loader |
| `refused-kinds/invalid`, `refused-kinds/repaired` | a defect in what every case has (the id, `from`, `kind`, `skip` and `reason`, an id repeated in the file) in a case of a kind other than the regex kinds | every loader |
| `manifests/invalid`, `manifests/repaired`, `manifests/valid` | a rule about the manifest | every loader |
| `corpora/invalid`, `corpora/repaired` | a rule across files, or between the corpus and its manifest, a whole corpus root loaded the way the real corpus is | every loader |
| `schema-only/invalid-cases`, `schema-only/repaired-cases`, `schema-only/valid-cases` | a defect in the shape of a case of a kind other than the regex kinds, and the valid cases that give every optional form | every loader |
| `generated/invalid-cases`, `generated/repaired-cases` | for every constraint the schema states, one file that breaks it alone and its twin, written by the generator | every loader |
| `case-schema/emitted.json` | the schema the Rust case types emit, written by the Rust loader's test and compared with the types on every run | the Rust loader (rewritten with `UPDATE_CORPUS_FIXTURES=1`), and the root test, which gives every file of the corpus and of the fixtures to Ajv under it and under `case.schema.json` and requires one verdict |
| `shape-agreement` | the tables of documents and the schemas that keep the Rust validator derived from a type and the schema it emits equal, in both JSON Schema drafts (the `json-shape` crate's own fixtures, not corpus cases) | the `json-shape` tests and the root test |
| `canonical-keys/invalid`, `canonical-keys/repaired` | a document whose keys break the key rule, which is any JSON document and not a corpus file, and its twin with the keys in order; the file under `invalid-cases` of the same name as one under `repaired-cases` shows the rule applied to a corpus file | every loader |
| `loader-selection`, `text-forms` | the file selection rule and the two forms of a text | every loader |

Each loader of the corpus is one of these: the Rust loader, the TypeScript runner of `trilean` and the wasm runner of `trilean-regex`, which reads the files with the schema through Ajv in every runtime it runs in. A file a loader cannot parse counts as rejected, which is how a loader meets an unpaired surrogate escape. Every real corpus file must be accepted by all of them. A rule added to the format gets a fixture and its twin in the same commit; a constraint added to the schema gets its generated pair when the generator is run, and the generator's test fails until it is.

The schema accepts nothing that no case exercises: a test of the TypeScript runner walks `case.schema.json` along every case of the corpus and every valid fixture and fails for a property, a `oneOf` branch or an `enum` value of the kinds that package runs that none of them uses. A form is added to the schema together with a case that uses it.

### The wasm runner

`conformance/runner/` holds the runner of the `trilean-regex` package, the one JavaScript this repository allows outside configuration and the Node glue of a package, in `.mjs` files that total at most 16,384 bytes. It runs the corpus against the package as a consumer installs it, from the tarball `pnpm pack` makes, in three runtimes:

- `node.mjs <tarball>` installs the tarball under a temporary `node_modules` and imports the package from there.
- `chromium.mjs <tarball>` bundles the runner and the package the way a page would, with the `browser` condition, and runs them in headless Chromium through Playwright.
- `workerd.mjs <tarball>` bundles them for Cloudflare Workers, with the `workerd` condition and the corpus built in, and runs them in workerd through Miniflare.

Each runtime applies the contract of this README to the corpus it reads: the one file selection rule, over the fixture tree as well, every file and the manifest checked with Ajv against the schemas, every negative fixture rejected beside its repaired twin, and the corpus equal to its manifest. It then executes the cases of `trilean-regex/`. The runner is written for a runtime with no file system, so `run.mjs` takes the corpus as a tree of files and the package as a module, and the other files only supply them. The wasm build is the Rust implementation, so the runner skips a case marked `skip: rust` and executes one marked `skip: ts`, and ignores a `workBound`, which only the native runner counts.

### Generated files

Some files are written by a generator, `packages/trilean/scripts/generate-corpus.ts`, and compared with it: the corpus files `trilean-regex/ecmascript/derived-patterns.json`, `trilean/number-format/number-format.json` and `trilean/serialise/serialise.json` (marked `generated` in the manifest, with `from` giving the source and every result recorded from the implementation), the fixtures under `fixtures/generated`, and the index in this file. The test `conformance.generated.unit.test.ts` regenerates all of them and fails when one differs from what is committed, so a change to the implementation, the corpus or the schema is followed by a regeneration that is reviewed.

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

`regex-match` takes an optional `dialect`: `trilean`, the default, is the language of the package's own matcher. `ecmascript` is the language of an unflagged ECMAScript `RegExp`: the pattern is read as that engine reads it, over UTF-16 code units, with no `^` or `$` at a line break (no `m` flag), no `.` that excludes line terminators (the patterns the derived builders write use `[\s\S]` and `[^\/]`, which take every code unit, a line terminator and an unpaired surrogate among them), and `test` finding a match anywhere. Each `matches` was recorded from `new RegExp(pattern).test(input)`. The generator that writes these cases (see Generated files) recomputes every answer from the host's `RegExp`, which checks that the recorded answers still hold and tests no implementation of this repository. An implementation compiles each pattern through the entry point it offers for that language, which refuses a construct that means something else there (`compile_ecmascript_subset` in the Rust crate, `compileEcmascriptSubset` in the package), and gives the recorded answer.

The corpus pins answers, never time. An input may also state a bound on the work the matcher does for it, `workBound: { "factor": k }`: at most k times (the pattern's length + 1) times (the input's length + 1) NFA state visits, both lengths in UTF-16 code units, where a visit is the epsilon closure expanding a state (`CompiledPattern::test_counted` in the Rust crate reports it). Only a runner that counts visits checks the field: the native runner does, and the runners of the wasm build run the same compiled Rust without the counter and ignore it. The cases that state one are patterns a backtracking engine takes exponential time on, so a matcher that backtracks fails them without a clock. A test that bounds how long something takes stays in the implementation's own tests.

### trilean

#### What the cases define

The cases are the specification of the package's behaviour: the reason codes, the wording of messages, the grammar of the command, the form and range of an instant and the order in which resolvers are asked are defined by the cases that pin them and by nothing else, so a second implementation reads the cases, not the TypeScript. The index below is generated from the corpus (the generator's test fails when it differs) and lists the vocabulary the cases use, so it can be read without reading every case.

<!-- generated:index -->

| Kind | Cases |
| --- | ---: |
| `build` | 88 |
| `call` | 181 |
| `cli` | 95 |
| `document` | 36 |
| `evaluate` | 813 |
| `inputs` | 13 |
| `number-format` | 40 |
| `regex-match` | 136 |
| `regex-parse` | 98 |
| `serialise` | 38 |
| `validate` | 127 |

Reason codes an expectation names: `domain-error`, `not-found`, `not-yet-known`, `wrong-type`.

Command flags the cases pass: `-`, `--as`, `--help`, `--inputs`, `--max-depth`, `--max-nodes`, `--nope`, `-5`, `-h`.

Exit codes the cases expect of the command: `0`, `1`, `2`.

<!-- /generated:index -->

An evaluation is `definite` with a value, or `indeterminate` with a reason: a `code` (`not-found`, `not-yet-known`, `wrong-type` or `domain-error`) and a `message`. A message is pinned exactly where a case gives `message`, and by fragments where it gives `messageIncludes`; the English wording of those messages is therefore part of the contract.

#### How a result is compared

Numbers are equal when they are the same double, a negative zero not being a zero, unless the case gives a `tolerance`. With one, every number in the compared value is held to it, integers and unit exponents included. `absolute` holds when `|actual - expected| < absolute`, strictly, so the bound written for `toBeCloseTo(x, d)` is `absolute = 10^-d / 2`; `ulps` holds when at most that many representable doubles lie between the two numbers, both zeros being one point. A tolerance forgives the sign of a zero. A number that is not finite is never within a tolerance of another number: an expectation that is an infinity or a NaN is compared exactly whatever the tolerance. An object member whose value the implementation leaves undefined is absent, and every other value is equal structurally, the order of an object's members not counting. A number the canonical form cannot hold is written `{ "$number": "-0" }`, `"Infinity"`, `"-Infinity"` or `"NaN"`, as an object with that one member and no other, wherever a case has a number or a value; the schema refuses an object with a `$number` member that is anything else. Every implementation reads those four forms as the numbers they name, so such a case carries no `skip`. A native implementation can be given a negative zero, an infinity or a NaN in an argument, a tree, a context or a resolver answer.

Results computed by the engine's `exp`, `log`, `hypot`, `sin`, `cos` and `atan2`, and by what is built on them (`exponential`, `logarithm`, the trigonometric functions, `phase`, `magnitude` and `squareRoot` of a complex number, a complex literal given by magnitude and phase), are held to one unit in the last place, since two conforming implementations need not agree to the last bit; the `from` of such a case says that the original asserted the engine's exact digits. Every other result is exact. The one exception to the tolerance for `logarithm` is the base rule: `logarithm` of a real number to base 10 or base 2 is computed by the engine's base-10 or base-2 logarithm, not as the quotient of two natural logarithms, so the result is exact (the integer, with no tolerance) for an argument that is an exact power of the base, such as `logarithm(1000, 10)` and `logarithm(8, 2)`, where the quotient is not (the natural logarithm of 1000 divided by that of 10 is 2.9999999999999996). The two cases rely on the base-10 and base-2 logarithms of the platform being exact on exact powers of their base, which ECMAScript does not require of `Math.log10` and `Math.log2`: an implementation computes them with a logarithm that is, and checks its own before relaxing a case. The natural logarithm of a real number is the engine's logarithm itself, and a real number to any other base is the quotient of two natural logarithms; both are held to a tolerance, one unit in the last place, so a case whose exactness does not follow from the base rule carries a tolerance (`ulps: 1`, or the one its original test used). For a complex argument the base rule applies to nothing: the result is the natural logarithm of the argument divided by that of the base, in the real and the imaginary part alike, and so carries a tolerance. Where an original test used a tolerance, the case carries it and gives the number the original compared against, never the implementation's own digits; exact digits of the implementation appear only in the generated files.

#### validate

```json
{ "id": "...", "from": "...", "kind": "validate", "schema": "NotNodeSchema", "input": { "kind": "not" }, "expect": { "ok": false } }
```

`schema` is one of the names the schema lists (the exports of the package that are schemas), so an implementation with no object of that name still names the same type. `expect` is `{ "ok": false }`, for an input the schema refuses (the case does not pin why), or `{ "ok": true }` with an optional `value`, the parsed value, which must be equal to it: a member the schema does not define is removed, and nothing is added or converted.

#### call

```json
{ "id": "...", "from": "...", "kind": "call", "function": "round", "args": [ { "kind": "number", "value": 2.5 } ], "expect": { "kind": "number", "value": 3 } }
```

`function` is one of the built-in functions the schema lists and `args` its arguments, as computed values (a number, text, boolean, instant, duration or complex value, each with the members the package gives it). `expect` is the computed value the function returns, `{ "domainError": true }` for a result that reports an argument outside the function's domain, or `{ "wrongType": true }` for one that reports an argument it cannot accept; either failure may give `messageIncludes`, fragments the failure's message contains in order.

#### build

```json
{ "id": "...", "from": "...", "kind": "build", "builder": "xor", "args": [ { ... }, { ... } ], "expect": { ... } }
```

`builder` is one of the functions of the package that build a tree, which the schema lists, `args` its arguments in order (trees, a collection reference, a string; `null` for an argument left out) and `expect` the tree it returns. A case that only pins the tree a test went on to evaluate is recorded, and says so in `from`.

#### inputs

```json
{ "id": "...", "from": "...", "kind": "inputs", "raw": { "a": 1 }, "expect": { "ok": true, "inputs": { "a": { "kind": "number", "value": 1 } }, "collections": {} } }
```

`raw` is parsed as the inputs of a document: an object whose members are plain numbers, texts and booleans (a value without a unit), complete computed values (kept as they are, members the type does not define removed) and arrays of objects of such members (a list of items, for a `fold`, `some` or `every`). `expect` is `{ "ok": true, "inputs": ..., "collections": ... }`, the named values and the lists of items as JSON objects, or `{ "ok": false, "issues": [...] }`, the issue texts in order.

#### document

```json
{ "id": "...", "from": "...", "kind": "document", "tree": { ... }, "inputs": { ... }, "as": "predicate", "maxNodes": 100, "expect": { "outcome": "evaluated", "treeKind": "expression", "evaluation": { ... } } }
```

A document is a tree and its inputs, evaluated with the package's built-in functions, each `reference` reading a name from the inputs and each collection being a list of items of the inputs. `as` says whether the tree is a predicate or an expression; absent, the kind is read from the root, and a root that is a `treeReference`, valid as either, is rejected with the reason `ambiguous-tree-kind`. `maxNodes` is the budget, 10000 when absent. The outcome is one of three objects: `{ "outcome": "evaluated", "treeKind": "predicate" or "expression", "evaluation": <definite or indeterminate> }`; `{ "outcome": "rejected", "reason": "invalid" or "ambiguous-tree-kind", "issues": [...] }`, where an issue is `<path>: <text>` and nothing was evaluated (the tree or the inputs are invalid); and `{ "outcome": "unrepresentable", "issues": [...] }`, for a definite result that JSON cannot carry. `expect` is the whole outcome. A rejected document whose issues hold a schema library's text, which the implementation does not own, gives `expectSubset` instead, the outcome without that text: it names at least one key, an object matches when every key it gives matches, an array matches element by element at the same length, and any other value must be equal; `expectIssuePaths` then lists paths each of which at least one issue names (an issue is `<path>: <text>`).

#### cli

```json
{ "id": "...", "from": "...", "kind": "cli", "args": ["evaluate", "tree.json"], "files": { "tree.json": "{...}" }, "stdin": "...", "expect": { "exit": 0, "stdoutJson": { ... } } }
```

The command is `evaluate <tree.json>` with the options `--inputs <file>` (a JSON object, read as the inputs of a document), `--as predicate|expression` and `--max-nodes <n>` (a positive integer written in plain digits, no sign, no exponent and no space, at most 2^53-1, given as `--max-nodes N` or `--max-nodes=N`; the digits are `0` to `9` only and the first is not `0`, so `0`, `00`, `05`, `1_0`, `0x10`, an empty value and a value past 2^53-1 are all refused, as are a sign, an exponent, a decimal point, a space and a line break anywhere in it, in both forms, with the message `--max-nodes must be a positive safe integer, not <the value as a JSON string>` and exit `2` (a quote, a backslash or a line break in the value is escaped as JSON escapes it, so a line break prints as the two characters backslash and `n`); in the separate form a value that starts with a hyphen is not read as the value at all, and the command exits `2` for an option without one, with a different message. An option given more than once takes the last value, which is the one checked. `trilean/cli/max-nodes-grammar.json` pins each of these. There is no option for the nesting depth: the command always evaluates with the default depth limit, and an option it does not know, `--max-depth` included, is bad usage with exit `2`), `--help` (`-h`) and `--version` (`-v`). A path of `-` reads standard input. It prints the evaluation as JSON on standard output and exits `0` for a definite result and `1` for an indeterminate one; it prints nothing on standard output and exits `2`, with the problem on standard error, for bad usage, an unreadable or invalid file, a rejected document or a collection the inputs do not hold. The command is run against an in-memory set of files, `files` (name to text), and `stdin`; a path that is in neither cannot be read. The text of `files` is read as written by a parser that reads a number past the double range as an infinity (`1e999` is infinite), which a standard JSON parser may refuse and the implementation's command must not. `expect` gives the exit status and what the command printed: `stdout` or `stderr` as exact text (a command that exits with `2` prints nothing on standard output, and a case says so), `stdoutJson`, the JSON printed, `stderrIncludes`, fragments standard error contains in order, and `stderrStartsWith` and `stdoutStartsWith`.

#### evaluate

```json
{ "id": "...", "from": "...", "kind": "evaluate", "as": "predicate", "tree": { ... }, "context": { ... }, "resolvers": { ... }, "expect": { "status": "definite", "value": true } }
```

`tree` is a predicate or an expression (`as` says which) and is evaluated under `context`, a JSON value. A case without `context` gives the evaluator no context at all, which is not a context of `null`.

`expect` is `{ "status": "definite", "value": ... }` (a boolean for a predicate, a computed value for an expression), `{ "status": "indeterminate", "code": ... }` (`code` is always given, and a `message` or `messageIncludes` where the implementation words the reason), optionally with `message`, which must equal the reason's message, or `messageIncludes`, fragments that must occur in the reason's message in order (with `ignoreCase: true`, compared without regard to the case of the ASCII letters A to Z, for an original that matched case-insensitively; it applies to `message` too), or `{ "throws": { "message": ... } }`, for an evaluation that ends in an exception, whose message contains the fragment; an exception comes only from a resolver that throws (a resolution `{ "throws": "message" }`) and is not caught by the evaluator. A case that asserts only the resolver calls (`expectCalls`) gives no `expect`.

The resolvers are data. `resolvers` lists the answers a resolver gives, in these forms, and an evaluation asks a resolver for each `reference` (`values`), `lookup` (`lookups`), collection of a `fold`, `some` or `every` (`collections`), `delegate` (`delegates`) and `treeReference` (`trees`). A call is answered by the first entry, in the order listed, that matches it:

- A `values` entry matches a call whose key equals its `key`, a `lookups` entry one whose table equals its `table` and whose evaluated keys equal its `keys` (computed values, in order), a `collections` entry one whose collection reference equals its `collection`, a `delegates` entry one whose `system` and `payload` equal its own, and a `trees` entry one whose key equals its `key`. JSON values are equal when they are the same value, the order of an object's members not counting.
- Every entry but a `trees` entry may give a `context`, by one rule for all of them: it matches only a call made under an equal context. An entry that gives none, or gives the text `"*"` (so the text `*` cannot be named as a context), matches a call made under any context, one made under no context included. A `null` context is a context, which an entry that names `null` matches and an absent context does not.
- The context of a call is the context of the evaluation, until the evaluation enters an item of a collection: every call made while evaluating an item of a `fold`, `some` or `every` (its filter, its item expression and, for a `fold`, its combine expression) carries that item, an element of the entry's `items`, as its context, and the call for the collection itself and for the initial expression of a `fold` carries the context of the `fold`. A referenced tree is evaluated under the context of its `treeReference`.
- When no entry answers a `value` call and `fromContext` is `true`, the key is read from the context: when the context is an object that has the key as its own member, and its value there is a boolean, a number or a text, the answer is that value without a unit. Any other value (an array, an object, `null`), a missing member, a context that is not an object and a key that is not a text fall through. `fromContext` applies to `values` only.
- A call that nothing answers gets `default`, `{ "found": false }` when `default` is absent; a collection nothing answers is empty. `delegates` or `trees` absent means that resolver is not supplied, which is the same as not registering one.

A resolution is `{ "found": true, "value": <computed value> }`, `{ "found": false }` (a known absence, evaluating to `not-found`), `{ "found": false, "notYetKnown": true }` (an absence that may be filled later, evaluating to `not-yet-known`) or `{ "throws": "message" }`.

`expectCalls` lists the resolver calls the evaluation makes, in the order it makes them, which is depth first in the order of the tree's operands, left to right, and is the same in every mode. It is compared exactly: the number of calls must be the length of the list, so an implementation that caches the answer for a repeated key makes fewer calls and fails. Each entry names the resolver (`value`, `lookup`, `collection`, `delegate` or `tree`) and, where it gives one, the argument that call records: `key` for `value` and `tree`, `table` for `lookup` (the keys are not recorded), `collection` for `collection` and `system` for `delegate` (the payload is not recorded).

`evaluator` sets what the evaluator is built with. `functions.builtin` registers the package's built-in functions (the functions of `call`); `functions.table` maps a function name to entries, each an `args` list and a `result`, and a call whose arguments equal an entry's `args` (computed values, in order) returns that result, which is a computed value, `{ "domainError": "message" }` or `{ "wrongType": "message" }`; an entry of the table replaces a built-in function of the same name; a call whose arguments no entry lists is a defect of the case and fails it. A name that is not registered is `wrong-type`. `maxNodes` and `maxNestingDepth` are the limits below. `modes` lists the evaluators the case runs under, `async`, `sync` and, for a predicate, `compiled` (the same tree prepared for repeated evaluation); omitted, it is every one that applies, and the result must be the same in each.

#### The evaluation budget

A call may visit at most 10000 nodes and may nest at most 500 levels deep unless `evaluator.maxNodes` or `evaluator.maxNestingDepth` says otherwise (a positive integer). The count is of visits, not of the size of the tree: every node costs one visit each time it is evaluated, so a reduce fold costs one visit for itself, one for its initial expression and, for each item of its collection, one for each node of its combine expression. A tree that visits exactly the limit evaluates; one visit more is indeterminate with the code `domain-error` and the message `evaluation exceeded the maximum of N nodes visited in a single call (resource exhausted)`. The depth of a node is the number of nodes on the path from the root to it, a referenced tree continuing the path of the `treeReference` that named it, and a path of exactly the limit evaluates while one node longer is indeterminate with `evaluation nesting depth exceeds the maximum of N (resource exhausted)`. A chain of `treeReference` nodes is limited separately, to 100 trees. An exhausted limit of any of the three, reached inside the operand of an `exists`, is the result of the `exists` as well, with the limit's own code and message: it is never a definite `true`. The cases in `trilean/evaluate/evaluator.integration.json` pin each of these at the boundary, with the defaults and with explicit limits, `trilean/evaluate/exists-budget.json` pins the three inside an `exists` (one under, at and one over, under every evaluator), and `trilean/cli/cli-run.json` pins the same for the command.

#### Instants and durations

An instant is a text in the ECMAScript date-time string format (`YYYY-MM-DD`, optionally with `THH:mm`, `:ss` and `.sss` and a zone of `Z` or `+HH:mm` or `-HH:mm`), at millisecond resolution, from -8.64e15 to 8.64e15 milliseconds from the epoch. An instant that is the result of an operation is written `YYYY-MM-DDTHH:mm:ss.sssZ` with three fractional digits, a year beyond 9999 or before 0 as a sign and six digits; a result outside the range is `domain-error`, and an operand that is not an instant of that format is `wrong-type`. The cases in `trilean/evaluate/instants.json` are recorded from the implementation and pin the forms accepted, forms refused and both ends of the range. A duration is a number with a unit (`ms`, `s`, `min`, `h` or `d`) and the sum or difference of durations and instants is a duration in milliseconds or an instant.

#### serialise

```json
{ "id": "...", "from": "...", "kind": "serialise", "schema": "PredicateNodeSchema", "input": "{\"operand\":{...},\"kind\":\"not\"}", "expect": "{\"kind\":\"not\",\"operand\":{...}}" }
```

`schema` is one of the tree and value schemas the schema lists. `input` is JSON text, parsed with the named schema, and `expect` is the exact text the parsed value serialises to with no insertion of white space: the case pins the order of the fields (`kind` first, then as the type declares them) and the order of the members of a unit and of an opaque payload, which a JSON object in a corpus file cannot, because the canonical form sorts its keys. Both are strings for that reason. A number in the text is written by the rule of `number-format` below.

#### number-format

```json
{ "id": "...", "from": "...", "kind": "number-format", "value": 1e21, "expect": "1e+21" }
```

`expect` is the text the ECMAScript `Number::toString` operation gives `value`: the shortest decimal text that reads back as the same double, in positional notation for a magnitude from 1e-6 up to but not including 1e21 and in exponent notation (`1e+21`, `1.5e-7`) otherwise, `0` for either zero, and `Infinity`, `-Infinity` and `NaN`. The cases run at the boundaries between the notations.

## Tests that stay outside the corpus

A test stays in an implementation's own suite when a case cannot state it. Each is listed here with the reason, since these tests disappear with the TypeScript they test and a port has to cover each behaviour itself. The table covers the tests of `trilean` other than the runners' own (`conformance.unit.test.ts`, `conformance.generated.unit.test.ts`, `conformance.compare.unit.test.ts` and `conformance.schema.unit.test.ts`), which test the corpus machinery and not a behaviour; another package lists its own tests where its corpus is described. `trilean/src/conformance.unit.test.ts` fails when a test has no row, when a row has no test, when a row's title is not exactly the test's title (a template title is listed as written, placeholders included), when a row is malformed, and when a row's code is not defined above.

| Code | Why a case cannot state it | A port must |
| --- | --- | --- |
| T1 | a mechanism of the TypeScript language or runtime with no counterpart elsewhere (a frozen object, a thenable, a copy of an array, the prototype chain, an exception as a value) | write its own test of whatever the port has in place of it, if anything |
| T2 | it relates two evaluations of one tree to each other, or enumerates trees, so it has no single expectation to write down | run the same comparison between its own evaluation paths (asynchronous, synchronous, compiled, native and wasm) over the same trees |
| T3 | it tests a module that is not part of the package's public API (an internal numeric routine or helper), whose results the corpus pins only through the public operations built on it | test the routine it has in its place at the inputs the titles describe, since the corpus reaches these inputs only through `divide`, `power` and the duration comparisons |
| T4 | it checks the built package (its entry points, declarations, command file and JSON Schema file), which is a build artefact and not a behaviour of the language-neutral contract | check its own build output: the entry points it publishes, its declared types, its command and the schema it emits |
| T5 | it runs the package inside a Cloudflare Workers isolate, which is a host, not a behaviour; the behaviours it runs are the ones the corpus holds | run the corpus under workerd, as the wasm runner does |
| T6 | it replaces an internal module with a stub to reach a path the real implementation cannot (a result the evaluator would already have refused) | test that path through its own seam: a result that is not a finite number must be refused by the output check |
| T7 | it tests the shape of the TypeScript API an embedder composes (resolver objects and the item type), which is host code, not data | test its own embedding API: that an item is scoped to itself however the list was built, that nothing in the inputs reads as an inherited member, and that a returned list is a copy |
| T8 | it checks that something runs in bounded time or work, which a case, giving an answer, cannot | keep its own time or work bound test next to the cases that pin the answer; the matcher also bounds its work by counting state visits |
| T9 | it checks a value the command is given by its host and not by its arguments or files (the version), which a case has nowhere to state | test its own command's version output |
| T10 | its original asserted an inequality (a sign, finiteness) of a result in the subnormal range, whose last digits differ between conforming implementations, so a case pinning the value would over-constrain it | test the inequality of the original on its own result |

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
| evaluator.complex-arithmetic.unit.test.ts | keeps a negative power of a large base finite where its positive power would overflow | T10 |
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
| schema-pipeline.integration.test.ts | survives JSON.parse as a real own key: the control confirming the fixture is genuinely hazardous before validation | T1 |
| schema-pipeline.integration.test.ts | cannot hijack a downstream copy's prototype once validated, where the unvalidated parse still can | T1 |
| schema-pipeline.integration.test.ts | never leaks onto the shared Object.prototype, the global half of the attack | T1 |
| smoke.e2e.test.ts | dist/index.cjs loads as CommonJS and exposes every expected export | T4 |
| smoke.e2e.test.ts | dist/tree.cjs loads as CommonJS and exposes both node-tree schemas | T4 |
| smoke.e2e.test.ts | a pre-approved, discount-authorised winning bid is definitely eligible | T4 |
| smoke.e2e.test.ts | an empty bid list: fold's max has no first item to seed from: is indeterminate domain-error, not a crash or a silent default | T4 |
| smoke.e2e.test.ts | is valid, parseable JSON with both node trees defined | T4 |
| smoke.e2e.test.ts | is self-contained: every $ref resolves to a definition inside the document | T4 |
| smoke.e2e.test.ts | carries a version-pinned $id identifying this exact published version on jsDelivr | T4 |
| smoke.e2e.test.ts | is RFC 8785 (JCS) canonical: re-canonicalizing its parsed content reproduces the file on disk byte for byte | T4 |
| smoke.e2e.test.ts | satisfies RFC 8785's structural rules read straight off the raw bytes, independently of the canonicalize package | T4 |
| smoke.e2e.test.ts | built package entry point: %s | T4 |
| smoke.e2e.test.ts | exports %s as a %s | T4 |
| smoke.e2e.test.ts | built deep-import subpath: %s | T4 |
| smoke.e2e.test.ts | exports %s as an object | T4 |
| smoke.e2e.test.ts | composed rule (fold max + memberOf + implies) against the built package: %s | T4 |
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

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner, `cargo test` in `rust/` loads and checks every file). When a behaviour changes on purpose, change the case in the same commit as the code.
