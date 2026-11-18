# trilean-json-shape

One Rust definition of a JSON shape that validates documents and writes the JSON Schema and TypeScript declarations for them, so the three cannot disagree. A type derives `Shape` (from [`trilean-json-shape-derive`](https://crates.io/crates/trilean-json-shape-derive)), reading the serde attributes it already carries; deserialising through serde is validating, with the path of every problem.

Part of [trilean](https://github.com/ExaDev/trilean), whose trees are defined with it.

MIT licensed.
