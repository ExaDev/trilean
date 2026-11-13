# Conformance corpus

Language-neutral cases that pin the behaviour of the trilean packages. Every implementation of a package (the TypeScript source, the native Rust crates and the wasm builds) runs the same cases, so a port is correct when it passes what the original passes.

## Layout

```
conformance/
  README.md            this file
  case.schema.json     JSON Schema of a corpus file
  <package>/<area>/<name>.json
```

The files are canonical JSON, which the repository's lint requires: keys sorted, two-space indent, one element per line. Running `pnpm lint` rewrites a file into that form, so the examples below show the fields in reading order and the files do not. A corpus file holds `{ "cases": [...] }` and takes its name from the test file it was extracted from (`parse/parser.json` from `parser.unit.test.ts`). The directory under the package names the case kind it holds. A directory called `fixtures` or `schema` holds data that cases refer to, not cases, and is not loaded as a corpus file.

## Cases

Every case has:

- `id`: unique across the whole corpus.
- `from`: the original test title the case came from, as `<test file>: <describe> > <test>`, so a failure points back to the behaviour it pinned. A case written for the corpus says what it pins instead.
- `kind`: selects the shape below.
- `only`, optional: `js` for a case the native crates skip, `native` for a case the JavaScript runners skip. A case one side cannot express carries it; nothing else does.
- `tolerance`, optional: `{ "ulps": n }`. Numbers compare exactly (`-0` included) unless a case gives one.

A case comes from an existing test, with the same inputs and the same expectation. Messages are compared only where the original test asserted one, and then as a substring the message must contain, so a port is free to word the rest. An original assertion written as a regular expression is recorded as the literal text it requires.

`case.schema.json` is the full format, including the kinds later packages use. A runner validates every file it loads before running anything, and a file that does not match is a failure, not a skip.

### trilean-regex

`regex-parse`:

```json
{ "id": "...", "from": "...", "kind": "regex-parse", "pattern": "a{2,}", "expect": { "ast": { "kind": "repeat", "operand": { "kind": "literal", "codeUnit": 97 }, "min": 2 } } }
```

`expect` is one of:

- `{ "ast": <node> }`: the parsed tree equals the node. Field names are those of the package's AST. An unbounded `repeat` omits `max`, since JSON has no `undefined`.
- `{ "astSubset": <partial node> }`: for a test that asserted only some fields of the tree. An object matches when every key it gives matches; an array matches element by element and has the same length; any other value must be equal.
- `{ "error": { "index"?, "message"? } }`: the pattern is refused with a parse error. `index` is an offset in UTF-16 code units into the pattern, and `message` is a substring of the error's message. Each is given only where the original test asserted it.

`regex-match`:

```json
{ "id": "...", "from": "...", "kind": "regex-match", "pattern": "^a$", "inputs": [ { "input": "a", "matches": true } ] }
```

Each input is tested against the pattern, through every entry point the implementation offers for testing a pattern (compiled once and reused, and compiled per call), and all of them must give `matches`.

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, and run the corpus (`pnpm test` runs the TypeScript runner, `cargo test` in `rust/` loads and checks every file). When a behaviour changes on purpose, change the case in the same commit as the code.
