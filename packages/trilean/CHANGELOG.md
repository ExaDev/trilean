## [1.10.1](https://github.com/ExaDev/trilean/compare/trilean%401.10.0...trilean%401.10.1) (2026-10-20)

### Build System

* **deps-dev:** bump tsdown from 0.23.0 to 0.23.1 ([385f1eb](https://github.com/ExaDev/trilean/commit/385f1eb6bfa20ceb2f2146e516b539115058db5f))


### Dependencies

- Updated trilean-regex to 1.0.16

## [1.10.0](https://github.com/ExaDev/trilean/compare/trilean%401.9.2...trilean%401.10.0) (2026-10-20)

### Features

* **builtins:** add complex squareRoot, exponential, logarithm and trigonometry ([143576d](https://github.com/ExaDev/trilean/commit/143576dd388d70c98a364dfaad19a820da4e5705))

## [1.9.2](https://github.com/ExaDev/trilean/compare/trilean%401.9.1...trilean%401.9.2) (2026-10-19)

### Build System

* **deps-dev:** bump @vitest/coverage-v8 from 5.0.3 to 5.0.4 ([785f632](https://github.com/ExaDev/trilean/commit/785f63285b60267475e1dae59586a16fed5292b4))


### Dependencies

- Updated trilean-regex to 1.0.15

## [1.9.1](https://github.com/ExaDev/trilean/compare/trilean%401.9.0...trilean%401.9.1) (2026-10-19)

### Build System

* **deps-dev:** bump prettier from 3.9.9 to 3.9.10 ([0ac3568](https://github.com/ExaDev/trilean/commit/0ac356872e50eb232c4e6fa05f8a173da7d75789))


### Dependencies

- Updated trilean-regex to 1.0.14

## [1.9.0](https://github.com/ExaDev/trilean/compare/trilean%401.8.0...trilean%401.9.0) (2026-10-17)

### Features

* **trilean:** add magnitude and phase to the built-in functions ([4091e00](https://github.com/ExaDev/trilean/commit/4091e004e1f0467824b6a21daddf26bfabcd59a5))
* **trilean:** let the command raise the node budget for a long list ([5ea3362](https://github.com/ExaDev/trilean/commit/5ea3362df6b005f478317b6b35925dea969451a7))
* **trilean:** take lists of items from the command's inputs for fold, some and every ([7064d5f](https://github.com/ExaDev/trilean/commit/7064d5f156afe964f5d2bb742ae990f084888d61))

### Bug Fixes

* **trilean:** export InputItem from the package entry point ([735e6d7](https://github.com/ExaDev/trilean/commit/735e6d797008bee3fc81453806ffa495cafaf435))
* **trilean:** give phase one range regardless of the sign of a zero ([e3f5987](https://github.com/ExaDev/trilean/commit/e3f5987a434fec61ea0bd6b10f4055257bbcabba))
* **trilean:** scope a reference to the item the resolver handed out ([18f5083](https://github.com/ExaDev/trilean/commit/18f50834c8a1bf3e52d4050308d8fcf2bae042f6))

### Documentation

* **trilean:** say the node limit is also the guard against a hostile tree ([13ddcba](https://github.com/ExaDev/trilean/commit/13ddcbae8342d495e31694aaa714723d01abe74a))
* **trilean:** state the phase range as closed and correct the atan2 claim ([dada9d5](https://github.com/ExaDev/trilean/commit/dada9d547e6383564186a76cbf2e06ae52aa1b78))
* **trilean:** state what scoping a list of items guarantees ([414f7db](https://github.com/ExaDev/trilean/commit/414f7dbf022378b93f9a49f8e41afccb0fecadc3))
* **trilean:** write a decimal fraction with a point in a test comment ([cd8fad9](https://github.com/ExaDev/trilean/commit/cd8fad965ce9887101cbdc2370c84a7f743e9adb))

### Tests

* **trilean:** derive the budget in the command's tests and make them able to fail ([ea39012](https://github.com/ExaDev/trilean/commit/ea39012d10a8b27692148e65d1a14e7e380539bb))

## [1.8.0](https://github.com/ExaDev/trilean/compare/trilean%401.7.12...trilean%401.8.0) (2026-10-17)

### Features

* **trilean:** add a trilean command that evaluates a JSON formula tree ([ca48b4a](https://github.com/ExaDev/trilean/commit/ca48b4a087bed3a34ab7208c9e05623443b14497))
* **trilean:** add built-in numeric functions and a named-input evaluation entry point ([6f4b570](https://github.com/ExaDev/trilean/commit/6f4b5703963b82d5a2af0847c1c8ad1f2ff02b9c))
* **trilean:** let a registered function report a wrong-type argument ([e8b22a5](https://github.com/ExaDev/trilean/commit/e8b22a5263c3b0fac3e3560053a7ec19f0f39ed5))

### Bug Fixes

* **trilean:** compare durations exactly for every pair of finite values ([1d2ee78](https://github.com/ExaDev/trilean/commit/1d2ee784163874c8b5ed7e7ba735cdbf0870f3e1))
* **trilean:** compare durations without converting through milliseconds ([171e296](https://github.com/ExaDev/trilean/commit/171e29645081e4f7eeaeb55f503751cb90d258d4))
* **trilean:** divide complex values correctly across the whole double range ([6446de4](https://github.com/ExaDev/trilean/commit/6446de4ebabb7c497e5083335df8c6f9ec2caed8))
* **trilean:** divide complex values without overflowing or underflowing ([029bc6f](https://github.com/ExaDev/trilean/commit/029bc6fe9a83774f8cbe8680c7ef5e162f12d835))
* **trilean:** divide complex values without rounding a subnormal quotient twice ([ae57153](https://github.com/ExaDev/trilean/commit/ae57153efe46352f6a5282ad2005684f78d4947e))
* **trilean:** give evaluateDocument distinct outcomes and let the command word its own flags ([5e03a8a](https://github.com/ExaDev/trilean/commit/5e03a8af49a6890503c5be6b9d473f990463a53e))
* **trilean:** invert a negative complex power last unless it overflows ([84bcd30](https://github.com/ExaDev/trilean/commit/84bcd309b102d457d181f0fc8a965f482ba7aeca))
* **trilean:** make the built-in functions report accurate failures and round exactly ([cf53695](https://github.com/ExaDev/trilean/commit/cf53695335e66270b6f06574f9d5ea1f7fbca908))
* **trilean:** order durations that are not finite as numbers are ([a754efb](https://github.com/ExaDev/trilean/commit/a754efbf46a5657fc2526ec3f05728cf4d339fa7))
* **trilean:** raise complex values to an integer power by squaring ([d1258df](https://github.com/ExaDev/trilean/commit/d1258df90fb474a83de3e546361a72dee45e7ec1))
* **trilean:** refuse a non-finite input number and share one record guard ([6334608](https://github.com/ExaDev/trilean/commit/6334608a36841e2e78c8f644fc43dc93de01351c))
* **trilean:** refuse a non-representable result at the evaluateDocument boundary ([a3b82bb](https://github.com/ExaDev/trilean/commit/a3b82bb3b5617438b1750e23c58bc25c9d5b431f))
* **trilean:** report an overflowing arithmetic result as a domain error ([00c01db](https://github.com/ExaDev/trilean/commit/00c01dbde0f51c692d4059372a25a03fd3cc2c51))
* **trilean:** tighten the command's stdin, stderr and exit-status behaviour ([d8e4a07](https://github.com/ExaDev/trilean/commit/d8e4a0716a05f2c329cf1d1b279caac4d85a98c5))

### Documentation

* **trilean:** reword two comments written with a spaced double hyphen ([d6ccabf](https://github.com/ExaDev/trilean/commit/d6ccabf2d2a0374b9256e0a979bf951385b4b5b7))
* **trilean:** state how the error of squaring grows with the exponent ([093a669](https://github.com/ExaDev/trilean/commit/093a669ee10f11cca27efdac2ed72be11802086e))
* **trilean:** state the complex power error as an observation from samples ([d1b8a97](https://github.com/ExaDev/trilean/commit/d1b8a9773fca26e8c12a8f44152e5e74f953f477))
* **trilean:** state the direction of the division scale factor and its limits ([b01ee4e](https://github.com/ExaDev/trilean/commit/b01ee4ed6526b1a05b85fd5de8a44cff9f40b0c7))
* **trilean:** state the unrepresentable outcome in terms that stay true ([ac14285](https://github.com/ExaDev/trilean/commit/ac142859701e3c2dad3b524951fd0c843d8bc1dd))

### Tests

* **trilean:** cover non-finite arguments to the built-in functions ([40b4cf3](https://github.com/ExaDev/trilean/commit/40b4cf3c18bed4048acb1262a5bcca9f0df67939))

## [1.7.12](https://github.com/ExaDev/trilean/compare/trilean%401.7.11...trilean%401.7.12) (2026-10-16)

### Build System

* **deps-dev:** bump @types/node from 26.6.4 to 26.6.5 ([cce1ab0](https://github.com/ExaDev/trilean/commit/cce1ab00708c92b8735d6390bb111b63f0e8feb9))


### Dependencies

- Updated trilean-regex to 1.0.13

## [1.7.11](https://github.com/ExaDev/trilean/compare/trilean%401.7.10...trilean%401.7.11) (2026-10-15)

### Build System

* **deps-dev:** bump globals from 17.12.0 to 17.13.0 ([be14668](https://github.com/ExaDev/trilean/commit/be146680e59f84cac71afbc0122838fe0fbf863a))


### Dependencies

- Updated trilean-regex to 1.0.12

## [1.7.10](https://github.com/ExaDev/trilean/compare/trilean%401.7.9...trilean%401.7.10) (2026-10-15)

### Build System

* **deps-dev:** bump tsx from 4.23.13 to 4.23.15 ([b66ebdb](https://github.com/ExaDev/trilean/commit/b66ebdbc6967149dbec1362c5014754684233b39))

## [1.7.9](https://github.com/ExaDev/trilean/compare/trilean%401.7.8...trilean%401.7.9) (2026-10-14)

### Build System

* **deps-dev:** bump typescript-eslint from 8.69.0 to 8.71.1 ([7012530](https://github.com/ExaDev/trilean/commit/70125300f7cf1616d978379cf44e005f72a0ecab))


### Dependencies

- Updated trilean-regex to 1.0.11

## [1.7.8](https://github.com/ExaDev/trilean/compare/trilean%401.7.7...trilean%401.7.8) (2026-10-14)

### Build System

* **deps-dev:** bump @types/node from 26.4.1 to 26.6.4 ([37da38a](https://github.com/ExaDev/trilean/commit/37da38abbf1a3f009a294246632c0f937e8e1462))
* **deps:** bump zod from 4.5.4 to 4.6.5 ([a6e8823](https://github.com/ExaDev/trilean/commit/a6e8823cbc63b7b8b0bfb7bcaddc208720a9a6e5))


### Dependencies

- Updated trilean-regex to 1.0.10

## [1.7.7](https://github.com/ExaDev/trilean/compare/trilean%401.7.6...trilean%401.7.7) (2026-10-14)

### Build System

* **deps-dev:** bump prettier from 3.9.6 to 3.9.9 ([1f6e880](https://github.com/ExaDev/trilean/commit/1f6e8809ea1a44d7dcdf6f945669e272f6cafd3b))


### Dependencies

- Updated trilean-regex to 1.0.9

## [1.7.6](https://github.com/ExaDev/trilean/compare/trilean%401.7.5...trilean%401.7.6) (2026-10-14)

### Build System

* **deps-dev:** bump turbo from 2.10.12 to 2.11.7 ([2d1d052](https://github.com/ExaDev/trilean/commit/2d1d052c1915e4b7ac0fc492adeaa8ae7e58da49))


### Dependencies

- Updated trilean-regex to 1.0.8

## [1.7.5](https://github.com/ExaDev/trilean/compare/trilean%401.7.4...trilean%401.7.5) (2026-10-14)

### Build System

* **deps-dev:** bump eslint from 10.9.1 to 10.12.0 ([1a69cf8](https://github.com/ExaDev/trilean/commit/1a69cf884a8097faa52cde6758b57274bed92a6d))


### Dependencies

- Updated trilean-regex to 1.0.7

## [1.7.4](https://github.com/ExaDev/trilean/compare/trilean%401.7.3...trilean%401.7.4) (2026-10-14)

### Build System

* **deps-dev:** bump publint from 0.3.24 to 0.3.25 ([b3fce10](https://github.com/ExaDev/trilean/commit/b3fce100b706432c123dc52386df3fd5ac2770d2))


### Dependencies

- Updated trilean-regex to 1.0.6

## [1.7.3](https://github.com/ExaDev/trilean/compare/trilean%401.7.2...trilean%401.7.3) (2026-10-10)

### Build System

* **deps-dev:** move to vitest 5, the Workers plugin and canonicalize 5 ([f2274a4](https://github.com/ExaDev/trilean/commit/f2274a4a6f9b2fe13cc6ec1754190aedc041e8b3))


### Dependencies

- Updated trilean-regex to 1.0.5

## [1.7.2](https://github.com/ExaDev/trilean/compare/trilean%401.7.1...trilean%401.7.2) (2026-10-10)

### Styles

* order JSON object keys alphanumerically ([e844e15](https://github.com/ExaDev/trilean/commit/e844e1591041da73e80759cabf36c6cbfe4f24ae))
* separate statements and place comments as the shared config's rules require ([8e9130c](https://github.com/ExaDev/trilean/commit/8e9130cb8decd13348c47cbec9c51494d05c625a))

### Tests

* name each test file's kind in its filename ([025168e](https://github.com/ExaDev/trilean/commit/025168ede453a4a2e8a81790e48eb8035cef6d17))

### Build System

* **deps:** bump @exadev/eslint-config to 3.0.0 ([26722f6](https://github.com/ExaDev/trilean/commit/26722f683faa6fa5abb6177f27b47d4d773f214f))


### Dependencies

- Updated trilean-regex to 1.0.4

## [1.7.1](https://github.com/ExaDev/trilean/compare/trilean%401.7.0...trilean%401.7.1) (2026-09-29)

### Tests

* guard the declaration shape that keeps tree schemas re-exportable ([e64ff50](https://github.com/ExaDev/trilean/commit/e64ff5070b4be69bf2323e908470ba01db7ddfe4))

## [1.7.0](https://github.com/ExaDev/trilean/compare/trilean%401.6.3...trilean%401.7.0) (2026-09-29)

### Features

* **evaluator:** add a synchronous evaluator over synchronous resolvers ([7bce101](https://github.com/ExaDev/trilean/commit/7bce101f9b6ba3b0f5c9f91e048403583ff6c588))

## [1.6.3](https://github.com/ExaDev/trilean/compare/trilean%401.6.2...trilean%401.6.3) (2026-09-19)

### Build System

* **deps-dev:** bump tsdown from 0.22.14 to 0.23.0 ([b625cad](https://github.com/ExaDev/trilean/commit/b625cad7c7f59bd67076bef78976652035e830bf))


### Dependencies

- Updated trilean-regex to 1.0.3

## [1.6.2](https://github.com/ExaDev/trilean/compare/trilean%401.6.1...trilean%401.6.2) (2026-09-19)

### Bug Fixes

* declare sibling dependencies as plain versions so published manifests are installable ([087534c](https://github.com/ExaDev/trilean/commit/087534cdcb5f669facb158becbd8f25c6e50e97e))

## [1.6.1](https://github.com/ExaDev/trilean/compare/trilean%401.6.0...trilean%401.6.1) (2026-09-14)

### Bug Fixes

* escape arrow notation's > in doc comments so TSDoc doesn't read it as HTML ([1f93d10](https://github.com/ExaDev/trilean/commit/1f93d1057c16ad456d9d0244ba1b874c394b7189))

### Code Refactoring

* **evaluator:** split arithmetic, budget, collection, and factory logic into dedicated modules ([54d226f](https://github.com/ExaDev/trilean/commit/54d226f86a2a3bba4b5646f3b343ebb0674943a3))

### Tests

* **evaluator:** split evaluator.indeterminacy.test.ts under the 800-line cap ([eb45ab3](https://github.com/ExaDev/trilean/commit/eb45ab3efad75c5aa317e5a666b5b47b3006b8e9))
* **evaluator:** split evaluator.test.ts into topic-scoped files under the 800-line cap ([ca36bfb](https://github.com/ExaDev/trilean/commit/ca36bfbf82e7ebf52027562d6e6593300a6f8bb0))

### Miscellaneous Chores

* **deps:** pin @exadev/eslint-config to 2.12.1 across the workspace ([b8a548f](https://github.com/ExaDev/trilean/commit/b8a548f5c75eac7f26491c74d7add6fd72e5ce7f))


### Dependencies

- Updated trilean-regex to 1.0.2 (declared as `workspace:^`, resolved by pnpm at publish time)

## [1.6.0](https://github.com/ExaDev/trilean/compare/trilean%401.5.1...trilean%401.6.0) (2026-09-13)

### Features

* **evaluator:** cap total node visits and recursion depth per evaluation call ([ae05bf7](https://github.com/ExaDev/trilean/commit/ae05bf727fd948d4e760426d142ef942601b4882))

## [1.5.1](https://github.com/ExaDev/trilean/compare/trilean%401.5.0...trilean%401.5.1) (2026-09-06)

### Documentation

* scope each package README's release badge to its own tag ([c8cb954](https://github.com/ExaDev/trilean/commit/c8cb95459799faec8acd01e8ed0e171a37227ddc))


### Dependencies

- Updated trilean-regex to 1.0.1 (declared as `workspace:^`, resolved by pnpm at publish time)

## [1.5.0](https://github.com/ExaDev/trilean/compare/trilean%401.4.1...trilean%401.5.0) (2026-09-06)

### Features

* **trilean:** add portableMatches/portableNotMatches text comparison operators ([9749731](https://github.com/ExaDev/trilean/commit/97497319c44173c833a8c5b79b42d2e39a39f65e))

## [1.4.1](https://github.com/ExaDev/trilean/compare/trilean%401.4.0...trilean%401.4.1) (2026-09-03)

### Code Refactoring

* **workspace:** move the package into packages/trilean ([5465b9b](https://github.com/ExaDev/trilean/commit/5465b9bb0ca701e049b58b8dcf86fbf2a4d37e92))

### Build System

* **workspace:** make the repository a pnpm workspace with a turbo pipeline ([ecc1403](https://github.com/ExaDev/trilean/commit/ecc1403946a4f502e17aa5d4945effdda0b85c3d))

# [1.4.0](https://github.com/ExaDev/trilean/compare/v1.3.0...v1.4.0) (2026-09-03)


### Features

* **ci:** notify novus-power/hive on release via repository_dispatch ([b8932b2](https://github.com/ExaDev/trilean/commit/b8932b2b396f4dc3e0c5def2dc686ebfa86de44d))

# [1.3.0](https://github.com/ExaDev/trilean/compare/v1.2.0...v1.3.0) (2026-09-03)


### Bug Fixes

* escape the separator in a hierarchical glob's within-segment classes ([0f9481b](https://github.com/ExaDev/trilean/commit/0f9481b92a8924101bf765a3124066ed72de971a))


### Features

* add prefix, wildcard, and hierarchical glob pattern builders ([6e0fbd4](https://github.com/ExaDev/trilean/commit/6e0fbd4dda6bd0c2ff1340c8b78f9805d9ef132a))

# [1.2.0](https://github.com/ExaDev/trilean/compare/v1.1.0...v1.2.0) (2026-09-01)


### Features

* accept polar authoring for complex literals, normalised to rectangular on evaluation ([d36ff46](https://github.com/ExaDev/trilean/commit/d36ff46e631040f2eef45cee941ad1bd0fcca86c))
* add a boolean ComputedValue kind, evaluated by compare/memberOf ([0040043](https://github.com/ExaDev/trilean/commit/0040043ee10de6f158cf47a742f244678c1f9460))
* add a complex computed-value kind and complexLiteral node ([3d4d47f](https://github.com/ExaDev/trilean/commit/3d4d47faf28857e7858d684b5803c685d9154b8f))
* add booleanLiteral node to the expression tree schema ([107fe9d](https://github.com/ExaDev/trilean/commit/107fe9d25f51885031ede5697b59c7e76978d4c3))
* add polar builders and accessors for complex values ([18b7439](https://github.com/ExaDev/trilean/commit/18b74393e9e8b4319c0e97937ff2fcffce2e4412))

# [1.1.0](https://github.com/ExaDev/trilean/compare/v1.0.13...v1.1.0) (2026-09-01)


### Features

* add conditional hit policies, coalesce, and treeReference ([aba4ebe](https://github.com/ExaDev/trilean/commit/aba4ebe9729154fc25bf9456b181ad3733d6ce9e))

## [1.0.13](https://github.com/ExaDev/trilean/compare/v1.0.12...v1.0.13) (2026-09-01)

## [1.0.12](https://github.com/ExaDev/trilean/compare/v1.0.11...v1.0.12) (2026-09-01)

## [1.0.11](https://github.com/ExaDev/trilean/compare/v1.0.10...v1.0.11) (2026-09-01)

## [1.0.10](https://github.com/ExaDev/trilean/compare/v1.0.9...v1.0.10) (2026-09-01)

## [1.0.9](https://github.com/ExaDev/trilean/compare/v1.0.8...v1.0.9) (2026-09-01)

## [1.0.8](https://github.com/ExaDev/trilean/compare/v1.0.7...v1.0.8) (2026-09-01)

## [1.0.7](https://github.com/ExaDev/trilean/compare/v1.0.6...v1.0.7) (2026-09-01)

## [1.0.6](https://github.com/ExaDev/trilean/compare/v1.0.5...v1.0.6) (2026-09-01)

## [1.0.5](https://github.com/ExaDev/trilean/compare/v1.0.4...v1.0.5) (2026-09-01)

## [1.0.4](https://github.com/ExaDev/trilean/compare/v1.0.3...v1.0.4) (2026-09-01)

## [1.0.3](https://github.com/ExaDev/trilean/compare/v1.0.2...v1.0.3) (2026-09-01)

## [1.0.2](https://github.com/ExaDev/trilean/compare/v1.0.1...v1.0.2) (2026-09-01)

## [1.0.1](https://github.com/ExaDev/trilean/compare/v1.0.0...v1.0.1) (2026-09-01)

# 1.0.0 (2026-09-01)


### Bug Fixes

* **build:** build dist before the smoke tier runs against it ([a5c2f14](https://github.com/ExaDev/trilean/commit/a5c2f142d7befad25ec8f1b7309697e9d85d3f65))
* keep unparseable instants and prototype-chain names inside the Evaluation result ([395c651](https://github.com/ExaDev/trilean/commit/395c6517da7b7e350e419f577ee858c5bc5aa457))
* move coverage config from vitest.unit.config.ts to the root config ([c4924ce](https://github.com/ExaDev/trilean/commit/c4924ce376ce709c87bf9b4280fa7e39aad5b212))
* resolve the JSON Schema export under legacy node10 resolution ([6a9fa32](https://github.com/ExaDev/trilean/commit/6a9fa32a475e38379a3063d8a710af8801acfbb7))
* write the generated schema as exactly its RFC 8785 canonical form ([262fe5c](https://github.com/ExaDev/trilean/commit/262fe5c0ac6767ac3784f8b55564b7b3bfb23521))


### Features

* add derived connectives and aggregates as pure compositions ([4bc549e](https://github.com/ExaDev/trilean/commit/4bc549e7534b642a9cbf29a7b914112c4624a801))
* generate a combined JSON Schema document from the node schemas ([23d0df0](https://github.com/ExaDev/trilean/commit/23d0df0187111ae77ed1516d5103b9dea23a38d6))
* implement AND/OR/NOT evaluation with a real compare/reference leaf ([36f6fdd](https://github.com/ExaDev/trilean/commit/36f6fdd72c0cd4dba8c57f6a79d4db76f107229d))
* implement literal, reference-unit, arithmetic, and negate evaluation ([07af76a](https://github.com/ExaDev/trilean/commit/07af76a2876df26c88497a5ec237d3e9bb5c2bcb))
* implement lookup, conditional, fold, and delegate evaluation ([8229613](https://github.com/ExaDev/trilean/commit/8229613d9b5c2c49a8362c614d6b374f0977ca92))
* implement memberOf, exists, some, and every predicate evaluation ([55752e2](https://github.com/ExaDev/trilean/commit/55752e22a0208e9a8362e1bac63da27c327998ea))
* implement textCompare evaluation and add compare/textCompare coverage ([002169f](https://github.com/ExaDev/trilean/commit/002169f08020a37ec86b758de7b355a83cdc5df2))
* scaffold isomorphic package tooling and core evaluation schemas ([a9b915e](https://github.com/ExaDev/trilean/commit/a9b915efdd5ff229f4eb37bacc80a7b6a5377f09))
