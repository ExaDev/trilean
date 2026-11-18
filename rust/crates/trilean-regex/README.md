# trilean-regex

A portable regular-expression grammar over UTF-16 code units, with a Thompson-construction matcher that never backtracks. The grammar is a true regular language, so a pattern means the same wherever it is compiled to: here, in a database's own engine, or in an ECMAScript `RegExp` when `compile_ecmascript_subset` accepts it.

The [`trilean-regex`](https://www.npmjs.com/package/trilean-regex) npm package is built from this crate as WebAssembly. Part of [trilean](https://github.com/ExaDev/trilean).

MIT licensed.
