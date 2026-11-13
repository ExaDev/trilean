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

The files are canonical JSON, which the repository's lint requires: keys sorted, two-space indent, one element per line. Running `pnpm lint` rewrites a file into that form, so the examples below show the fields in reading order and the files do not.

### Which files are corpus files

Every loader applies this one rule, and each runs it over `fixtures/loader-selection` (a tree and the files it must select and the entries it must refuse) so the loaders cannot disagree:

- A name that starts with a dot is ignored, at any depth.
- A directory called `fixtures`, `schema` or `runner` is skipped, at any depth, directly under the root included. It holds data cases refer to or the runners themselves, never cases.
- A name is lower-case ASCII letters, digits, dots, hyphens and underscores, and starts with a letter or digit, so every loader orders names the same way. The root's own files are the exception. A name that is not is a failure.
- A corpus file is a `.json` file at `<package>/<area>/<name>.json`. The area names the case kind it holds, and a file takes its name from the test file it was extracted from (`parse/parser.json` from `parser.unit.test.ts`).
- The root holds only `README.md`, `case.schema.json`, `manifest.json` and `manifest.schema.json` as files.
- Files and problems are listed in UTF-16 code unit order, directory by directory.
- Anything else, a stray file, a file of another type, a file or directory at another depth, is a failure in every loader, never ignored by one.

### The manifest

`manifest.json` records, for every corpus file, its case count and the ids of the cases marked for one implementation only, in ascending order. Every runner checks the corpus against it and fails on any difference, and checks that the cases it registered plus the cases it skips equal the manifest's total, counted when it collects them, so the check holds whatever the run does with the registered tests (a name filter, a bail, a retry, a shuffled order). Changing the corpus means changing the manifest in the same commit, so a case cannot be dropped, or hidden from one side, without a visible change.

## Cases

Every case has:

- `id`: unique across the whole corpus, in lower-case ASCII letters, digits, dots, hyphens and underscores.
- `from`: the original test title the case came from, as `<test file>: <describe> > <test>`, so a failure points back to the behaviour it pinned. A case written for the corpus says what it pins instead. Where the original asserted less than the case records, `from` says so.
- `kind`: selects the shape below.
- `only`, optional, with a `reason` that says why: `ts` for a case the TypeScript implementation skips, `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust engine is `rust` wherever it runs (native, Node, a browser or Workers). A case one implementation cannot run carries it; nothing else does. A `reason` without `only` is refused.
- `tolerance`, optional: `{ "ulps": n }`. Numbers compare exactly (`-0` included) unless a case gives one.

A case comes from an existing test, with the same inputs and the same expectation, and an expectation is never weaker than the original's. The exception is a recorded case: one written for the corpus because no test covered the behaviour, whose expectation is what the TypeScript implementation does today. Its `from` starts `recorded:` and names the source file the behaviour comes from (`recorded: trilean-regex src/parser.ts (...)`), so a reader can tell a pinned original from a recorded behaviour. A recorded behaviour that is a defect is fixed and its case changed together, never left pinned.

### Text

Every pattern, input and message fragment is a sequence of UTF-16 code units, and every `index` counts UTF-16 code units, which is what the TypeScript implementation and the patterns' AST (`codeUnit`) are in. A string field takes either form:

- a JSON string, which must be well-formed Unicode (no unpaired surrogate escape), so every loader can read it; or
- `{ "codeUnits": [<0..65535>, ...] }`, for content a JSON string cannot carry, an unpaired surrogate.

A loader reads both into the same code unit sequence; `fixtures/text-forms/pairs.json` lists texts with their code units, and every loader checks they agree. A loader that cannot decode a string into code units, or that reads one in scalar values or bytes, is wrong: `😀` is two literals, and `index` after it counts two.

`case.schema.json` is the format, including the kinds later packages use. Every loader accepts exactly the documents the schema accepts, and refuses a kind it cannot validate in full rather than passing it unchecked. A corpus file holds at least one case.

### Rules the schema cannot express

Each loader enforces these beside the schema:

- A character class range's `from` is not above its `to`.
- A `repeat`'s `min` is not above its `max`.
- A case id is not used twice, within a file or across files.
- A manifest's `only` lists are in ascending order, without repeats.
- The corpus matches the manifest.

Integers are at most 2^53-1, the largest the JavaScript runners hold exactly, and an integer written `97.0` is the integer 97, as in JSON Schema.

`fixtures/invalid-cases` holds one file per rule, each of which every loader must reject; `fixtures/valid-cases` holds files every loader must accept, the bounds of every number among them; `fixtures/manifests/invalid` and `fixtures/manifests/valid` do the same for the manifest. A file a loader cannot parse counts as rejected, which is how a loader meets an unpaired surrogate escape. Every real corpus file must be accepted by all of them. A rule added to the format gets a fixture in the same commit.

### trilean-regex

`regex-parse`:

```json
{ "id": "...", "from": "...", "kind": "regex-parse", "pattern": "a{2,}", "expect": { "ast": { "kind": "repeat", "operand": { "kind": "literal", "codeUnit": 97 }, "min": 2 } } }
```

`expect` is one of:

- `{ "ast": <node> }`: the parsed tree equals the node. Field names are those of the package's AST. An unbounded `repeat` omits `max`, since JSON has no `undefined`.
- `{ "astSubset": <partial node> }`: for a test that asserted only some fields of the tree. It names at least one key. An object matches when every key it gives matches; an array matches element by element and has the same length; any other value must be equal.
- `{ "error": { "index"?, "message"? } }`: the pattern is refused with a parse error. `index` is an offset in UTF-16 code units into the pattern. `message` is a list of texts (fragments) that must all occur in the reason text, in order, each after the end of the one before. The reason text is the part of the error that says why the pattern was refused, in the error's own wording: not the index, not the echoed pattern and not the position marker, so an implementation exposes its reason separately from the rest of its message. Each field is given only where the original test asserted it, and an original assertion written as a regular expression is recorded as the literal fragments it requires, in order (`/anchor.*cannot be quantified/` is `["anchor", "cannot be quantified"]`). `{}` records a test that asserted only that the pattern is refused.

`regex-match`:

```json
{ "id": "...", "from": "...", "kind": "regex-match", "pattern": "^a$", "inputs": [ { "input": "a", "matches": true } ] }
```

Each input is tested against the pattern, through every entry point the implementation offers for testing a pattern (compiled once and reused, and compiled per call), and all of them must give `matches`.

The corpus pins answers, never time. A test that bounds how long a pattern takes stays in the implementation's own tests, next to the case that pins its answer, and a port keeps its own time-bound test.

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner, `cargo test` in `rust/` loads and checks every file). When a behaviour changes on purpose, change the case in the same commit as the code.
