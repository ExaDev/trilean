# trilean-json-shape-pattern

The pattern grammar of [`trilean-json-shape`](https://crates.io/crates/trilean-json-shape): the subset of ECMAScript regular expressions that every JSON Schema validator reads alike, compiled to an automaton that matches in time linear in the text. The derive refuses an unsupported pattern at compile time with it and the validator matches with it, so the two cannot disagree about which patterns exist.

Part of [trilean](https://github.com/ExaDev/trilean).

MIT licensed.
