## [2.0.9](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.8...trilean-regex%402.0.9) (2026-11-20)

### Build System

* **deps-dev:** bump eslint from 10.14.0 to 10.15.0 ([461b10d](https://github.com/ExaDev/trilean/commit/461b10d8d2b1280aad61663b9708e6783012299c))

## [2.0.8](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.7...trilean-regex%402.0.8) (2026-11-19)

### Build System

* **deps-dev:** bump prettier from 3.9.10 to 3.10.1 ([cbcb3ea](https://github.com/ExaDev/trilean/commit/cbcb3ea388f79c0209517e7b3787ce0648fe68ab))

## [2.0.7](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.6...trilean-regex%402.0.7) (2026-11-18)

### Build System

* **deps-dev:** bump @types/node from 26.6.5 to 26.6.6 ([1e23aa1](https://github.com/ExaDev/trilean/commit/1e23aa188b6ed42201a32a942ee16bcb23032e78))

## [2.0.6](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.5...trilean-regex%402.0.6) (2026-11-18)

### Build System

* **deps-dev:** bump turbo from 2.11.10 to 2.11.11 ([e9858c8](https://github.com/ExaDev/trilean/commit/e9858c82be475cb032953efab92678032ca87903))

## [2.0.5](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.4...trilean-regex%402.0.5) (2026-11-18)

### Build System

* **rust:** name the crates for crates.io and give each a version to publish at ([90e1cea](https://github.com/ExaDev/trilean/commit/90e1ceaa38f704bf545b4b88bcf07ddb7ea04957))

## [2.0.4](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.3...trilean-regex%402.0.4) (2026-11-17)

### Build System

* **deps-dev:** bump eslint-plugin-prettier from 5.5.6 to 5.5.7 ([65ab21a](https://github.com/ExaDev/trilean/commit/65ab21acaee54c5fd00906d399438971a45c4137))

## [2.0.3](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.2...trilean-regex%402.0.3) (2026-11-17)

### Build System

* **deps-dev:** bump typescript-eslint from 8.71.1 to 8.72.2 ([ae56b2e](https://github.com/ExaDev/trilean/commit/ae56b2efe0bd32470cb02800419394b87c503507))

## [2.0.2](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.1...trilean-regex%402.0.2) (2026-11-16)

### Build System

* **deps-dev:** bump @exadev/eslint-config from 3.0.0 to 3.1.0 ([8e12b3d](https://github.com/ExaDev/trilean/commit/8e12b3d91e08001262a0b3d41b4bef2ed9bacb5c))

## [2.0.1](https://github.com/ExaDev/trilean/compare/trilean-regex%402.0.0...trilean-regex%402.0.1) (2026-11-16)

### Tests

* apply the derived time limit to every test that reads the corpus and say what it guards ([4bd1e0d](https://github.com/ExaDev/trilean/commit/4bd1e0d05907f305626aed0b60eefddac71d21e6))

## [2.0.0](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.24...trilean-regex%402.0.0) (2026-11-15)

### ⚠ BREAKING CHANGES

* **trilean-regex:** a pattern longer than 400,000 UTF-16 code units is a RegexParseError, where it was
  read, and one of 150,000 or more atoms threw a RangeError from the wasm stack.
* **trilean-regex:** a test of an input over MAX_INPUT_UNITS, or over MAX_WORK for the pattern, throws
  RegexInputError, where it ran for as long as its work took.
* **trilean-regex:** the package is ES modules only (require() works through require(esm) from Node
  20.19 and 22.12), and only the entry point is exported. A negated shorthand class is accepted inside
  a character class. compileToNfa, matchesNfa, CompiledNfa and NfaState are no longer exported, since
  NFA states hold closures. CompiledPattern is a class with a test method. A pattern with groups
  nested more than 128 deep, or a repetition bound above 4294967295, is a RegexParseError.
  RegexParseError is built from the finished message, which only the package does.
* **trilean-regex:** the package is ES modules only and exports only its entry point: the main and
  module fields, the documented trilean-regex/errors subpath and every other subpath are gone, and
  require() works only through require(esm) from Node 20.19 and 22.12. Importing it in a browser
  fetches the module with top-level await, so a browser build needs a target that allows it; Node,
  Bun and Deno import the module from the package with no file read. The sideEffects field is
  removed. Its declarations need only the ES library, and Symbol.dispose is no longer declared. A
  pattern, subject or shorthand letter that is not a string is a TypeError. rangeContains and
  charClassMatches take code units. A negated shorthand class is accepted inside a class.
  compileToNfa, matchesNfa, CompiledNfa and NfaState are removed. CompiledPattern is a class with
  test and free. RegexParseError is built from its finished message and InternalError is added. A
  pattern with groups nested over 128 deep, a repetition bound over 4294967295 or more than 100000
  automaton states is a RegexParseError. Dependants whose CommonJS entries require this package fail
  with ERR_REQUIRE_ESM on Node before 20.19 and 22.12.
* **trilean-regex:** the text of five RegexParseError reasons changes: a spaced double hyphen becomes a
  colon in the reasons for a quantifier that is itself quantified, a capturing group, an unterminated
  character class, an empty character class and an unexpected character. Code that matches the old
  text must match the new.

### Features

* **trilean-regex:** carry the module in the package for Node, so a bundle needs nothing beside it ([dda1f7d](https://github.com/ExaDev/trilean/commit/dda1f7d4af796a06cded5f349a7450ab7d3d5425))
* **trilean-regex:** port the parser and matcher to a Rust crate ([be15f4f](https://github.com/ExaDev/trilean/commit/be15f4fc0b2fc6771960e65ab6b78f119e094f43))
* **trilean-regex:** refuse an input over a limit on its length or on the work it allows ([9edb2d2](https://github.com/ExaDev/trilean/commit/9edb2d23831a5cf10bece3e31d666542ab815aa7))
* **trilean-regex:** ship the wasm build under the existing package name ([200dc6c](https://github.com/ExaDev/trilean/commit/200dc6cec5c64b35f7b8eac3731d7df0f2c7814f))

### Bug Fixes

* **trilean-regex:** judge an ECMAScript class by the set it denotes and bound the automaton ([e5528b7](https://github.com/ExaDev/trilean/commit/e5528b7e874101b8d1783f8d1b967850f4634519))
* **trilean-regex:** make the package work under every bundler, and say what it needs ([1f6a7ee](https://github.com/ExaDev/trilean/commit/1f6a7eeafef173c9ab13d1b20e5f5448bd85e9bc))
* **trilean-regex:** refuse a pattern by its length before it is read ([01df26e](https://github.com/ExaDev/trilean/commit/01df26e7c7ecd006170d324887db2bf236746977))
* **trilean-regex:** write the parser's messages without a spaced double hyphen ([4d1c2a0](https://github.com/ExaDev/trilean/commit/4d1c2a0211401dcdc22c5609292059a199fc66f2))

### Code Refactoring

* **trilean-regex:** decide range membership in the crate, not in the binding ([8a9fc13](https://github.com/ExaDev/trilean/commit/8a9fc134f37c13ecadd629a866845efb89ddcca0))

### Documentation

* **trilean-regex:** say what MAX_PATTERN_UNITS bounds and that the state limit is per pattern ([58c2c71](https://github.com/ExaDev/trilean/commit/58c2c71a33f252ec3b4653aa03cf930ddd2bca09))

### Tests

* **trilean-regex:** build the consumer with Vite and with esbuild for the browser too ([275e6c0](https://github.com/ExaDev/trilean/commit/275e6c0bb2e1b9567f25e2d9ab3c54771aab0727))
* **trilean-regex:** derive the state limit from a state's size, restore recorded sources ([c45c824](https://github.com/ExaDev/trilean/commit/c45c824415f66dcecb03fc7c3c8d2f9395f15b34))
* **trilean-regex:** give the differential against RegExp the time its work needs ([b67a015](https://github.com/ExaDev/trilean/commit/b67a01520fb1f4d5c94f2f2e875c685645ad0f48))

### Build System

* **trilean-regex:** bring the port into line with the corpus and the workspace on main ([209317d](https://github.com/ExaDev/trilean/commit/209317dfa3a688c59e9a80223549f692ecfe0a75))
* **trilean-regex:** print the sizes, and build a copy with the test hooks for the tests ([c70689d](https://github.com/ExaDev/trilean/commit/c70689dfaa5acfcff46cb2ce558c4fad3c5cd2bd))

## [1.0.24](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.23...trilean-regex%401.0.24) (2026-11-14)

### Tests

* check key order, list skips per implementation and count what runs ([8009d18](https://github.com/ExaDev/trilean/commit/8009d1863e17165834c52d35d9522c1645ccddce))

## [1.0.23](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.22...trilean-regex%401.0.23) (2026-11-14)

### Tests

* define the tolerance and the number forms the corpus runner reads exactly ([83221f8](https://github.com/ExaDev/trilean/commit/83221f8a9cbc053c1bc5c5d10e00818dc70f9194))
* generate the derived-pattern, serialisation and number-format cases ([bbff0a6](https://github.com/ExaDev/trilean/commit/bbff0a690ee83a0627fb8c5942f73b682b25e892))
* let a case state only what its original did, and give it the original's tolerance ([b9ff906](https://github.com/ExaDev/trilean/commit/b9ff90674b2a0817b641b889e4f9467b75e7f04e))
* rename the corpus field only to skip ([f23539c](https://github.com/ExaDev/trilean/commit/f23539cd79ac2d6d1c2c7b544cfb77b8c409df22))
* run the trilean validate and evaluate cases from the corpus ([b84ad79](https://github.com/ExaDev/trilean/commit/b84ad791c9ef0c0fabb46fbbbc9f2901d4826408))

## [1.0.22](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.21...trilean-regex%401.0.22) (2026-11-14)

### Build System

* **deps-dev:** bump globals from 17.13.0 to 17.14.0 ([eb6c14c](https://github.com/ExaDev/trilean/commit/eb6c14c7d288e5720091e69bf9755f4904007e45))

## [1.0.21](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.20...trilean-regex%401.0.21) (2026-11-14)

### Build System

* **deps-dev:** bump eslint from 10.12.0 to 10.14.0 ([168c02f](https://github.com/ExaDev/trilean/commit/168c02f204df728993276e41d49d93df8c1410cd))

## [1.0.20](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.19...trilean-regex%401.0.20) (2026-11-14)

### Build System

* **deps-dev:** bump tsdown from 0.23.1 to 0.23.7 ([c6dff80](https://github.com/ExaDev/trilean/commit/c6dff80acd570af68b21e37e63e554a062f028c5))

## [1.0.19](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.18...trilean-regex%401.0.19) (2026-11-14)

### Build System

* **deps-dev:** bump turbo from 2.11.7 to 2.11.10 ([96252a2](https://github.com/ExaDev/trilean/commit/96252a2a2f26e06152e693a4e124984725f18b82))

## [1.0.18](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.17...trilean-regex%401.0.18) (2026-11-14)

### Build System

* **deps-dev:** bump vitest from 5.0.3 to 5.1.0 ([db070e6](https://github.com/ExaDev/trilean/commit/db070e6ec2e305440ff08c71925d84119458513b))

## [1.0.17](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.16...trilean-regex%401.0.17) (2026-11-14)

### Tests

* count completeness per implementation and tighten what a corpus file may be ([d814c7e](https://github.com/ExaDev/trilean/commit/d814c7e867f6a51c342a255c31335b44eae62ea6))
* make corpus text, numbers and the only axis mean the same in every loader ([396adfa](https://github.com/ExaDev/trilean/commit/396adfa0b04b52529696782465aedc94d1bf8d4b))
* run the trilean-regex parser and matcher cases from the conformance corpus ([0b93d41](https://github.com/ExaDev/trilean/commit/0b93d411a604004ea07cb9d072892a2cfcf3427f))
* tie every negative fixture to its rule with a repaired twin ([2d30bc8](https://github.com/ExaDev/trilean/commit/2d30bc897f64bc228a22b18ec13a0dfd42ad1a91))
* validate the corpus with its schema and run every loader by one rule ([0f6bec9](https://github.com/ExaDev/trilean/commit/0f6bec9e155ef101e5595b1f1fe66daa2662ba36))

### Build System

* rerun only trilean-regex tests when the corpus changes ([01782cc](https://github.com/ExaDev/trilean/commit/01782ccb8c152d09f056561d6eb3ef509db359cb))

## [1.0.16](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.15...trilean-regex%401.0.16) (2026-10-20)

### Build System

* **deps-dev:** bump tsdown from 0.23.0 to 0.23.1 ([385f1eb](https://github.com/ExaDev/trilean/commit/385f1eb6bfa20ceb2f2146e516b539115058db5f))

## [1.0.15](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.14...trilean-regex%401.0.15) (2026-10-19)

### Build System

* **deps-dev:** bump @vitest/coverage-v8 from 5.0.3 to 5.0.4 ([785f632](https://github.com/ExaDev/trilean/commit/785f63285b60267475e1dae59586a16fed5292b4))

## [1.0.14](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.13...trilean-regex%401.0.14) (2026-10-19)

### Build System

* **deps-dev:** bump prettier from 3.9.9 to 3.9.10 ([0ac3568](https://github.com/ExaDev/trilean/commit/0ac356872e50eb232c4e6fa05f8a173da7d75789))

## [1.0.13](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.12...trilean-regex%401.0.13) (2026-10-16)

### Build System

* **deps-dev:** bump @types/node from 26.6.4 to 26.6.5 ([cce1ab0](https://github.com/ExaDev/trilean/commit/cce1ab00708c92b8735d6390bb111b63f0e8feb9))

## [1.0.12](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.11...trilean-regex%401.0.12) (2026-10-15)

### Build System

* **deps-dev:** bump globals from 17.12.0 to 17.13.0 ([be14668](https://github.com/ExaDev/trilean/commit/be146680e59f84cac71afbc0122838fe0fbf863a))

## [1.0.11](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.10...trilean-regex%401.0.11) (2026-10-14)

### Build System

* **deps-dev:** bump typescript-eslint from 8.69.0 to 8.71.1 ([7012530](https://github.com/ExaDev/trilean/commit/70125300f7cf1616d978379cf44e005f72a0ecab))

## [1.0.10](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.9...trilean-regex%401.0.10) (2026-10-14)

### Build System

* **deps-dev:** bump @types/node from 26.4.1 to 26.6.4 ([37da38a](https://github.com/ExaDev/trilean/commit/37da38abbf1a3f009a294246632c0f937e8e1462))

## [1.0.9](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.8...trilean-regex%401.0.9) (2026-10-14)

### Build System

* **deps-dev:** bump prettier from 3.9.6 to 3.9.9 ([1f6e880](https://github.com/ExaDev/trilean/commit/1f6e8809ea1a44d7dcdf6f945669e272f6cafd3b))

## [1.0.8](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.7...trilean-regex%401.0.8) (2026-10-14)

### Build System

* **deps-dev:** bump turbo from 2.10.12 to 2.11.7 ([2d1d052](https://github.com/ExaDev/trilean/commit/2d1d052c1915e4b7ac0fc492adeaa8ae7e58da49))

## [1.0.7](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.6...trilean-regex%401.0.7) (2026-10-14)

### Build System

* **deps-dev:** bump eslint from 10.9.1 to 10.12.0 ([1a69cf8](https://github.com/ExaDev/trilean/commit/1a69cf884a8097faa52cde6758b57274bed92a6d))

## [1.0.6](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.5...trilean-regex%401.0.6) (2026-10-14)

### Build System

* **deps-dev:** bump publint from 0.3.24 to 0.3.25 ([b3fce10](https://github.com/ExaDev/trilean/commit/b3fce100b706432c123dc52386df3fd5ac2770d2))

## [1.0.5](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.4...trilean-regex%401.0.5) (2026-10-10)

### Build System

* **deps-dev:** move to vitest 5, the Workers plugin and canonicalize 5 ([f2274a4](https://github.com/ExaDev/trilean/commit/f2274a4a6f9b2fe13cc6ec1754190aedc041e8b3))

## [1.0.4](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.3...trilean-regex%401.0.4) (2026-10-10)

### Styles

* order JSON object keys alphanumerically ([e844e15](https://github.com/ExaDev/trilean/commit/e844e1591041da73e80759cabf36c6cbfe4f24ae))
* separate statements and place comments as the shared config's rules require ([8e9130c](https://github.com/ExaDev/trilean/commit/8e9130cb8decd13348c47cbec9c51494d05c625a))

### Tests

* name each test file's kind in its filename ([025168e](https://github.com/ExaDev/trilean/commit/025168ede453a4a2e8a81790e48eb8035cef6d17))

### Build System

* **deps:** bump @exadev/eslint-config to 3.0.0 ([26722f6](https://github.com/ExaDev/trilean/commit/26722f683faa6fa5abb6177f27b47d4d773f214f))

## [1.0.3](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.2...trilean-regex%401.0.3) (2026-09-19)

### Build System

* **deps-dev:** bump tsdown from 0.22.14 to 0.23.0 ([b625cad](https://github.com/ExaDev/trilean/commit/b625cad7c7f59bd67076bef78976652035e830bf))
* **deps-dev:** bump vitest to 5.0.1 in trilean-regex and trilean-sql ([d578062](https://github.com/ExaDev/trilean/commit/d578062867d7d0064acc4b988b4ddb9658f3ca77))

## [1.0.2](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.1...trilean-regex%401.0.2) (2026-09-14)

### Bug Fixes

* use backticks instead of JSDoc-style braces on [@throws](https://github.com/throws) tags ([b1e8213](https://github.com/ExaDev/trilean/commit/b1e82139ed9afb23a1cf16ab8899d4d3e5ec6780))

### Miscellaneous Chores

* **deps:** pin @exadev/eslint-config to 2.12.1 across the workspace ([b8a548f](https://github.com/ExaDev/trilean/commit/b8a548f5c75eac7f26491c74d7add6fd72e5ce7f))

## [1.0.1](https://github.com/ExaDev/trilean/compare/trilean-regex%401.0.0...trilean-regex%401.0.1) (2026-09-06)

### Documentation

* scope each package README's release badge to its own tag ([c8cb954](https://github.com/ExaDev/trilean/commit/c8cb95459799faec8acd01e8ed0e171a37227ddc))

## 1.0.0 (2026-09-06)

### Features

* **trilean-regex:** add a portable regular-expression grammar and reference matcher ([a41288e](https://github.com/ExaDev/trilean/commit/a41288ee4e9ed0655ae9ca40c7bf2e7f56eb2d15))
