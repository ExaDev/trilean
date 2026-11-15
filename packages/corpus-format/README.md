# @exadev/corpus-format

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/trilean) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/@exadev/corpus-format)

The format of a language-neutral conformance corpus, as one wasm build that the Rust and the JavaScript runners of a corpus share, so the two read the same files the same way. It is the core of every JavaScript runner of the corpus in [`conformance/`](https://github.com/ExaDev/trilean/tree/main/conformance), and the Rust crate [`corpus-format`](https://github.com/ExaDev/trilean/tree/main/rust/crates/corpus-format) is the same code used natively.

It holds what every corpus shares and no case kind: which files are corpus files, the one byte form a file has, the closed set of encodings for what JSON cannot hold, the manifest and what a run is checked against it with, and how an expectation is compared with a result. It holds no executor, no call table and no schema of a kind.

## API

Documents cross as the JSON text they are and files as the bytes they are, so a rule about the exact text (canonical bytes, a repeated key, an unpaired surrogate) is applied to that text and never to a parsed copy.

| Export | What it does |
|---|---|
| `select(entries, depth)` | Which entries of a tree are corpus files (`<package>/<area>/<name>.json` at `depth` 2), by one rule: dot names ignored, `fixtures`, `schema` and `runner` skipped at any depth, names of lower-case ASCII, UTF-16 order, the roots' own files known. Anything else is a problem. |
| `checkCanonical(bytes)` | The first thing that keeps a file from being canonical, or `undefined`. Canonical is exactly what `writeCanonical` writes: UTF-8 without a byte order mark, keys in UTF-16 code-unit order without a repeat, two-space indent, one element per line, shortest number form (`97.0`, `1e2` and `-0` are refused as bytes), only the escapes JSON requires, no unpaired surrogate, nesting of at most 64 levels. |
| `keyProblems(bytes)` | Every content problem of a document, in the order found. |
| `writeCanonical(json)` | The canonical text of a JSON document. A document nested deeper than the 64 levels `checkCanonical` reads is refused with a `CorpusFormatError`. |
| `decode(json)` | The value a document's encodings stand for: `{ "$number": "-0" \| "Infinity" \| "-Infinity" \| "NaN" }`, `{ "$undefined": true }`, `{ "$object": [[name, value], ...] }` (members in the order given, no repeated or integer-like name) and `{ "codeUnits": [...] }` (a text by its UTF-16 code units). The set is closed: any other `$` member, or an encoding with another member beside it, throws a `DecodeError`. |
| `compare(actual, expected, tolerance?)`, `subset(actual, expected, tolerance?)` | Where two values differ, or `undefined`. Numbers are the same double (`-0` is not `0`, NaN is NaN) unless a tolerance (`{ ulps }` or `{ absolute }`) is given; a member of `actual` that is `undefined` counts as absent. |
| `fragments(text, fragments, ignoreAsciiCase)` | Why the fragments do not occur in `text` in order, each after the end of the one before, or `undefined`. |
| `manifestProblems(corpus, manifest, depth)` | Everything wrong between the corpus as read and the manifest document, whose files are `depth` directories down. The manifest is read as a canonical document, so a member given twice is refused and not merged. |
| `new Completeness(prefix?)` | A run's record, made as the run goes (`register`, `started`, `skipped`), compared with the manifest by `finish(manifest, "ts" \| "rust", provides, depth)`, which returns the problems: it fails a run that drops a registration, starts a case twice, skips a case it never registered or skips one the manifest does not list. |

Text is compared as UTF-16 code units, so an unpaired surrogate is kept as it is.

## Using it

An ES module for Node 20.19, 22.12 or later, Bun, Deno, browsers and Cloudflare Workers. In Node, Bun and Deno the module is inlined (base64, decoded once), so importing the package reads no file and a bundle of it for a server is one file. A browser entry starts the module with a top-level `await` on a `new URL("./corpus_format_bg.wasm", import.meta.url)`, which Vite, Rolldown, webpack 5 and Parcel rewrite as an asset; esbuild needs its `file` loader for `.wasm`. Browser output must be ES modules for an ES2022 target or later (webpack 5.83, esbuild `--target=es2022 --format=esm`); IIFE and CommonJS browser output are not supported.

`Completeness` owns memory in the module. A finaliser frees it once the event loop yields, and `free()` (or `using`) frees it at once; `free()` is safe to call twice. Wasm memory never shrinks, so code that creates many in a loop, or a long-lived process, calls `free()`.
