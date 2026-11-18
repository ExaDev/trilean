# trilean-eval

The Rust crate of [trilean](https://github.com/ExaDev/trilean): the predicate and expression trees, computed values and indeterminate reasons, each one type that reads and validates a JSON document, and `evaluate`, the three-valued evaluator of those trees. A tree evaluates to true, false or indeterminate against resolvers the caller supplies, and a data problem is an indeterminate result, never an error.

The [`trilean`](https://www.npmjs.com/package/trilean) npm package is built from this crate as WebAssembly, so both have one definition of a tree and one set of evaluation rules, checked against the same language-neutral conformance corpus. The crate does no I/O and builds for `wasm32-unknown-unknown`.

MIT licensed.
