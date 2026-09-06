# trilean-regex

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/trilean) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/trilean-regex) [![Release](https://img.shields.io/github/v/release/ExaDev/trilean?filter=trilean-regex@*&label=release)](https://github.com/ExaDev/trilean/releases?q=trilean-regex%40) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/trilean/ci.yml?branch=main)](https://github.com/ExaDev/trilean/actions)

A portable regular-expression grammar -- a true regular language, with its own parser and a Thompson-construction reference matcher -- so a pattern means the same thing wherever it runs: in process here, and pushed down to a database's own engine by [`trilean-sql`](../trilean-sql).

## Why a new grammar

ECMAScript's `RegExp` is not a regular language. Backreferences and lookaround make it strictly more expressive than a finite automaton can recognise, and its backtracking implementation can take exponential time on certain inputs (the well-known "catastrophic backtracking" failure mode). Worse for portability: every SQL engine's own regex support is a *different* language again -- PostgreSQL's POSIX ARE is close to ECMAScript but not identical, and SQLite/D1 have no built-in regex engine at all.

A pattern written in this package's grammar is different on both counts. It is restricted to constructs a finite automaton can express, so it always matches in linear time with no backtracking risk, and its reference matcher is guaranteed to agree with itself regardless of input. And because the grammar is deliberately small, a SQL dialect compiler can translate it structurally instead of trying to detect which subset of an open-ended ECMAScript pattern happens to be "safe" for that dialect -- see `trilean-sql`'s `portableMatches`/`portableNotMatches` compilers, which do exactly this for PostgreSQL and SQLite/D1.

## Grammar

Patterns are written with ordinary regex-like syntax so nothing new has to be learned, but only the constructs below are legal -- anything else is a parse error naming exactly where parsing failed, never a fuzzy runtime failure.

| Construct | Meaning |
|---|---|
| `a` | A literal character |
| `ab` | Concatenation: `a` then `b` |
| `a\|b` | Alternation: `a` or `b` |
| `a*` | Zero or more `a` |
| `a+` | One or more `a` |
| `a?` | Zero or one `a` |
| `a{3}` | Exactly 3 `a` |
| `a{2,}` | 2 or more `a` |
| `a{2,5}` | Between 2 and 5 `a`, inclusive |
| `.` | Any single character |
| `^` | Start of the input |
| `$` | End of the input |
| `[abc]` | Any one of `a`, `b`, `c` |
| `[a-z]` | Any character in the range `a` to `z` |
| `[^abc]` | Any character except `a`, `b`, `c` |
| `\d` `\D` | An ASCII digit (`0`-`9`), or its negation |
| `\w` `\W` | An ASCII word character (`A`-`Z`, `a`-`z`, `0`-`9`, `_`), or its negation |
| `\s` `\S` | An ASCII whitespace character (space, tab, `\n`, `\r`, `\f`, `\v`), or its negation |
| `(?:ab)` | A non-capturing group, for precedence and repetition |
| `\.` `\*` `\+` `\?` `\(` `\)` `\[` `\]` `\{` `\}` `\|` `\^` `\$` `\\` `\/` | An escaped metacharacter, matched literally |
| `\n` `\t` `\r` `\f` `\v` | A control character, matched literally |

Everything else the grammar deliberately excludes:

- **No capturing groups.** `(a)` is a parse error directing the author to `(?:a)` instead. There is nothing to capture: this grammar only ever answers whether a pattern matches, never what matched, so a capturing group would be pure syntax with no corresponding capability.
- **No backreferences** (`\1`), because they make the language context-sensitive rather than regular -- no finite automaton can recognise `(a+)\1`.
- **No lookaround** (`(?=...)`, `(?!...)`, `(?<=...)`, `(?<!...)`), for the same reason: lookaround assertions are not part of a regular language's own recognition power.
- **No lazy or possessive quantifiers** (`a*?`, `a*+`). These only change *which* substring a backtracking engine reports as the match; since this grammar only ever answers a yes/no membership question, greedy and lazy always agree on whether a match exists, so there is no behaviour left for either modifier to control. Stacking a second quantifier onto a first (`a**`, `a*+`, `a*{2}`) is therefore a parse error rather than being silently accepted as a no-op.
- **No flags** (case-insensitivity, multiline, dotAll). `^`/`$` always mean the absolute start/end of the whole input, never a line boundary, and `.` always matches any character including a line terminator -- there is no flag to make either mean something else, so there is nothing to configure.

## Character encoding

A character is a UTF-16 code unit, exactly matching `RegExp`'s own behaviour without the `u` flag: `String.prototype.charCodeAt`'s notion of one character, not a full Unicode scalar value. A character outside the Basic Multilingual Plane is two separate code units under `.`, a character class, or a shorthand class, the same as it would be against a non-`u`-flag native `RegExp`.

## Matching semantics

`testPattern`/`compilePattern(...).test(...)` report whether **any substring** of the input matches -- the same "search" semantics as a bare `RegExp.prototype.test()` call with no anchors, not a "does the whole string match" test. Anchor the pattern yourself (`^...$`) for a full-string match.

`^` and `$` can appear anywhere in the pattern -- inside a group, inside an alternation branch -- and always mean the absolute start/end of the whole input, evaluated at whatever position the automaton reaches them, not confined to the very start/end of the pattern text. `^a|z$` matches a string starting with `a`, or one ending with `z` (they are independent branches, each anchored on its own side only).

## Reference implementation

`parseRegex` is a hand-written recursive-descent parser producing a `RegexNode` AST -- the same AST `trilean-sql`'s dialect compilers pattern-match over to translate a pattern into `LIKE`/`GLOB`/`~` fragments, rather than each compiler re-parsing pattern text itself.

`compilePattern`/`compileToNfa` compile that AST to a non-deterministic finite automaton via Thompson's construction, and `matchesNfa` simulates it against an input with the standard "new thread at every position" search algorithm (Cox, ["Regular Expression Matching Can Be Simple And Fast"](https://swtch.com/~rsc/regexp/regexp1.html)). This is what makes the "no catastrophic backtracking" guarantee true by construction rather than merely by convention: simulating an NFA takes time linear in `pattern states x input length` regardless of the pattern's shape, so there is no input this package's own reference matcher can be made to hang on.

```ts
import { compilePattern, testPattern, parseRegex, RegexParseError } from "trilean-regex";

testPattern("^[\\w.]+@[\\w]+\\.[a-z]{2,}$", "person@example.com"); // true

const compiled = compilePattern("^ENA-\\d{4,6}$");
compiled.test("ENA-12345"); // true -- reuse the compiled pattern across many inputs
compiled.test("ENA-123");   // false

try {
  parseRegex("(a)");
} catch (error) {
  if (error instanceof RegexParseError) {
    // "invalid pattern at index 0: capturing groups are not supported..."
  }
}
```

## Design principles

- **A true regular language, not a documented subset of one.** Every construct this grammar accepts corresponds to something a finite automaton can express; nothing is included on the promise that "most engines happen to agree about it."
- **A real parser, not pattern validation.** `parseRegex` builds an AST via recursive descent, the same way a general-purpose parser would -- it does not check the input string against a meta-pattern and hope the input itself is then safe to hand to another regex engine.
- **No indeterminate outcome for a bad pattern here.** A pattern is grammatical or it is not; `parseRegex` throws `RegexParseError` for the latter, naming the exact index. (What a caller does with that error -- `trilean` core's `evaluator.ts` turns an invalid `portableMatches` pattern into `wrong-type`, matching how it already treats an invalid ECMAScript pattern under plain `matches` -- is that caller's decision, not this package's.)
- **Isomorphic.** No `node:*` import, no `Buffer`, in any runtime module -- enforced by this package's own `eslint.config.ts` isomorphism guard, the same convention `trilean` and `trilean-sql` both follow.
